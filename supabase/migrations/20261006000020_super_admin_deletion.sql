-- Migration 20 (B18) — Super Admin: permanently and completely delete Admins and Teams.
--
-- WHAT "DELETE" MEANS HERE (Option A: complete deletion)
--   Deleting a team removes the team, its members, their sessions and login throttles, every gameplay and operational row
--   it owns (themes, questions, drafts, hint purchases, UFM challenges, submissions), its purchase history
--   (team_time_purchases), its WHOLE coin ledger (coin_transactions), and the idempotency records (request_log) that
--   belong to it. Deleting an admin deletes the admin, its sessions / challenges / throttle key / idempotency records, and
--   every team assigned to it with everything above. Nothing is archived, nothing is soft-deleted, nothing is "retired".
--
-- WHAT STAYS, AND WHY (stated plainly because it is not "total erasure")
--   * audit_events: append-only and untouched (audit_no_update / audit_no_truncate stay enabled, no policy or grant
--     changes). Rows that name a deleted team or admin stay: their ids in team_id / staff_id / member_id / entity_id,
--     and, in the payloads of TEAM_CREATED / TEAM_DELETED / ADMIN_CREATED / ADMIN_DELETED and similar, the team code,
--     team name, login ID and admin username. This migration adds the deletion events themselves (TEAM_DELETED,
--     ADMIN_DELETED, TEAMS_DELETED, ADMINS_DELETED). No password hash, session token or admission number is in any of
--     them. Removing them would mean editing an immutable audit trail; that is a policy decision, not a side effect.
--   * the Super Admin's own idempotency record for the deletion call (request_log, scope = the Super Admin; it holds the
--     deleted ids so that a retry of the SAME request replays instead of failing).
--   * competition rules, themes, hints, questions, keys, buy-time options, every other team/admin and all of their data.
--
-- THE ONE PROTECTION THIS MIGRATION RELAXES: coin_transactions
--   coin_transactions has been append-only since migration 6 (UPDATE, DELETE, TRUNCATE all raise) and
--   service_role holds only SELECT and INSERT on it. The spec now requires a deleted team's ledger to be deleted with it,
--   so the DELETE branch of app.ledger_immutable() gains exactly one exception: a row may be deleted when its team_id is
--   in the transaction-local setting `app.retiring_team_ids`, which only app.erase_teams sets (and clears again right
--   after its one DELETE statement). Everything else is unchanged and re-tested: UPDATE and TRUNCATE are always refused,
--   DELETE without the setting is refused, DELETE of any other team's row is refused even with the setting, the
--   privileges are untouched (service_role still cannot delete, so the setting alone gives it nothing; only the function
--   owner can). The foreign keys stay ON DELETE RESTRICT, so deleting a team row directly is still impossible while it
--   has ledger rows. As before, the database owner can disable triggers.
--   team_time_purchases is append-only by privilege only (SELECT, INSERT for service_role; no trigger): the owner-run
--   function deletes a deleted team's rows and nothing else changed.
--
-- request_log (verified against migrations 7, 12, 13, 14, 17, 18): no foreign keys; primary key (team_id, idem_key) where
--   the column `team_id` is a SCOPE: the team id for participant calls, the caller's staff id for staff calls.
--   Rows that belong to a deleted team are therefore not only the ones in its scope; see app.erase_teams. Rows are
--   written and read only inside a transaction that already holds the owning team/staff row lock, so removing them in the
--   deleting transaction cannot interleave with an in-flight request (documented in docs/ADMIN_TEAM_DELETION.md).
--
-- FUNCTIONS (SECURITY DEFINER, pinned search_path, EXECUTE granted to service_role only; the principal id is the one the
-- server resolved from the session cookie, and every function re-checks that it is an active SUPER_ADMIN)
--   list_deletable_admins(staff_id)                        every ADMIN (never the SUPER_ADMIN), with team counts
--   list_deletable_teams(staff_id)                         every team of every admin
--   delete_admins(staff_id, admin_ids[], idem_key)         one transaction: the admins, their teams and all team data
--   delete_teams(staff_id, team_ids[], idem_key)           one transaction: the teams and all team data
--   app.erase_teams(...)                                   the single place where team data is removed (internal)
--
-- DELETE_BLOCKED diagnostics: when a foreign key the cleanup does not know about stops a deletion, delete_admins/delete_teams
-- roll back whole and raise DELETE_BLOCKED with the DETAIL {"constraint": <fk name>, "table": <referencing table>} (schema
-- identifiers only: no id, key, row value or credential). The API logs it on the server and never forwards it to the browser.
--
-- Also: resolve_session is re-issued with one extra rule: a session whose staff, member or team row no longer exists is
-- UNAUTHENTICATED (foreign keys make that state impossible today; the rule keeps it impossible to authorise).
--
-- LOCK ORDER (the concurrency argument): competition (FOR SHARE) → the caller's staff row (FOR NO KEY UPDATE; serialises
-- this caller's requests, so a double click or a second tab queues here) → the teams being removed (FOR UPDATE, id order;
-- gameplay locks team → staff, so the order agrees) → the admins being removed (FOR UPDATE, id order; create_team locks
-- the admin's row, so no team can appear for a vanishing admin) → teams that appeared in between. A deadlock victim, if
-- PostgreSQL ever picks one, rolls back as a whole and may simply be retried.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The ledger: deletable only as part of deleting its team
-- ---------------------------------------------------------------------------------------------------------------
-- Same name, same triggers (coin_tx_no_update on UPDATE/DELETE, coin_tx_no_truncate on TRUNCATE), same message.
create or replace function app.ledger_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, app, pg_temp
as $$
declare
  v_ids text := nullif(current_setting('app.retiring_team_ids', true), '');
begin
  if tg_op = 'DELETE' and v_ids is not null and old.team_id::text = any (string_to_array(v_ids, ',')) then
    return old;     -- only while app.erase_teams is deleting THIS team (see the header)
  end if;
  raise exception 'coin_transactions is append-only';
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. resolve_session: a session whose principal row is gone is simply UNAUTHENTICATED (otherwise identical to migration 11)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.resolve_session(p_token_hash bytea) returns jsonb
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
    if not found then   -- B18: the account was deleted
      return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
    end if;
    if not v_staff.is_active then
      update sessions set revoked_at = v_now, revoke_reason = 'ADMIN_DISABLED' where id = v_s.id;
      return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
    end if;
  else
    select * into v_member from team_members where id = v_s.member_id;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'UNAUTHENTICATED');
    end if;
    select * into v_team from teams where id = v_s.team_id;
    if not found then
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

  return jsonb_build_object('ok', true, 'role', 'PARTICIPANT', 'session', v_session,
    'member', jsonb_build_object('id', v_member.id, 'slot', v_member.slot),
    'team',   jsonb_build_object('id', v_team.id, 'code', v_team.team_code, 'name', v_team.name,
                                 'status', v_team.status::text));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------------------------------------------
