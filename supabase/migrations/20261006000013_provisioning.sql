-- Patch B12 / migration 13 — provisioning: Super Admin creates Admins, an Admin creates Teams (docs/API_SPEC.md §5–§6).
--
-- Adds FOUR functions and nothing else (no table, column, index, policy or grant on a table changes):
--   create_admin(staff_id, username, password, idempotency_key)                            SUPER_ADMIN only
--   create_team(staff_id, team_code, name, login_id, password, admission_nos, idem_key)    ADMIN only; the team belongs to the caller
--   list_admin_teams(staff_id)                                                             ADMIN only; only the caller's own teams
--   get_leaderboard(staff_id)                                                              ADMIN or SUPER_ADMIN; team code + score only
--
-- Conventions are exactly those of migrations 11 and 12:
--   * SECURITY DEFINER with a pinned search_path; EXECUTE revoked from PUBLIC/anon/authenticated and granted to
--     service_role only. The principal id is resolved by the server from the session cookie (resolve_session) and passed in;
--     every function re-checks it against staff_users, so authorisation is enforced twice. NO function takes an admin id
--     from the client: the owner of a team is always `p_staff_id`, i.e. the authenticated caller.
--   * Rejections are RAISED as P0001 with a stable upper-case code (and a flat JSON detail), so the whole transaction
--     rolls back; nothing is left half-created. A request is stored in request_log only when it succeeded.
--   * Idempotency: (p_staff_id, p_idem_key) in request_log. A repeat with the same key returns the stored response and
--     writes nothing. Two simultaneous calls with one key serialise on the caller's staff_users row, so the second one
--     finds the first one's stored response. The key is bound to the operation and the normalised, non-secret inputs
--     (a password is never part of the fingerprint, so no password-derived value is ever stored in request_log).
--   * The unique constraints (staff_users.username, teams.team_code, teams.login_id, team_members.admission_no) are the
--     final protection against a race: a unique_violation is translated to a stable code, never forwarded.
--   * Passwords are hashed in the database by app.hash_password (bcrypt, cost 12). The plaintext is never stored, logged,
--     audited, returned or placed in the idempotency fingerprint. No function returns a hash.
--   * Lock order: competition (FOR SHARE) → caller's staff row (FOR UPDATE) → the rows being inserted. set_competition_status
--     takes competition FOR UPDATE and then teams, so no cycle is possible and a team can never appear half-way through
--     an `open`/`end` that is counting or ending teams.
--   * Every timestamp comes from app.now().
--
-- Out of scope here (later milestones): disabling/reassigning admins, resetting a team password, presence, scoring.

