-- Patch B9 / migration 11 — authentication + session functions (docs/SECURITY.md §3, docs/API_SPEC.md §3).
--
-- What this adds: password hashing helpers, per-account login throttling, participant and staff login, session
-- resolution and logout, and the one-time Super Admin provisioning function. It adds NO game rule, timer, coin,
-- realtime or team/admin management function, and it never starts a team's timer.
--
-- Hashing (docs/SECURITY.md SEC-02 permits "argon2id (or bcrypt cost >= 12)"): bcrypt, cost 12, through pgcrypto, so
-- the credential check, the throttle, the session row and the audit row are one atomic database call. bcrypt only
-- reads the first 72 bytes of a password, so longer passwords are refused when hashing and never match when verifying.
--
-- Privileges: every function below is created, then EXECUTE is revoked from PUBLIC (and anon/authenticated) and granted
-- to service_role only. Nothing relies on PostgreSQL's default function privileges (PUBLIC may execute by default).
-- The callable functions are SECURITY DEFINER with a pinned search_path.
--
-- Failure results are RETURNED as {"ok": false, "code": ...}, never raised, so the throttle counter and the audit row
-- written for a failed attempt are committed rather than rolled back with an exception.

-- ---------------------------------------------------------------------------------------------------------------
-- Password helpers
-- ---------------------------------------------------------------------------------------------------------------

-- A valid bcrypt hash of a throw-away value. Verifying against it when an account does not exist keeps the response
-- time of "unknown account" and "wrong password" alike (no user-enumeration timing signal).
create function app.auth_dummy_hash() returns text language sql immutable as
$$ select '$2a$12$u2KmYDrytDphw1TLDqmqXulLVLqrbmv3/JEfvyopauzarb6O4nlly'::text $$;

create function app.hash_password(p_password text) returns text
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  if p_password is null or p_password = '' then
    raise exception 'password must not be empty' using errcode = '22023';
  end if;
  if octet_length(p_password) > 72 then
    raise exception 'password is longer than 72 bytes (bcrypt limit)' using errcode = '22023';
  end if;
  return crypt(p_password, gen_salt('bf', 12));
end $$;

-- True only for a well-formed bcrypt hash that matches. Always performs one bcrypt comparison (against the dummy
-- hash when `p_hash` is null or malformed) so the cost does not depend on whether the account exists.
create function app.verify_password(p_password text, p_hash text) returns boolean
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_real boolean := p_hash is not null and p_hash ~ '^\$2[abxy]\$[0-9]{2}\$[./A-Za-z0-9]{53}$';
  v_hash text := case when v_real then p_hash else app.auth_dummy_hash() end;
  v_match boolean := crypt(coalesce(p_password, ''), v_hash) = v_hash;
begin
  return v_real and v_match and octet_length(coalesce(p_password, '')) <= 72;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Throttling (docs/API_SPEC.md §8): 8 failures per account per 10 minutes, then an exponential delay
-- (30 s, 60 s, 120 s, 240 s, capped at 300 s). Keyed per account ('team:<login_id>' / 'staff:<username>'), never by IP.
-- ---------------------------------------------------------------------------------------------------------------

-- Seconds the account must still wait (0 = the attempt may proceed).
create function app.auth_throttle_retry_after(p_key text) returns int
language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select greatest(0, ceil(extract(epoch from (t.locked_until - app.now()))))::int
                     from auth_throttle t where t.key = p_key), 0)
$$;

-- Records one failed attempt; returns the lock length in seconds applied by this failure (0 = none yet).
create function app.auth_throttle_fail(p_key text) returns int
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := app.now();
  v_attempts int;
  v_delay int := 0;
begin
  insert into auth_throttle as t (key, window_start, attempts)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set window_start = case when t.window_start < v_now - interval '10 minutes' then v_now else t.window_start end,
        attempts     = case when t.window_start < v_now - interval '10 minutes' then 1 else t.attempts + 1 end
  returning attempts into v_attempts;

  if v_attempts >= 8 then
    v_delay := least(300, 30 * (2 ^ least(v_attempts - 8, 10))::int);
    update auth_throttle set locked_until = v_now + make_interval(secs => v_delay) where key = p_key;
  end if;
  return v_delay;
end $$;

-- A successful login clears the account's counter and any lock.
create function app.auth_throttle_clear(p_key text) returns void
language sql
set search_path = pg_catalog, public, pg_temp
as $$ delete from auth_throttle where key = p_key $$;