-- A selection: 1..100 distinct, non-null ids. Returns them sorted. Anything else is VALIDATION_FAILED (field named).
create function app.deletion_selection(p_ids uuid[], p_field text) returns uuid[]
language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_sorted uuid[];
begin
  if p_ids is null or cardinality(p_ids) < 1 or cardinality(p_ids) > 100
     or array_position(p_ids, null) is not null then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array(p_field)));
  end if;
  select array_agg(x order by x) into v_sorted from (select distinct x from unnest(p_ids) x) d;
  if cardinality(v_sorted) <> cardinality(p_ids) then   -- duplicates
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', jsonb_build_array(p_field)));
  end if;
  return v_sorted;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. app.erase_teams: removes EVERYTHING the given teams own, in foreign-key order. The CALLER has already verified the
-- ids, authorised the request and locked the team rows (header). Every statement is limited to p_team_ids (or to rows
-- proven to belong to them). Returns the number of rows removed per kind (for the audit trail; never sent to a browser).
--
-- request_log, verified (see the header and docs/ADMIN_TEAM_DELETION.md §6): for each deleted team the rows to remove are
--   (a) its own scope:                      team_id = <team>                            every participant call (unlock_theme,
--       start_question, submit_answer, buy_hint, buy_time, final_submit, start_team_competition); the key never leaves it
--   (b) the creating admin's reply:         operation = 'create_team' and response.team.id = <team>
--       (scope = the admin, who may SURVIVE a direct team deletion; the reply holds the team's code, name and login ID and
--       its fingerprint the four admission numbers; replaying it would "create" a team that no longer exists)
--   (c) the owner's penalty reply:          operation = 'penalize_team' and fingerprint = 'team:<team>'
--   (d) reviewers' replies for its submissions: operation in (approve_submission, disapprove_submission) and
--       fingerprint begins 'submission:<id>' for one of the team's submission ids (scope = the owner admin OR the Super Admin)
-- Everything else in request_log is left alone. The Super Admin's own delete_teams / delete_admins records are never matched.
-- ---------------------------------------------------------------------------------------------------------------
create function app.erase_teams(p_team_ids uuid[], p_actor uuid, p_now timestamptz, p_request uuid) returns jsonb
language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  n_members int; n_sessions int; n_challenges int; n_hints int; n_ttp int; n_drafts int; n_questions int;
  n_themes int; n_subs int; n_throttle int; n_teams int; n_ledger int;
  n_log_scope int; n_log_create int; n_log_penalty int; n_log_review int;
  v_team_txt text[]; v_penalty_fp text[]; v_sub_fp text[];