-- ---------------------------------------------------------------------------------------------------------------
-- create_admin
-- ---------------------------------------------------------------------------------------------------------------
create function public.create_admin(p_staff_id uuid, p_username text, p_password text, p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now    timestamptz := app.now();
  v_staff  staff_users%rowtype;
  v_name   text := btrim(coalesce(p_username, ''));
  v_fp     text := 'username:' || lower(btrim(coalesce(p_username, '')));
  v_fields text[] := '{}';
  v_replay jsonb;
  v_id     uuid;
  v_resp   jsonb;
begin
  -- the caller must be an active SUPER_ADMIN; the row lock serialises this caller's requests (idempotency, see header)
  select * into v_staff from staff_users where id = p_staff_id for update;
  if not found or v_staff.role <> 'SUPER_ADMIN' or not v_staff.is_active then
    perform app.fail('FORBIDDEN');
  end if;

  v_replay := app.idem_lookup(p_staff_id, p_idem_key, 'create_admin', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  if v_name !~ '^[A-Za-z0-9._-]{3,64}$' then
    v_fields := array_append(v_fields, 'username'::text);
  end if;
  if p_password is null or char_length(p_password) < 10 or octet_length(p_password) > 72 then
    v_fields := array_append(v_fields, 'password'::text);
  end if;
  if cardinality(v_fields) > 0 then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;

  begin
    insert into staff_users (username, display_name, password_hash, role, is_active, created_by)
    values (v_name, v_name, app.hash_password(p_password), 'ADMIN', true, p_staff_id)
    returning id into v_id;
  exception when unique_violation then
    perform app.fail('USERNAME_TAKEN');
  end;

  insert into audit_events (occurred_at, actor_kind, staff_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'STAFF', p_staff_id, 'ADMIN_CREATED', 'STAFF', v_id::text,
          jsonb_build_object('username', v_name, 'role', 'ADMIN'), p_idem_key);

  v_resp := jsonb_build_object('replayed', false,
    'admin', jsonb_build_object('id', v_id, 'username', v_name, 'role', 'ADMIN', 'is_active', true,
                                'created_at', app.epoch_ms(v_now)));
  perform app.idem_store(p_staff_id, p_idem_key, 'create_admin', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- create_team: one atomic transaction creating the team (owned by the caller), its four members (M1–M4), the initial
-- coin balance, the INITIAL_GRANT ledger row and the audit event. The password is hashed here; the initial balance is
-- competition.initial_coins (500), never a parameter.
-- ---------------------------------------------------------------------------------------------------------------
create function public.create_team(
  p_staff_id      uuid,
  p_team_code     text,
  p_name          text,
  p_login_id      text,
  p_password      text,
  p_admission_nos text[],
  p_idem_key      uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now     timestamptz := app.now();
  v_staff   staff_users%rowtype;
  v_code    text := upper(btrim(coalesce(p_team_code, '')));
  v_name    text := btrim(coalesce(p_name, ''));
  v_login   text := btrim(coalesce(p_login_id, ''));
  v_adm     text[] := '{}';
  v_fields  text[] := '{}';
  v_fp      text;
  v_replay  jsonb;
  v_initial int;
  v_team_id uuid;
  v_cons    text;
  v_resp    jsonb;
  i         int;
  j         int;
begin
  -- Lock order (header): competition share → caller's staff row. Only an active ADMIN may create a team.
  perform 1 from competition where id = 1 for share;
  select * into v_staff from staff_users where id = p_staff_id for update;
  if not found or v_staff.role <> 'ADMIN' or not v_staff.is_active then
    perform app.fail('FORBIDDEN');
  end if;

  -- normalised, non-secret inputs only (never the password)
  if p_admission_nos is not null and cardinality(p_admission_nos) = 4 then
    for i in 1..4 loop
      v_adm := v_adm || upper(btrim(coalesce(p_admission_nos[i], '')));
    end loop;
  end if;
  v_fp := jsonb_build_array(v_code, v_name, lower(v_login), to_jsonb(v_adm))::text;

  v_replay := app.idem_lookup(p_staff_id, p_idem_key, 'create_team', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  -- validation (field names are the API's names; the browser also validates, this is the authority)
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,15}$' then v_fields := array_append(v_fields, 'teamCode'::text); end if;
  if v_name = '' or char_length(v_name) > 100 or v_name ~ '[[:cntrl:]]' then v_fields := array_append(v_fields, 'name'::text); end if;
  if v_login !~ '^[A-Za-z0-9._-]{3,64}$' then v_fields := array_append(v_fields, 'loginId'::text); end if;
  if p_password is null or char_length(p_password) < 8 or octet_length(p_password) > 72
     or lower(p_password) in (lower(v_code), lower(v_login)) then
    v_fields := array_append(v_fields, 'password'::text);
  end if;
  if cardinality(v_adm) <> 4 then
    v_fields := array_append(v_fields, 'admissionNos'::text);
  else
    for i in 1..4 loop
      if v_adm[i] !~ '^[A-Z0-9][A-Z0-9/._-]{0,31}$' then
        v_fields := array_append(v_fields, 'admissionNos.' || i);
      else
        for j in 1..(i - 1) loop
          if v_adm[j] = v_adm[i] then
            v_fields := array_append(v_fields, 'admissionNos.' || i);
            exit;
          end if;
        end loop;
      end if;
    end loop;
  end if;
  if cardinality(v_fields) > 0 then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;

  select initial_coins into v_initial from competition where id = 1;

  begin
    insert into teams (team_code, name, login_id, password_hash, admin_id, coins, created_by)
    values (v_code, v_name, v_login, app.hash_password(p_password), p_staff_id, v_initial, p_staff_id)
    returning id into v_team_id;
  exception when unique_violation then
    get stacked diagnostics v_cons = constraint_name;
    perform app.fail(case v_cons when 'teams_team_code_key' then 'TEAM_CODE_TAKEN'
                                 when 'teams_login_id_key'  then 'LOGIN_ID_TAKEN'
                                 else 'CONFLICT' end);
  end;

  for i in 1..4 loop
    begin
      insert into team_members (team_id, slot, admission_no) values (v_team_id, i, v_adm[i]);
    exception when unique_violation then
      perform app.fail('ADMISSION_NO_TAKEN', jsonb_build_object('slot', i));
    end;
  end loop;

  if v_initial > 0 then
    insert into coin_transactions (team_id, type, amount, balance_after, created_at)
    values (v_team_id, 'INITIAL_GRANT', v_initial, v_initial, v_now);
  end if;

  insert into audit_events (occurred_at, actor_kind, staff_id, team_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'STAFF', p_staff_id, v_team_id, 'TEAM_CREATED', 'TEAM', v_team_id::text,
          jsonb_build_object('team_code', v_code, 'name', v_name, 'login_id', v_login, 'admin_id', p_staff_id,
                             'member_count', 4, 'initial_coins', v_initial), p_idem_key);

  v_resp := jsonb_build_object('replayed', false,
    'team', jsonb_build_object('id', v_team_id, 'team_code', v_code, 'name', v_name, 'login_id', v_login,
                               'status', 'NOT_STARTED', 'coins', v_initial, 'member_count', 4,
                               'created_at', app.epoch_ms(v_now)));
  perform app.idem_store(p_staff_id, p_idem_key, 'create_team', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- list_admin_teams: "My Teams". Only teams with teams.admin_id = the caller. Never returns a password hash, an
-- admission number or a session. (Presence, theme progress and the review matrix arrive in later milestones.)
-- ---------------------------------------------------------------------------------------------------------------
create function public.list_admin_teams(p_staff_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  if not exists (select 1 from staff_users where id = p_staff_id and role = 'ADMIN' and is_active) then
    perform app.fail('FORBIDDEN');
  end if;
  return jsonb_build_object('teams', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'team_code', t.team_code, 'name', t.name, 'login_id', t.login_id::text,
             'status', t.status::text,
             'member_count', (select count(*) from team_members m where m.team_id = t.id),
             'created_at', app.epoch_ms(t.created_at))
           order by t.created_at, t.team_code)
      from teams t where t.admin_id = p_staff_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- get_leaderboard: ranks 1..N over ALL teams, each with its team code and score (docs/API_SPEC.md §4 "identical for
-- everyone"). Scoring is not built yet (compute_team_score does not exist), so the score is the stored one:
-- the UFM override if any, else the cached final score, else 0. Order: score desc, fewer minutes taken, team code
-- (DEC-11's tie-break). Nothing else about a team is returned.
-- ---------------------------------------------------------------------------------------------------------------
create function public.get_leaderboard(p_staff_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  if not exists (select 1 from staff_users where id = p_staff_id and role in ('ADMIN', 'SUPER_ADMIN') and is_active) then
    perform app.fail('FORBIDDEN');
  end if;
  return jsonb_build_object('rows', coalesce((
    select jsonb_agg(jsonb_build_object('rank', r.rn, 'team_id', r.team_code, 'score', r.score) order by r.rn)
      from (select t.team_code,
                   coalesce(t.score_override, t.final_score, 0) as score,
                   row_number() over (order by coalesce(t.score_override, t.final_score, 0) desc,
                                               t.final_minutes_taken nulls last, t.team_code) as rn
              from teams t) r
     where r.rn <= 500), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: no PUBLIC, no anon, no authenticated; service_role only (as in migrations 11 and 12).
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public.create_admin(uuid, text, text, uuid)                              from public, anon, authenticated;
revoke all on function public.create_team(uuid, text, text, text, text, text[], uuid)           from public, anon, authenticated;
revoke all on function public.list_admin_teams(uuid)                                            from public, anon, authenticated;
revoke all on function public.get_leaderboard(uuid)                                             from public, anon, authenticated;

grant execute on function public.create_admin(uuid, text, text, uuid)                           to service_role;
grant execute on function public.create_team(uuid, text, text, text, text, text[], uuid)        to service_role;
grant execute on function public.list_admin_teams(uuid)                                         to service_role;
grant execute on function public.get_leaderboard(uuid)                                          to service_role;