-- ---------------------------------------------------------------------------------------------------------------
-- participant_login: team login ID + team password + member admission number
-- Same generic result for an unknown team, a wrong password, an unknown admission number and an admission number that
-- belongs to another team. Does NOT start the team timer. Permitted only while the competition is RUNNING or PAUSED.
-- ---------------------------------------------------------------------------------------------------------------
create function public.participant_login(
  p_login_id     text,
  p_password     text,
  p_admission_no text,
  p_token_hash   bytea,
  p_ip           inet default null,
  p_user_agent   text default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now      timestamptz := app.now();
  v_login    text := btrim(coalesce(p_login_id, ''));
  v_key      text := 'team:' || lower(btrim(coalesce(p_login_id, '')));
  v_retry    int;
  v_team     teams%rowtype;
  v_member   team_members%rowtype;
  v_pw_ok    boolean;
  v_reason   text;
  v_status   competition_status;
  v_session  uuid;
  v_expires  timestamptz;
  v_replaced int;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'participant_login: token hash must be exactly 32 bytes' using errcode = '22023';
  end if;

  v_retry := app.auth_throttle_retry_after(v_key);
  if v_retry > 0 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'retry_after_seconds', v_retry);
  end if;

  select * into v_team from teams where login_id = v_login::citext;
  v_pw_ok := app.verify_password(p_password, v_team.password_hash);   -- always one bcrypt comparison
  if v_team.id is not null then
    select * into v_member from team_members
     where team_id = v_team.id and admission_no = upper(btrim(coalesce(p_admission_no, '')));
  end if;

  if v_team.id is null or not v_pw_ok or v_member.id is null then
    v_reason := case when v_team.id is null then 'UNKNOWN_TEAM'
                     when not v_pw_ok then 'BAD_PASSWORD' else 'BAD_ADMISSION_NO' end;
    perform app.auth_throttle_fail(v_key);
    insert into audit_events (occurred_at, actor_kind, team_id, event_type, entity_type, payload, ip)
    values (v_now, 'SYSTEM', v_team.id, 'LOGIN_FAILED', 'TEAM_LOGIN',
            jsonb_build_object('subject', 'MEMBER', 'account_key', left(v_key, 80), 'reason', v_reason,
                               'user_agent', left(p_user_agent, 256)), p_ip);
    return jsonb_build_object('ok', false, 'code', 'INVALID_CREDENTIALS');
  end if;

  select status into v_status from competition where id = 1;
  if v_status is null or v_status not in ('RUNNING', 'PAUSED') then
    perform app.auth_throttle_clear(v_key);   -- the credentials were right; only the competition is not open
    insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, payload, ip)
    values (v_now, 'MEMBER', v_member.id, v_team.id, 'LOGIN_FAILED', 'TEAM_LOGIN',
            jsonb_build_object('subject', 'MEMBER', 'account_key', left(v_key, 80), 'reason', 'COMPETITION_NOT_OPEN',
                               'competition_status', v_status, 'user_agent', left(p_user_agent, 256)), p_ip);
    return jsonb_build_object('ok', false, 'code', 'COMPETITION_NOT_RUNNING', 'competition_status', v_status);
  end if;

  -- serialise concurrent logins of the same member, then supersede the previous live session (one live session per member)
  perform 1 from team_members where id = v_member.id for update;
  update sessions
     set revoked_at = v_now,
         revoke_reason = case when expires_at > v_now then 'SUPERSEDED' else 'EXPIRED' end
   where member_id = v_member.id and revoked_at is null;
  get diagnostics v_replaced = row_count;

  v_expires := v_now + interval '12 hours';
  insert into sessions (token_hash, kind, team_id, member_id, created_at, last_seen_at, expires_at, ip, user_agent)
  values (p_token_hash, 'MEMBER', v_team.id, v_member.id, v_now, v_now, v_expires, p_ip, left(p_user_agent, 256))
  returning id into v_session;

  perform app.auth_throttle_clear(v_key);
  insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, entity_id, payload, ip)
  values (v_now, 'MEMBER', v_member.id, v_team.id, 'MEMBER_LOGIN', 'SESSION', v_session::text,
          jsonb_build_object('superseded_sessions', v_replaced, 'user_agent', left(p_user_agent, 256)), p_ip);

  return jsonb_build_object(
    'ok', true, 'role', 'PARTICIPANT',
    'session', jsonb_build_object('id', v_session, 'expires_at', v_expires),
    'member',  jsonb_build_object('id', v_member.id, 'slot', v_member.slot),
    'team',    jsonb_build_object('id', v_team.id, 'code', v_team.team_code, 'name', v_team.name,
                                  'status', v_team.status::text));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- staff_login: username + password for ADMIN and SUPER_ADMIN. Inactive accounts are rejected with the same generic