begin
  if p_team_ids is null or cardinality(p_team_ids) = 0 then
    return jsonb_build_object('teams', 0);
  end if;

  -- the audit trail first (it needs the data about to be removed). Identifiers only; nothing secret.
  insert into audit_events (occurred_at, actor_kind, staff_id, team_id, event_type, entity_type, entity_id, payload, request_id)
  select p_now, 'STAFF', p_actor, t.id, 'TEAM_DELETED', 'TEAM', t.id::text,
         jsonb_build_object('team_code', t.team_code, 'name', t.name, 'login_id', t.login_id::text,
                            'admin_id', t.admin_id, 'status', t.status::text),
         p_request
    from teams t where t.id = any(p_team_ids) order by t.id;

  -- idempotency records (must read the submissions BEFORE they are deleted)
  select array_agg(x::text), array_agg('team:' || x::text) into v_team_txt, v_penalty_fp from unnest(p_team_ids) x;
  select coalesce(array_agg('submission:' || s.id::text), '{}') into v_sub_fp from submissions s where s.team_id = any(p_team_ids);
  delete from request_log where team_id = any(p_team_ids);
  get diagnostics n_log_scope = row_count;
  delete from request_log where operation = 'create_team' and response #>> '{team,id}' = any(v_team_txt);
  get diagnostics n_log_create = row_count;
  delete from request_log where operation = 'penalize_team' and request_fingerprint = any(v_penalty_fp);
  get diagnostics n_log_penalty = row_count;
  delete from request_log
   where operation in ('approve_submission', 'disapprove_submission')
     and split_part(request_fingerprint, '|', 1) = any(v_sub_fp);
  get diagnostics n_log_review = row_count;

  -- login keys of the removed teams (so a reused Login ID starts clean)
  delete from auth_throttle where key in (select 'team:' || lower(login_id::text) from teams where id = any(p_team_ids));
  get diagnostics n_throttle = row_count;

  -- the coin ledger: the one DELETE the append-only trigger allows, for exactly these teams, in exactly this statement
  perform set_config('app.retiring_team_ids', array_to_string(p_team_ids, ','), true);
  delete from coin_transactions where team_id = any(p_team_ids);
  get diagnostics n_ledger = row_count;
  perform set_config('app.retiring_team_ids', '', true);

  -- children first
  delete from sessions             where team_id = any(p_team_ids);   get diagnostics n_sessions = row_count;
  delete from ufm_challenges       where team_id = any(p_team_ids);   get diagnostics n_challenges = row_count;
  delete from hint_purchases       where team_id = any(p_team_ids);   get diagnostics n_hints = row_count;
  delete from team_time_purchases  where team_id = any(p_team_ids);   get diagnostics n_ttp = row_count;
  delete from answer_drafts        where team_id = any(p_team_ids);   get diagnostics n_drafts = row_count;
  delete from team_questions       where team_id = any(p_team_ids);   get diagnostics n_questions = row_count;
  delete from team_themes          where team_id = any(p_team_ids);   get diagnostics n_themes = row_count;
  delete from submissions          where team_id = any(p_team_ids);   get diagnostics n_subs = row_count;
  -- teams.final_submitted_by -> team_members and team_members.team_id -> teams reference each other: break the loop
  update teams set final_submitted_by = null where id = any(p_team_ids) and final_submitted_by is not null;
  delete from team_members         where team_id = any(p_team_ids);   get diagnostics n_members = row_count;
  delete from teams                where id = any(p_team_ids);        get diagnostics n_teams = row_count;

  if n_teams <> cardinality(p_team_ids) then
    raise exception 'erase_teams: expected % teams, removed %', cardinality(p_team_ids), n_teams;
  end if;
  return jsonb_build_object('teams', n_teams, 'members', n_members, 'sessions', n_sessions,
    'ufm_challenges', n_challenges, 'hint_purchases', n_hints, 'time_purchases', n_ttp, 'drafts', n_drafts,
    'team_questions', n_questions, 'team_themes', n_themes, 'submissions', n_subs, 'coin_transactions', n_ledger,
    'request_log', jsonb_build_object('team_scope', n_log_scope, 'create_team_replies', n_log_create,
                                      'penalty_replies', n_log_penalty, 'review_replies', n_log_review),
    'auth_throttle', n_throttle);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Listings (Super Admin only)
