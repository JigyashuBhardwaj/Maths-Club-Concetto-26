-- Migration 21 — "Renew the Competition" (Super Admin): publish new competition content, remove the previous Admins and
-- their Teams, and re-open the lifecycle for the next competition — all in ONE transaction.
--
-- WHAT THIS MIGRATION CHANGES (deliberately small)
--   * ONE new nullable column:  competition.rules jsonb  — the editable "Rules and regulations" (a JSON array of 1..50 texts).
--     NULL means "never renewed": the application then shows the built-in official rules that ship with the build
--     (src/lib/content/official-public.ts, generated from content/concetto26/official-content.json). Nothing is back-filled,
--     so an existing or fresh database behaves exactly as before until its first renewal.
--   * Five new functions (all SECURITY DEFINER where public, pinned search_path, EXECUTE for service_role only):
--       get_renewal_content(staff_id)                    Super Admin: the current content, a concurrency token, readiness
--       renew_competition(staff_id, content, token, key) Super Admin: the atomic renewal
--       get_competition_rules()                          the rules participants read (service_role, no staff id)
--       app.renewal_content_json / _token / _readiness / _content_problems / _themes / _questions   internal helpers
--   * No table, foreign key, index, trigger or policy is added or altered. Migrations 19 and 20 are NOT rewritten: themes,
--     questions and hints already hold the editable content in their existing columns, and the existing
--     delete_admins() is called as it is.
--
-- WHAT A RENEWAL DOES (renew_competition), in this order, inside the single statement-transaction PostgREST gives an RPC.
-- Any error raises, which rolls EVERYTHING back (nothing is deleted, nothing is published, no lifecycle change):
--   1. Locks: competition FOR UPDATE (every gameplay call, review, team creation and status change takes it FOR SHARE, so
--      none of them can run until this finishes), the caller's staff row, then every team (id order). Same order as
--      migrations 12 and 20, so no deadlock cycle exists.
--   2. The caller must still be an ACTIVE SUPER_ADMIN (FORBIDDEN otherwise).
--   3. Idempotency: a retry with the same key and the same request returns the stored answer (replayed = true).
--   4. The content must be valid and complete (VALIDATION_FAILED, with the field paths) and the caller's token must equal
--      the token of the content as it is right now (CONTENT_CHANGED): nobody can overwrite newer content.
--   5. Preconditions on LIVE rows (RENEWAL_BLOCKED, with the teams that block): see app.renewal_readiness below.
--   6. public.delete_admins() — the existing, tested B18 pathway — for every ADMIN the Super Admin created. It removes the
--      teams of those admins and everything the teams own (ledger, submissions, sessions, request_log, …). It never selects
--      the Super Admin, and the function aborts with RENEWAL_INCOMPLETE if any team or admin would remain.
--   7. UPDATE of the CONTENT COLUMNS only: themes.name/description, questions.body_md/reward_coins, hints.body_md, and
--      competition.rules. Never an id, code, difficulty, unlock_cost, hints.cost, time limit, buy-time option, topic,
--      initial_coins, timer or any other gameplay setting.
--   8. Lifecycle: competition.status -> 'SETUP' with opened_at / paused_at / ended_at cleared (only when it is not SETUP
--      already) and state_version + 1. 'ENDED' is terminal in set_competition_status, so without this the next competition
--      could never be opened. Nothing else of the lifecycle is touched.
--   9. One COMPETITION_RENEWED audit event (counts and tokens; no content text) and the idempotency record.
--
-- "SUBMITTED" / "TIMER EXPIRED" (the spec's wording) as the code defines them — decided here, documented in
-- docs/RENEW_COMPETITION.md. A team does not block a renewal when, by its LIVE rows:
--   NOT_STARTED, FINAL_SUBMITTED, ENDED or DISQUALIFIED                       (nothing is being played / the team is finished)
--   RUNNING and its overall timer has run out (app.team_clock(team) >= ends_at, the same instant every snapshot uses),
--       even if the sweeper has not yet persisted ENDED
--   RUNNING, no question ACTIVE, at least one PENDING_APPROVAL                 (it has submitted and awaits the approval workflow)
-- A team blocks the renewal when it is RUNNING with time left and
--   a question ACTIVE ("actively solving"), or
--   no question ACTIVE and none PENDING_APPROVAL ("its team timer is running": it may start a question any moment).
-- A PENDING_APPROVAL team is allowed because the spec says so, but its pending submission is deleted with the team; the
-- readiness report therefore counts pending submissions and the UI shows that number before the Super Admin confirms.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The one new column
-- ---------------------------------------------------------------------------------------------------------------
alter table competition add column rules jsonb;
-- The check is a CASE on purpose: SQL does not promise left-to-right evaluation of AND / OR, and jsonb_array_length() RAISES
-- ("cannot get array length of a scalar" / "of a non-array") when it is handed a scalar or an object. CASE evaluates its
-- branches in order and stops at the first match, so the length is only ever asked of a value already known to be an array,
-- and the elements are only inspected once the length is known to be 1..50. A malformed value is therefore always a plain
-- CHECK violation (SQLSTATE 23514), never a different error. Every element must be a JSON string (their content, blank or not,
-- is judged by renew_competition, the only writer). The path is `strict` because the default lax mode silently unwraps nested
-- arrays, which would let [["x"]] through.
alter table competition add constraint competition_rules_shape
  check (case
           when rules is null                                              then true
           when jsonb_typeof(rules) <> 'array'                             then false
           when jsonb_array_length(rules) not between 1 and 50             then false
           else not jsonb_path_exists(rules, 'strict $[*] ? (@.type() != "string")')
         end);
comment on column competition.rules is
  'Rules and regulations as a JSON array of texts, written only by renew_competition. NULL = never renewed: the application shows '
  'the built-in official rules that were compiled from content/concetto26/official-content.json.';

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Internal helpers
-- ---------------------------------------------------------------------------------------------------------------
-- The editable content exactly as the editor shows it. Canonical (jsonb orders keys), so equal content gives equal text.
create function app.renewal_content_json() returns jsonb
language sql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
  select jsonb_build_object(
    'themes', (
      select jsonb_agg(jsonb_build_object(
               'id', t.code::text, 'name', t.name, 'description', t.description,
               'questions', (
                 select jsonb_agg(jsonb_build_object(
                          'id', t.code::text || '.' || q.ordinal, 'question', q.body_md,
                          'hint1', h1.body_md, 'hint2', h2.body_md, 'reward', q.reward_coins) order by q.ordinal)
                   from questions q
                   join hints h1 on h1.question_id = q.id and h1.tier = 1
                   join hints h2 on h2.question_id = q.id and h2.tier = 2
                  where q.theme_id = t.id)) order by t.id)
        from themes t),
    'rules', (select c.rules from competition c where c.id = 1))
$$;

-- The optimistic-concurrency token: a SHA-256 of the canonical content. It changes whenever ANY editable value changes,
-- whoever changed it (a renewal, a migration, a manual fix), which is why it is a hash of the content and not a counter.
create function app.renewal_content_token() returns text
language sql stable
set search_path = pg_catalog, public, app, pg_temp
as $$ select encode(sha256(convert_to(app.renewal_content_json()::text, 'UTF8')), 'hex') $$;

-- Is a JSON value NOT an acceptable text? (a string, with something visible in it, no stray control characters, <= p_max chars)
create function app.renewal_text_bad(p_v jsonb, p_max int) returns boolean
language sql immutable
set search_path = pg_catalog, public, app, pg_temp
as $$
  select p_v is null
      or jsonb_typeof(p_v) <> 'string'
      or (p_v #>> '{}') !~ '[^[:space:]]'
      or char_length(p_v #>> '{}') > p_max
      or (p_v #>> '{}') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
$$;

create function app.renewal_keys_are(p_v jsonb, p_keys text[]) returns boolean
language sql immutable
set search_path = pg_catalog, public, app, pg_temp
as $$
  select case when jsonb_typeof(p_v) = 'object'
              then coalesce((select array_agg(k order by k) from jsonb_object_keys(p_v) k), '{}')
                   = (select array_agg(k order by k) from unnest(p_keys) k)
              else false end
$$;

-- Every problem with a submitted content document, as field paths (never values). Empty array = valid and complete.
--   exactly 10 themes A..J in order; 5 questions each, ids X.1..X.5; exactly two hints (hint1, hint2); non-empty texts
--   (name <= 200, description <= 1000, question <= 8000, hint <= 4000, rule <= 2000 characters; the whole request stays < 4 MiB);
--   reward an integer 1..999999; 1..50 rules; no unknown keys anywhere (so no id, price, timer or setting can ride along).
create function app.renewal_content_problems(p_content jsonb) returns text[]
language plpgsql immutable
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_p    text[] := '{}';
  v_t    jsonb;
  v_q    jsonb;
  v_code text;
  v_qid  text;
  i      int;
  j      int;
  v_n    int;
begin
  if not app.renewal_keys_are(p_content, array['themes', 'rules']) then
    return array['content'];
  end if;

  if (case when jsonb_typeof(p_content -> 'themes') = 'array' then jsonb_array_length(p_content -> 'themes') end) is distinct from 10 then
    v_p := v_p || 'themes'::text;
  else
    for i in 0..9 loop
      v_t := (p_content -> 'themes') -> i;
      v_code := chr(65 + i);
      if not app.renewal_keys_are(v_t, array['id', 'name', 'description', 'questions']) then
        v_p := v_p || ('themes.' || v_code);
        continue;
      end if;
      if (v_t -> 'id') is distinct from to_jsonb(v_code) then v_p := v_p || ('themes.' || v_code || '.id'); end if;
      if app.renewal_text_bad(v_t -> 'name', 200) then v_p := v_p || ('themes.' || v_code || '.name'); end if;
      if app.renewal_text_bad(v_t -> 'description', 1000) then v_p := v_p || ('themes.' || v_code || '.description'); end if;

      if (case when jsonb_typeof(v_t -> 'questions') = 'array' then jsonb_array_length(v_t -> 'questions') end) is distinct from 5 then
        v_p := v_p || ('themes.' || v_code || '.questions');
      else
        for j in 0..4 loop
          v_q := (v_t -> 'questions') -> j;
          v_qid := v_code || '.' || (j + 1);
          if not app.renewal_keys_are(v_q, array['id', 'question', 'hint1', 'hint2', 'reward']) then
            v_p := v_p || ('questions.' || v_qid);
            continue;
          end if;
          if (v_q -> 'id') is distinct from to_jsonb(v_qid) then v_p := v_p || ('questions.' || v_qid || '.id'); end if;
          if app.renewal_text_bad(v_q -> 'question', 8000) then v_p := v_p || ('questions.' || v_qid || '.question'); end if;
          if app.renewal_text_bad(v_q -> 'hint1', 4000) then v_p := v_p || ('questions.' || v_qid || '.hint1'); end if;
          if app.renewal_text_bad(v_q -> 'hint2', 4000) then v_p := v_p || ('questions.' || v_qid || '.hint2'); end if;
          -- the text of a JSON number: 5 is accepted; 5.0, 1e3, -1, 0 and "5" (a string) are not
          if jsonb_typeof(v_q -> 'reward') <> 'number' or (v_q -> 'reward')::text !~ '^[1-9][0-9]{0,5}$' then
            v_p := v_p || ('questions.' || v_qid || '.reward');
          end if;
        end loop;
      end if;
    end loop;
  end if;

  v_n := case when jsonb_typeof(p_content -> 'rules') = 'array' then jsonb_array_length(p_content -> 'rules') end;
  if v_n is null or v_n < 1 or v_n > 50 then
    v_p := v_p || 'rules'::text;
  else
    for i in 0..v_n - 1 loop
      if app.renewal_text_bad((p_content -> 'rules') -> i, 2000) then v_p := v_p || ('rules.' || (i + 1)); end if;
    end loop;
  end if;
  return v_p;
end $$;

-- The validated document as rows (ids are positions: themes.id = 1..10, questions.id = (theme - 1) * 5 + ordinal)
create function app.renewal_themes(p_content jsonb) returns table (id smallint, name text, description text)
language sql immutable
set search_path = pg_catalog, public, app, pg_temp
as $$
  select x.ord::smallint, x.e ->> 'name', x.e ->> 'description'
    from jsonb_array_elements(p_content -> 'themes') with ordinality as x(e, ord)
$$;

create function app.renewal_questions(p_content jsonb)
returns table (id smallint, body_md text, reward int, hint1 text, hint2 text)
language sql immutable
set search_path = pg_catalog, public, app, pg_temp
as $$
  select ((th.ord - 1) * 5 + qq.ord)::smallint, qq.e ->> 'question', (qq.e ->> 'reward')::int, qq.e ->> 'hint1', qq.e ->> 'hint2'
    from jsonb_array_elements(p_content -> 'themes') with ordinality as th(e, ord),
         jsonb_array_elements(th.e -> 'questions') with ordinality as qq(e, ord)
$$;

-- Can the competition be renewed right now? Pure read of live rows, same clock as every snapshot (app.team_clock).
-- `blockers` lists (at most 50) the teams that stop it, with the reason; `ready` is false iff there is at least one.
create function app.renewal_readiness() returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_blockers jsonb;
  v_blocked  int;
begin
  with t as (
    select x.id, x.team_code, x.name,
           case
             when x.status in ('NOT_STARTED', 'FINAL_SUBMITTED', 'ENDED', 'DISQUALIFIED') then null
             when x.status = 'RUNNING' and app.team_clock(x) >= x.ends_at then null           -- the overall timer ran out
             when exists (select 1 from team_questions q where q.team_id = x.id and q.state = 'ACTIVE') then 'ACTIVE_QUESTION'
             when exists (select 1 from team_questions q where q.team_id = x.id and q.state = 'PENDING_APPROVAL') then null
             else 'TEAM_TIMER_RUNNING'
           end as reason
      from teams x)
  select count(*) filter (where reason is not null),
         coalesce(jsonb_agg(jsonb_build_object('team_code', team_code, 'name', name, 'reason', reason)
                            order by team_code) filter (where reason is not null), '[]'::jsonb)
    into v_blocked, v_blockers
    from t;

  return jsonb_build_object(
    'ready', v_blocked = 0,
    'blocked_count', v_blocked,
    'blockers', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_blockers) e limit 50) s),
    'admins', (select count(*) from staff_users where role = 'ADMIN'),
    'teams', (select count(*) from teams),
    'pending_submissions', (select count(*) from submissions where status = 'PENDING'),
    'competition_status', (select status from competition where id = 1));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. get_renewal_content — Super Admin only (re-checked here, whatever the server resolved)
-- ---------------------------------------------------------------------------------------------------------------
create function public.get_renewal_content(p_staff_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  perform app.require_super_admin(p_staff_id);
  return jsonb_build_object('content', app.renewal_content_json(), 'token', app.renewal_content_token(),
                            'readiness', app.renewal_readiness());
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. get_competition_rules — what participants read. No staff id: rules are public competition text.
-- ---------------------------------------------------------------------------------------------------------------
create function public.get_competition_rules() returns jsonb
language sql stable security definer
set search_path = pg_catalog, public, app, pg_temp
as $$ select jsonb_build_object('rules', (select c.rules from competition c where c.id = 1)) $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. renew_competition
-- ---------------------------------------------------------------------------------------------------------------
create function public.renew_competition(p_staff_id uuid, p_content jsonb, p_expected_token text, p_idem_key uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_now        timestamptz := app.now();
  v_comp       competition%rowtype;
  v_staff      staff_users%rowtype;
  v_fp         text;
  v_replay     jsonb;
  v_problems   text[];
  v_ready      jsonb;
  v_before     text;
  v_after      text;
  v_admin_ids  uuid[];
  v_chunk      uuid[];
  v_del        jsonb;
  n_admins     int := 0;
  n_teams      int := 0;
  n_themes     int;
  n_questions  int;
  n_hints      int;
  i            int;
  v_resp       jsonb;
begin
  -- 1. locks, in the repository's global order: competition -> caller -> teams
  select * into v_comp from competition where id = 1 for update;
  if not found then
    perform app.fail('NOT_FOUND');
  end if;
  select * into v_staff from staff_users where id = p_staff_id for no key update;
  -- 2. still an authorised Super Admin?
  if not found or v_staff.role <> 'SUPER_ADMIN' or not v_staff.is_active then
    perform app.fail('FORBIDDEN');
  end if;

  -- 3. idempotency (the fingerprint binds the key to this exact content and token; the content is not stored in it)
  v_fp := 'renew:' || encode(sha256(convert_to(coalesce(p_content::text, '') || '|' || coalesce(p_expected_token, ''), 'UTF8')), 'hex');
  v_replay := app.idem_lookup(p_staff_id, p_idem_key, 'renew_competition', v_fp);
  if v_replay is not null then
    return v_replay || '{"replayed": true}'::jsonb;
  end if;

  -- 4. validation, then the concurrency check
  v_problems := app.renewal_content_problems(p_content);
  if p_expected_token is null or p_expected_token !~ '^[0-9a-f]{64}$' then
    v_problems := v_problems || 'expectedToken'::text;
  end if;
  if cardinality(v_problems) > 0 then
    perform app.fail('VALIDATION_FAILED', jsonb_build_object('fields', to_jsonb(v_problems[1:20])));
  end if;
  v_before := app.renewal_content_token();
  if v_before <> p_expected_token then
    perform app.fail('CONTENT_CHANGED');
  end if;

  -- 5. preconditions on live rows (every team locked first, so none can change under the check)
  perform 1 from teams order by id for update;
  v_ready := app.renewal_readiness();
  if not (v_ready ->> 'ready')::boolean then
    perform app.fail('RENEWAL_BLOCKED', v_ready);
  end if;

  -- 6. the existing deletion pathway, for the admins this Super Admin created (read AFTER the caller's row is locked, so an
  --    admin being created concurrently is either included or waits). Chunks of 100 = delete_admins' own limit; each call
  --    gets its own derived idempotency key.
  select coalesce(array_agg(id order by id), '{}') into v_admin_ids
    from staff_users where role = 'ADMIN' and created_by = p_staff_id;
  i := 0;
  while i < cardinality(v_admin_ids) loop
    v_chunk := v_admin_ids[i + 1 : i + 100];
    v_del := public.delete_admins(p_staff_id, v_chunk, md5(p_idem_key::text || ':renew-delete:' || i)::uuid);
    n_admins := n_admins + coalesce((v_del #>> '{deleted,admins}')::int, 0);
    n_teams  := n_teams  + coalesce((v_del #>> '{deleted,teams}')::int, 0);
    i := i + 100;
  end loop;
  if exists (select 1 from teams) or exists (select 1 from staff_users where role = 'ADMIN') then
    perform app.fail('RENEWAL_INCOMPLETE');                  -- unreachable through the application; rolls everything back
  end if;

  -- 7. content: only the content columns, only rows that differ
  update themes t set name = c.name, description = c.description
    from app.renewal_themes(p_content) c
   where t.id = c.id and (t.name, t.description) is distinct from (c.name, c.description);
  get diagnostics n_themes = row_count;
  update questions q set body_md = c.body_md, reward_coins = c.reward
    from app.renewal_questions(p_content) c
   where q.id = c.id and (q.body_md, q.reward_coins) is distinct from (c.body_md, c.reward);
  get diagnostics n_questions = row_count;
  update hints h set body_md = case h.tier when 1 then c.hint1 else c.hint2 end
    from app.renewal_questions(p_content) c
   where h.question_id = c.id and h.body_md is distinct from (case h.tier when 1 then c.hint1 else c.hint2 end);
  get diagnostics n_hints = row_count;
  update competition set rules = p_content -> 'rules' where id = 1;

  -- the database must now hold exactly what was submitted (a final proof, not an assumption)
  if (app.renewal_content_json() -> 'themes') is distinct from (p_content -> 'themes')
     or (select rules from competition where id = 1) is distinct from (p_content -> 'rules') then
    perform app.fail('RENEWAL_CONTENT_MISMATCH');            -- an internal invariant; rolls everything back
  end if;

  -- 8. lifecycle: only what the next competition needs
  if v_comp.status <> 'SETUP' then
    update competition set status = 'SETUP', opened_at = null, paused_at = null, ended_at = null where id = 1;
  end if;
  update competition set state_version = state_version + 1 where id = 1;

  -- 9. audit + idempotency
  v_after := app.renewal_content_token();
  insert into audit_events (occurred_at, actor_kind, staff_id, event_type, entity_type, entity_id, payload, request_id)
  values (v_now, 'STAFF', p_staff_id, 'COMPETITION_RENEWED', 'COMPETITION', '1',
          jsonb_build_object('from_status', v_comp.status, 'to_status', 'SETUP',
                             'admins_deleted', n_admins, 'teams_deleted', n_teams,
                             'pending_submissions_discarded', (v_ready ->> 'pending_submissions')::int,
                             'themes_changed', n_themes, 'questions_changed', n_questions, 'hints_changed', n_hints,
                             'rules', jsonb_array_length(p_content -> 'rules'),
                             'token_before', v_before, 'token_after', v_after),
          p_idem_key);

  v_resp := jsonb_build_object('replayed', false,
    'deleted', jsonb_build_object('admins', n_admins, 'teams', n_teams),
    'discarded', jsonb_build_object('pending_submissions', (v_ready ->> 'pending_submissions')::int),
    'changed', jsonb_build_object('themes', n_themes, 'questions', n_questions, 'hints', n_hints),
    'competition', jsonb_build_object('from', v_comp.status, 'to', 'SETUP'),
    'token', v_after);
  perform app.idem_store(p_staff_id, p_idem_key, 'renew_competition', v_fp, v_resp);
  return v_resp;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Privileges: service_role only, like every function since migration 11
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function app.renewal_content_json()                    from public, anon, authenticated;
revoke all on function app.renewal_content_token()                   from public, anon, authenticated;
revoke all on function app.renewal_text_bad(jsonb, int)              from public, anon, authenticated;
revoke all on function app.renewal_keys_are(jsonb, text[])           from public, anon, authenticated;
revoke all on function app.renewal_content_problems(jsonb)           from public, anon, authenticated;
revoke all on function app.renewal_readiness()                       from public, anon, authenticated;
revoke all on function app.renewal_themes(jsonb)                     from public, anon, authenticated;
revoke all on function app.renewal_questions(jsonb)                  from public, anon, authenticated;
revoke all on function public.get_renewal_content(uuid)              from public, anon, authenticated;
revoke all on function public.get_competition_rules()                from public, anon, authenticated;
revoke all on function public.renew_competition(uuid, jsonb, text, uuid) from public, anon, authenticated;

grant execute on function public.get_renewal_content(uuid)           to service_role;
grant execute on function public.get_competition_rules()             to service_role;
grant execute on function public.renew_competition(uuid, jsonb, text, uuid) to service_role;
-- the app.* helpers are reachable only through the SECURITY DEFINER functions above (which run as the owner)