-- result as a wrong password. Staff sessions are not unique per account (the schema only constrains members).
-- ---------------------------------------------------------------------------------------------------------------
create function public.staff_login(
  p_username   text,
  p_password   text,
  p_token_hash bytea,
  p_ip         inet default null,
  p_user_agent text default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now     timestamptz := app.now();
  v_name    text := btrim(coalesce(p_username, ''));
  v_key     text := 'staff:' || lower(btrim(coalesce(p_username, '')));
  v_retry   int;
  v_staff   staff_users%rowtype;
  v_pw_ok   boolean;
  v_reason  text;
  v_session uuid;
  v_expires timestamptz;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'staff_login: token hash must be exactly 32 bytes' using errcode = '22023';
  end if;

  v_retry := app.auth_throttle_retry_after(v_key);
  if v_retry > 0 then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED', 'retry_after_seconds', v_retry);
  end if;

  select * into v_staff from staff_users where username = v_name::citext;
  v_pw_ok := app.verify_password(p_password, v_staff.password_hash);

  if v_staff.id is null or not v_pw_ok or not v_staff.is_active then
    v_reason := case when v_staff.id is null then 'UNKNOWN_ACCOUNT'
                     when not v_pw_ok then 'BAD_PASSWORD' else 'ACCOUNT_INACTIVE' end;
    perform app.auth_throttle_fail(v_key);
    insert into audit_events (occurred_at, actor_kind, event_type, entity_type, payload, ip)
    values (v_now, 'SYSTEM', 'LOGIN_FAILED', 'STAFF_LOGIN',
            jsonb_build_object('subject', 'STAFF', 'account_key', left(v_key, 80), 'reason', v_reason,
                               'user_agent', left(p_user_agent, 256)), p_ip);
    return jsonb_build_object('ok', false, 'code', 'INVALID_CREDENTIALS');
  end if;

  v_expires := v_now + interval '12 hours';
  insert into sessions (token_hash, kind, staff_id, created_at, last_seen_at, expires_at, ip, user_agent)
  values (p_token_hash, 'STAFF', v_staff.id, v_now, v_now, v_expires, p_ip, left(p_user_agent, 256))
  returning id into v_session;
  update staff_users set last_login_at = v_now where id = v_staff.id;

  perform app.auth_throttle_clear(v_key);
  insert into audit_events (occurred_at, actor_kind, staff_id, event_type, entity_type, entity_id, payload, ip)
  values (v_now, 'STAFF', v_staff.id, 'STAFF_LOGIN', 'SESSION', v_session::text,
          jsonb_build_object('role', v_staff.role::text, 'user_agent', left(p_user_agent, 256)), p_ip);

  return jsonb_build_object(
    'ok', true, 'role', v_staff.role::text,
    'session', jsonb_build_object('id', v_session, 'expires_at', v_expires),
    'staff',   jsonb_build_object('id', v_staff.id, 'username', v_staff.username::text,
                                  'display_name', v_staff.display_name));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- resolve_session: token hash -> principal. Rejects unknown, revoked and expired sessions (an expired one is revoked
-- as EXPIRED) and sessions of disabled staff (revoked as ADMIN_DISABLED). A live session gets last_seen_at = now.
-- ---------------------------------------------------------------------------------------------------------------
create function public.resolve_session(p_token_hash bytea) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now     timestamptz := app.now();
  v_s       sessions%rowtype;
  v_staff   staff_users%rowtype;
  v_member  team_members%rowtype;
  v_team    teams%rowtype;
  v_session jsonb;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;

  select * into v_s from sessions where token_hash = p_token_hash for update;
  if v_s.id is null or v_s.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;
  if v_s.expires_at <= v_now then
    update sessions set revoked_at = v_now, revoke_reason = 'EXPIRED' where id = v_s.id;
    return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
  end if;

  if v_s.kind = 'STAFF' then
    select * into v_staff from staff_users where id = v_s.staff_id;
    if not v_staff.is_active then
      update sessions set revoked_at = v_now, revoke_reason = 'ADMIN_DISABLED' where id = v_s.id;
      return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
    end if;
  end if;

  update sessions set last_seen_at = v_now where id = v_s.id;
  v_session := jsonb_build_object('id', v_s.id, 'expires_at', v_s.expires_at);

  if v_s.kind = 'STAFF' then
    return jsonb_build_object('ok', true, 'role', v_staff.role::text, 'session', v_session,
      'staff', jsonb_build_object('id', v_staff.id, 'username', v_staff.username::text,
                                  'display_name', v_staff.display_name));
  end if;

  select * into v_member from team_members where id = v_s.member_id;
  select * into v_team from teams where id = v_s.team_id;
  return jsonb_build_object('ok', true, 'role', 'PARTICIPANT', 'session', v_session,
    'member', jsonb_build_object('id', v_member.id, 'slot', v_member.slot),
    'team',   jsonb_build_object('id', v_team.id, 'code', v_team.team_code, 'name', v_team.name,
                                 'status', v_team.status::text));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- revoke_session: logout. Idempotent: an unknown, already revoked or expired token is not an error and reveals nothing.
-- ---------------------------------------------------------------------------------------------------------------
create function public.revoke_session(p_token_hash bytea) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now timestamptz := app.now();
  v_s   sessions%rowtype;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    return jsonb_build_object('ok', true, 'revoked', false);
  end if;

  select * into v_s from sessions where token_hash = p_token_hash for update;
  if v_s.id is null or v_s.revoked_at is not null then
    return jsonb_build_object('ok', true, 'revoked', false);
  end if;
  if v_s.expires_at <= v_now then
    update sessions set revoked_at = v_now, revoke_reason = 'EXPIRED' where id = v_s.id;
    return jsonb_build_object('ok', true, 'revoked', false);
  end if;

  update sessions set revoked_at = v_now, revoke_reason = 'LOGOUT' where id = v_s.id;
  if v_s.kind = 'STAFF' then
    insert into audit_events (occurred_at, actor_kind, staff_id, event_type, entity_type, entity_id)
    values (v_now, 'STAFF', v_s.staff_id, 'STAFF_LOGOUT', 'SESSION', v_s.id::text);
  else
    insert into audit_events (occurred_at, actor_kind, member_id, team_id, event_type, entity_type, entity_id)
    values (v_now, 'MEMBER', v_s.member_id, v_s.team_id, 'MEMBER_LOGOUT', 'SESSION', v_s.id::text);
  end if;
  return jsonb_build_object('ok', true, 'revoked', true);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- provision_superadmin: used only by `npm run provision:superadmin`. Hashes the password in the database, so the
-- plaintext never reaches a file or a log. Exactly one Super Admin can exist (unique index staff_one_super_admin).
-- ---------------------------------------------------------------------------------------------------------------
create function app.provision_superadmin(p_username text, p_display_name text, p_password text) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_username is null or p_username !~ '^[A-Za-z0-9._-]{3,64}$' then
    raise exception 'INVALID_USERNAME' using errcode = '22023';
  end if;
  if p_display_name is null or btrim(p_display_name) = '' or length(p_display_name) > 100 then
    raise exception 'INVALID_DISPLAY_NAME' using errcode = '22023';
  end if;
  if p_password is null or length(p_password) < 10 or octet_length(p_password) > 72 then
    raise exception 'INVALID_PASSWORD' using errcode = '22023';
  end if;
  if exists (select 1 from staff_users where role = 'SUPER_ADMIN') then
    raise exception 'SUPER_ADMIN_EXISTS' using errcode = 'P0001';
  end if;

  begin
    insert into staff_users (username, display_name, password_hash, role)
    values (p_username, btrim(p_display_name), app.hash_password(p_password), 'SUPER_ADMIN')
    returning id into v_id;
  exception when unique_violation then
    raise exception 'SUPER_ADMIN_EXISTS' using errcode = 'P0001';   -- lost a race, or the username is taken
  end;

  insert into audit_events (actor_kind, event_type, entity_type, entity_id, payload)
  values ('SYSTEM', 'SUPER_ADMIN_PROVISIONED', 'STAFF', v_id::text, jsonb_build_object('username', p_username));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges. Explicit for every function above: no PUBLIC, no anon, no authenticated; service_role only.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function app.auth_dummy_hash()                                   from public, anon, authenticated;
revoke all on function app.hash_password(text)                                 from public, anon, authenticated;
revoke all on function app.verify_password(text, text)                         from public, anon, authenticated;
revoke all on function app.auth_throttle_retry_after(text)                     from public, anon, authenticated;
revoke all on function app.auth_throttle_fail(text)                            from public, anon, authenticated;
revoke all on function app.auth_throttle_clear(text)                           from public, anon, authenticated;
revoke all on function app.provision_superadmin(text, text, text)              from public, anon, authenticated;
revoke all on function public.participant_login(text, text, text, bytea, inet, text) from public, anon, authenticated;
revoke all on function public.staff_login(text, text, bytea, inet, text)       from public, anon, authenticated;
revoke all on function public.resolve_session(bytea)                           from public, anon, authenticated;
revoke all on function public.revoke_session(bytea)                            from public, anon, authenticated;

grant execute on function app.auth_dummy_hash()                                   to service_role;
grant execute on function app.hash_password(text)                                 to service_role;
grant execute on function app.verify_password(text, text)                         to service_role;
grant execute on function app.auth_throttle_retry_after(text)                     to service_role;
grant execute on function app.auth_throttle_fail(text)                            to service_role;
grant execute on function app.auth_throttle_clear(text)                           to service_role;
grant execute on function app.provision_superadmin(text, text, text)              to service_role;
grant execute on function public.participant_login(text, text, text, bytea, inet, text) to service_role;
grant execute on function public.staff_login(text, text, bytea, inet, text)       to service_role;
grant execute on function public.resolve_session(bytea)                           to service_role;
grant execute on function public.revoke_session(bytea)                            to service_role;