-- ---------------------------------------------------------------------------------------------------------------
create function public.list_deletable_admins(p_staff_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  perform app.require_super_admin(p_staff_id);
  return jsonb_build_object('admins', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'username', s.username::text, 'is_active', s.is_active,
             'team_count', (select count(*) from teams t where t.admin_id = s.id),
             'created_at', app.epoch_ms(s.created_at))
           order by s.created_at, s.username)
      from staff_users s where s.role = 'ADMIN'), '[]'::jsonb));
end $$;

create function public.list_deletable_teams(p_staff_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  perform app.require_super_admin(p_staff_id);
  return jsonb_build_object('teams', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'team_code', t.team_code, 'name', t.name, 'login_id', t.login_id::text,
             'status', t.status::text, 'admin_username', a.username::text,
             'member_count', (select count(*) from team_members m where m.team_id = t.id),
             'created_at', app.epoch_ms(t.created_at))
           order by t.team_code, t.created_at)
      from teams t join staff_users a on a.id = t.admin_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. delete_teams
-- ---------------------------------------------------------------------------------------------------------------
create function public.delete_teams(p_staff_id uuid, p_team_ids uuid[], p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now    timestamptz := app.now();
  v_staff  staff_users%rowtype;
  v_ids    uuid[];
  v_fp     text;
  v_replay jsonb;
  v_found  int;
  v_counts jsonb;
  v_resp   jsonb;
  v_cons   text;
  v_tbl    text;
begin
  perform 1 from competition where id = 1 for share;
  select * into v_staff from staff_users where id = p_staff_id for no key update;
  if not found or v_staff.role <> 'SUPER_ADMIN' or not v_staff.is_active then
    perform app.fail('FORBIDDEN');
  end if;

  -- Validate before replay lookup so malformed selections cannot match a valid request.
  v_ids := app.deletion_selection(p_team_ids, 'teamIds');

  -- Fingerprint the validated selection; order does not matter.
  select string_agg(x::text, ',' order by x)
    into v_fp
    from unnest(v_ids) x;
  v_fp := 'teams:' || coalesce(v_fp, '');

  v_replay := app.idem_lookup(p_staff_id, p_idem_key, 'delete_teams', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  -- lock, then verify: every id must still exist (a concurrent deletion that won leaves NOT_FOUND and no change)
  perform 1 from teams where id = any(v_ids) order by id for update;
  select count(*) into v_found from teams where id = any(v_ids);
  if v_found <> cardinality(v_ids) then
    perform app.fail('NOT_FOUND');
  end if;

  begin
    v_counts := app.erase_teams(v_ids, p_staff_id, v_now, p_idem_key);
  exception
    when foreign_key_violation or restrict_violation then
    -- the reference that stopped the deletion, for the SERVER log only: constraint and referencing-table NAMES (schema
    -- identifiers, no row values, no key, no id). The API never forwards details of DELETE_BLOCKED to a browser.
    get stacked diagnostics v_cons = constraint_name, v_tbl = table_name;
    perform app.fail('DELETE_BLOCKED', jsonb_build_object('constraint', v_cons, 'table', v_tbl));
  end;

  insert into audit_events (occurred_at, actor_kind, staff_id, event_type, entity_type, payload, request_id)
  values (v_now, 'STAFF', p_staff_id, 'TEAMS_DELETED', 'TEAM',
          jsonb_build_object('team_ids', to_jsonb(v_ids), 'removed', v_counts), p_idem_key);

  v_resp := jsonb_build_object('replayed', false, 'deleted', jsonb_build_object('teams', cardinality(v_ids)),
                               'team_ids', to_jsonb(v_ids));
  perform app.idem_store(p_staff_id, p_idem_key, 'delete_teams', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. delete_admins: the admins, every team assigned to them, and everything those teams own
-- ---------------------------------------------------------------------------------------------------------------
-- Besides the teams' data (app.erase_teams) an admin owns: its sessions, UFM challenges, throttle key, and the
-- idempotency records in ITS scope (request_log.team_id = the admin's staff id: every staff call it ever made. Despite its
-- name that column is a scope, not a team reference, so this predicate is correct for admins; it is NOT sufficient for
-- teams, which erase_teams handles), plus the Super Admin's stored reply that created it (operation 'create_admin',
-- response.admin.id), which would otherwise replay a deleted admin.
create function public.delete_admins(p_staff_id uuid, p_admin_ids uuid[], p_idem_key uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now      timestamptz := app.now();
  v_staff    staff_users%rowtype;
  v_ids      uuid[];
  v_id_txt   text[];
  v_fp       text;
  v_replay   jsonb;
  v_found    int;
  v_admins   int;
  v_team_ids uuid[];
  v_counts   jsonb;
  v_sessions int;
  v_chal     int;
  v_log_own  int;
  v_log_make int;
  v_resp     jsonb;
  v_cons     text;
  v_tbl      text;
begin
  perform 1 from competition where id = 1 for share;
  select * into v_staff from staff_users where id = p_staff_id for no key update;
  if not found or v_staff.role <> 'SUPER_ADMIN' or not v_staff.is_active then
    perform app.fail('FORBIDDEN');
  end if;

  -- Validate before replay lookup so malformed selections cannot match a valid request.
  v_ids := app.deletion_selection(p_admin_ids, 'adminIds');

  -- Fingerprint the validated selection; order does not matter.
  select string_agg(x::text, ',' order by x)
    into v_fp
    from unnest(v_ids) x;
  v_fp := 'admins:' || coalesce(v_fp, '');

  v_replay := app.idem_lookup(p_staff_id, p_idem_key, 'delete_admins', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  -- phase 1: the teams of the selected admins (team → staff, the order gameplay uses)
  perform 1 from teams where admin_id = any(v_ids) order by id for update;
  -- phase 2: the selected admins; from here create_team (which locks its admin's row) queues behind this transaction
  perform 1 from staff_users where id = any(v_ids) order by id for update;
  select count(*), count(*) filter (where role = 'ADMIN') into v_found, v_admins from staff_users where id = any(v_ids);
  if v_found <> cardinality(v_ids) then
    perform app.fail('NOT_FOUND');
  end if;
  if v_admins <> v_found then          -- the SUPER_ADMIN (and anything that is not a plain ADMIN) is protected
    perform app.fail('FORBIDDEN');
  end if;
  -- phase 3: a team created for one of them between phases 1 and 2
  perform 1 from teams where admin_id = any(v_ids) order by id for update;
  select coalesce(array_agg(id order by id), '{}') into v_team_ids from teams where admin_id = any(v_ids);

  begin
    v_counts := app.erase_teams(v_team_ids, p_staff_id, v_now, p_idem_key);

    insert into audit_events (occurred_at, actor_kind, staff_id, event_type, entity_type, entity_id, payload, request_id)
    select v_now, 'STAFF', p_staff_id, 'ADMIN_DELETED', 'STAFF', s.id::text,
           jsonb_build_object('username', s.username::text, 'role', s.role::text), p_idem_key
      from staff_users s where s.id = any(v_ids) order by s.id;

    select array_agg(x::text) into v_id_txt from unnest(v_ids) x;
    delete from auth_throttle where key in (select 'staff:' || lower(username::text) from staff_users where id = any(v_ids));
    delete from request_log   where team_id = any(v_ids);                                        get diagnostics v_log_own = row_count;
    delete from request_log   where operation = 'create_admin' and response #>> '{admin,id}' = any(v_id_txt);
    get diagnostics v_log_make = row_count;
    delete from sessions      where staff_id = any(v_ids);                                       get diagnostics v_sessions = row_count;
    delete from ufm_challenges where staff_id = any(v_ids);                                     get diagnostics v_chal = row_count;
    delete from staff_users   where id = any(v_ids);
  exception
    when foreign_key_violation or restrict_violation then
    -- the reference that stopped the deletion, for the SERVER log only: constraint and referencing-table NAMES (schema
    -- identifiers, no row values, no key, no id). The API never forwards details of DELETE_BLOCKED to a browser.
    get stacked diagnostics v_cons = constraint_name, v_tbl = table_name;
    perform app.fail('DELETE_BLOCKED', jsonb_build_object('constraint', v_cons, 'table', v_tbl));
  end;

  insert into audit_events (occurred_at, actor_kind, staff_id, event_type, entity_type, payload, request_id)
  values (v_now, 'STAFF', p_staff_id, 'ADMINS_DELETED', 'STAFF',
          jsonb_build_object('admin_ids', to_jsonb(v_ids), 'team_ids', to_jsonb(v_team_ids), 'removed', v_counts,
                             'staff_sessions', v_sessions, 'staff_challenges', v_chal,
                             'staff_request_log', jsonb_build_object('admin_scope', v_log_own, 'create_admin_replies', v_log_make)),
          p_idem_key);

  v_resp := jsonb_build_object('replayed', false,
    'deleted', jsonb_build_object('admins', cardinality(v_ids), 'teams', cardinality(v_team_ids)),
    'admin_ids', to_jsonb(v_ids));
  perform app.idem_store(p_staff_id, p_idem_key, 'delete_admins', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Privileges: service_role only (as in migrations 11–13); the internal helpers are not callable by anyone else
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public.list_deletable_admins(uuid)              from public, anon, authenticated;
revoke all on function public.list_deletable_teams(uuid)               from public, anon, authenticated;
revoke all on function public.delete_teams(uuid, uuid[], uuid)         from public, anon, authenticated;
revoke all on function public.delete_admins(uuid, uuid[], uuid)        from public, anon, authenticated;
revoke all on function app.erase_teams(uuid[], uuid, timestamptz, uuid) from public, anon, authenticated;
revoke all on function app.deletion_selection(uuid[], text)            from public, anon, authenticated;

grant execute on function public.list_deletable_admins(uuid)           to service_role;
grant execute on function public.list_deletable_teams(uuid)            to service_role;
grant execute on function public.delete_teams(uuid, uuid[], uuid)      to service_role;
grant execute on function public.delete_admins(uuid, uuid[], uuid)    to service_role;
-- app.erase_teams is deliberately NOT granted to service_role: it performs no authorisation of its own (and may delete ledger
-- rows), so only the two SECURITY DEFINER functions above (which run as the owner) can reach it.
grant execute on function app.deletion_selection(uuid[], text)         to service_role;
