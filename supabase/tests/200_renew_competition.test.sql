-- B20 / migration 21: "Renew the Competition". The Super Admin publishes new competition content, and in the SAME transaction the
-- Admins that Super Admin created (and their Teams) are removed through the existing delete_admins pathway and the lifecycle is
-- re-opened. Proves: authorisation, the content contract (fixed 10 x 5 x 2 structure, positive integer rewards, 1..50 rules, no
-- unknown keys), the concurrency token, every precondition on live rows, the deletion scope, that nothing outside the content
-- columns changes, atomic rollback when the deletion is blocked, idempotent replay, that the next competition can be provisioned,
-- opened, played and paid with the NEW content, and the >100 admins chunking.
-- Multi-connection races: concurrency/zz_renew.concurrency.mjs.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';

create function pg_temp.at(ts text) returns void language plpgsql as $$
begin perform set_config('app.test_now', ts, false); end $$;
create function pg_temp.key(n int) returns uuid language sql as
  $$ select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.team_id(t int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000b' || t)::uuid $$;
create function pg_temp.member_id(t int, s int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-00000000c' || t || '0' || s)::uuid $$;
create function pg_temp.staff(n int) returns uuid language sql as $$ select ('00000000-0000-0000-0000-0000000000a' || n)::uuid $$;
create function pg_temp.status(act text, n int) returns jsonb language sql as
  $$ select public.set_competition_status(pg_temp.staff(1), act, pg_temp.key(n)) $$;
create function pg_temp.start(t int, n int) returns jsonb language sql as
  $$ select public.start_team_competition(pg_temp.team_id(t), pg_temp.member_id(t, 1), pg_temp.key(n)) $$;
create function pg_temp.unlock(t int, theme int, n int) returns jsonb language sql as
  $$ select public.unlock_theme(pg_temp.team_id(t), pg_temp.member_id(t, 1), theme::smallint, pg_temp.key(n)) $$;
create function pg_temp.enter(t int, q int, n int) returns jsonb language sql as
  $$ select public.start_question(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint, pg_temp.key(n)) $$;
create function pg_temp.submit(t int, q int, n int) returns jsonb language sql as
  $$ select public.submit_answer(pg_temp.team_id(t), pg_temp.member_id(t, 1), q::smallint, 'ans', 'because', pg_temp.key(n)) $$;
create function pg_temp.sub(t int, q int) returns uuid language sql as
  $$ select id from submissions where team_id = pg_temp.team_id(t) and question_id = q and status = 'PENDING' $$;
create function pg_temp.approve(who int, t int, q int, n int) returns jsonb language sql as
  $$ select public.approve_submission(pg_temp.staff(who), pg_temp.sub(t, q), pg_temp.key(n)) $$;

-- the Super Admin's calls
create function pg_temp.cur() returns jsonb language sql as $$ select public.get_renewal_content(pg_temp.staff(1)) $$;
create function pg_temp.tok() returns text language sql as $$ select pg_temp.cur() ->> 'token' $$;
create function pg_temp.renew(content jsonb, tok text, n int) returns jsonb language sql as
  $$ select public.renew_competition(pg_temp.staff(1), content, tok, pg_temp.key(n)) $$;

-- the current content with EVERY kind of editable value changed (multiline, unicode, quotes, markdown/KaTeX, punctuation)
create function pg_temp.edited() returns jsonb language plpgsql as $$
declare c jsonb := app.renewal_content_json();
begin
  c := jsonb_set(c, '{themes,0,name}', to_jsonb('NEW “A” — Ünïcode ✓ & <b>'::text));
  c := jsonb_set(c, '{themes,0,description}', to_jsonb(E'First line\nSecond line: ∑ x² ≤ 1, "quoted", ''single''; 日本語'::text));
  c := jsonb_set(c, '{themes,0,questions,0,question}', to_jsonb(E'Q A.1 NEW\n\nFind $\\sum_{k=1}^{n} k$ — done?\n  indented line\n'::text));
  c := jsonb_set(c, '{themes,0,questions,0,hint1}', to_jsonb(E'NEW TIER-1 A.1\nline two'::text));
  c := jsonb_set(c, '{themes,0,questions,0,hint2}', to_jsonb('NEW TIER-2 A.1 ✓'::text));
  c := jsonb_set(c, '{themes,0,questions,0,reward}', '777'::jsonb);
  c := jsonb_set(c, '{themes,9,questions,4,reward}', '123456'::jsonb);
  c := jsonb_set(c, '{themes,9,name}', to_jsonb('NEW J'::text));
  c := jsonb_set(c, '{rules}', jsonb_build_array('Rule one.', E'Rule two\nwith a second line — ünï', 'Rule three; "quotes".'));
  return c;
end $$;

create function pg_temp.table_fp(tbl text) returns text language plpgsql as $f$
declare r text;
begin
  execute format($q$select coalesce(md5(string_agg(x::text, ',' order by x::text)), '-') || '/' || count(*) from %I x$q$, tbl) into r;
  return r;
end $f$;
-- every operational table of the world (a rollback must restore all of it)
create function pg_temp.world_fp() returns text language sql as $$
  select concat_ws('|', pg_temp.table_fp('teams'), pg_temp.table_fp('team_members'), pg_temp.table_fp('staff_users'), pg_temp.table_fp('sessions'),
    pg_temp.table_fp('team_themes'), pg_temp.table_fp('team_questions'), pg_temp.table_fp('answer_drafts'), pg_temp.table_fp('hint_purchases'),
    pg_temp.table_fp('team_time_purchases'), pg_temp.table_fp('submissions'), pg_temp.table_fp('ufm_challenges'), pg_temp.table_fp('auth_throttle'),
    pg_temp.table_fp('request_log'), pg_temp.table_fp('coin_transactions'), pg_temp.table_fp('audit_events'), pg_temp.table_fp('competition'),
    pg_temp.table_fp('themes'), pg_temp.table_fp('questions'), pg_temp.table_fp('hints')) $$;
-- gameplay settings: everything a renewal must never change
create function pg_temp.settings_fp() returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(concat_ws(',', id, code, difficulty, unlock_cost, display_order, array_to_string(topics, ';')), ';' order by id) from themes),
    (select string_agg(concat_ws(',', id, theme_id, ordinal, difficulty, time_limit_seconds), ';' order by id) from questions),
    (select string_agg(concat_ws(',', id, question_id, tier, cost), ';' order by id) from hints),
    (select string_agg(x::text, ';' order by x::text) from question_buy_time_options x),
    (select string_agg(x::text, ';' order by x::text) from question_keys x),
    (select concat_ws(',', ultimate_seconds, initial_coins, points_per_completed_theme, points_per_solved_question, penalty_per_minute,
                           reset_floor_score, disqualified_score) from competition where id = 1))) $$;
-- the blockers of a failed renewal (the DETAIL of the RENEWAL_BLOCKED exception)
create function pg_temp.blockers(content jsonb, tok text, n int) returns jsonb language plpgsql as $f$
declare d text;
begin
  begin
    perform pg_temp.renew(content, tok, n);
  exception when others then
    get stacked diagnostics d = pg_exception_detail;
    if sqlerrm <> 'RENEWAL_BLOCKED' then raise exception 'expected RENEWAL_BLOCKED, got % / %', sqlerrm, d; end if;
    return d::jsonb;
  end;
  raise exception 'the renewal was NOT blocked';
end $f$;

-- ===== 0. the shape of the change ==========================================================================================
do $$
begin
  assert (select count(*) from competition where rules is null) = 1, 'rules start as NULL: nothing is back-filled';
  assert (public.get_competition_rules() -> 'rules') = 'null'::jsonb, 'NULL rules are reported as JSON null (the app then uses the built-in rules)';
  -- competition_rules_shape is a CASE: a value that is not an array must be a plain CHECK violation (23514) and never the
  -- "cannot get array length of a scalar / non-array" error (22023) jsonb_array_length() raises, whatever the evaluation order.
  declare v text;
  begin
    foreach v in array array[
      '[]', '{}', '{"a": 1}', '"x"', '""', '7', '0', 'true', 'false', 'null', '1.5',      -- empty array, objects, scalars, JSON null
      '[1]', '[null]', '[true]', '[["x"]]', '[{"a": 1}]', '["ok", 7]', '["ok", null]']   -- right size, wrong element type
    loop
      perform pg_temp.rejects(format('update competition set rules = %L::jsonb', v), '23514');
    end loop;
    perform pg_temp.rejects($s$update competition set rules = (select jsonb_agg('r'::text) from generate_series(1, 51))$s$, '23514');
    perform pg_temp.rejects($s$update competition set rules = (select jsonb_agg('r'::text) from generate_series(1, 500))$s$, '23514');
    -- accepted: SQL NULL (never renewed), 1 and 50 strings (blank ones are renew_competition's business, not the column's)
    update competition set rules = '["x"]';
    update competition set rules = (select jsonb_agg('r'::text) from generate_series(1, 50));
    update competition set rules = '["", "  "]';
    update competition set rules = null;
    assert (select rules is null from competition), 'back to NULL';
  end;
end $$;

-- ===== 1. authorisation ====================================================================================================
do $$
declare t text := pg_temp.tok();
begin
  perform pg_temp.rejects($s$select public.get_renewal_content(pg_temp.staff(2))$s$, 'FORBIDDEN');            -- an Admin
  perform pg_temp.rejects($s$select public.get_renewal_content(gen_random_uuid())$s$, 'FORBIDDEN');           -- nobody
  perform pg_temp.rejects($s$select public.get_renewal_content(null)$s$, 'FORBIDDEN');
  perform pg_temp.rejects(format($s$select public.renew_competition(pg_temp.staff(2), %L::jsonb, %L, pg_temp.key(1))$s$, pg_temp.edited()::text, t), 'FORBIDDEN');
  perform pg_temp.rejects(format($s$select public.renew_competition(pg_temp.team_id(1), %L::jsonb, %L, pg_temp.key(1))$s$, pg_temp.edited()::text, t), 'FORBIDDEN');  -- a team id
  perform pg_temp.rejects(format($s$select public.renew_competition(null, %L::jsonb, %L, pg_temp.key(1))$s$, pg_temp.edited()::text, t), 'FORBIDDEN');
  -- a disabled Super Admin is no longer authorised (the check is made again inside the transaction)
  update staff_users set is_active = false where id = pg_temp.staff(1);
  perform pg_temp.rejects($s$select public.get_renewal_content(pg_temp.staff(1))$s$, 'FORBIDDEN');
  perform pg_temp.rejects(format($s$select pg_temp.renew(%L::jsonb, %L, 1)$s$, pg_temp.edited()::text, t), 'FORBIDDEN');
  update staff_users set is_active = true where id = pg_temp.staff(1);
  assert (select count(*) from staff_users where role = 'ADMIN') = 2 and (select count(*) from teams) = 2, 'nothing was deleted';
end $$;

-- ===== 2. what the editor receives ========================================================================================
do $$
declare r jsonb := pg_temp.cur(); c jsonb := r -> 'content';
begin
  assert jsonb_array_length(c -> 'themes') = 10 and (select bool_and(jsonb_array_length(t -> 'questions') = 5) from jsonb_array_elements(c -> 'themes') t);
  assert (select string_agg(t ->> 'id', '') from jsonb_array_elements(c -> 'themes') t) = 'ABCDEFGHIJ';
  assert (select string_agg(q ->> 'id', ',') from jsonb_array_elements(c #> '{themes,1,questions}') q) = 'B.1,B.2,B.3,B.4,B.5';
  assert (c #>> '{themes,0,questions,0,id}') = 'A.1' and (c #>> '{themes,9,questions,4,id}') = 'J.5';
  assert (select count(*) from jsonb_array_elements(c -> 'themes') t, jsonb_array_elements(t -> 'questions') q
           where q ->> 'question' = (select body_md from questions where id = (ascii(t ->> 'id') - 65) * 5 + right(q ->> 'id', 1)::int)) = 50;
  assert (c -> 'rules') = 'null'::jsonb;
  assert (r ->> 'token') ~ '^[0-9a-f]{64}$';
  assert (r #>> '{readiness,ready}')::boolean and (r #>> '{readiness,teams}')::int = 2 and (r #>> '{readiness,admins}')::int = 2;
  assert pg_temp.tok() = pg_temp.tok(), 'the token is stable while nothing changes';
  assert app.renewal_content_problems(jsonb_set(c, '{rules}', '["x"]')) = '{}', 'the content the editor receives is itself valid (once null rules are replaced by the app)';
end $$;

-- ===== 3. validation: every violation is rejected, with the field path, and nothing changes ================================
create temp table world0 as select pg_temp.world_fp() as fp, pg_temp.settings_fp() as sfp, pg_temp.tok() as tok;
do $$
declare
  t text := (select tok from world0);
  e jsonb := pg_temp.edited();
  r record; d text; n int := 100;
begin
  for r in
    select * from (values
      ('9 themes',            e #- '{themes,9}',                                                              'themes'),
      ('11 themes',           jsonb_set(e, '{themes}', (e -> 'themes') || (e #> '{themes,0}')),               'themes'),
      ('themes reordered',    jsonb_set(jsonb_set(e, '{themes,0}', e #> '{themes,1}'), '{themes,1}', e #> '{themes,0}'), 'themes.A.id'),
      ('theme id renamed',    jsonb_set(e, '{themes,2,id}', '"Z"'),                                           'themes.C.id'),
      ('4 questions',         e #- '{themes,3,questions,4}',                                                   'themes.D.questions'),
      ('6 questions',         jsonb_set(e, '{themes,3,questions}', (e #> '{themes,3,questions}') || (e #> '{themes,3,questions,0}')), 'themes.D.questions'),
      ('question id changed', jsonb_set(e, '{themes,4,questions,2,id}', '"E.9"'),                             'questions.E.3.id'),
      ('empty name',          jsonb_set(e, '{themes,0,name}', '""'),                                          'themes.A.name'),
      ('blank description',   jsonb_set(e, '{themes,1,description}', to_jsonb(E' \n\t '::text)),              'themes.B.description'),
      ('null question',       jsonb_set(e, '{themes,1,questions,0,question}', 'null'),                        'questions.B.1.question'),
      ('empty hint1',         jsonb_set(e, '{themes,5,questions,1,hint1}', '""'),                             'questions.F.2.hint1'),
      ('missing hint2',       e #- '{themes,5,questions,1,hint2}',                                             'questions.F.2'),
      ('a third hint',        jsonb_set(e, '{themes,5,questions,1,hint3}', '"x"'),                            'questions.F.2'),
      ('reward 0',            jsonb_set(e, '{themes,6,questions,0,reward}', '0'),                             'questions.G.1.reward'),
      ('reward negative',     jsonb_set(e, '{themes,6,questions,0,reward}', '-5'),                            'questions.G.1.reward'),
      ('reward 5.5',          jsonb_set(e, '{themes,6,questions,0,reward}', '5.5'),                           'questions.G.1.reward'),
      ('reward 5.0',          jsonb_set(e, '{themes,6,questions,0,reward}', '5.0'),                           'questions.G.1.reward'),
      ('reward as string',    jsonb_set(e, '{themes,6,questions,0,reward}', '"5"'),                           'questions.G.1.reward'),
      ('reward too large',    jsonb_set(e, '{themes,6,questions,0,reward}', '1000000'),                       'questions.G.1.reward'),
      ('reward null',         jsonb_set(e, '{themes,6,questions,0,reward}', 'null'),                          'questions.G.1.reward'),
      ('no rules',            jsonb_set(e, '{rules}', '[]'),                                                  'rules'),
      ('rules null',          jsonb_set(e, '{rules}', 'null'),                                                'rules'),
      ('blank rule',          jsonb_set(e, '{rules}', '["ok", "  "]'),                                         'rules.2'),
      ('rule not a string',   jsonb_set(e, '{rules}', '["ok", 7]'),                                            'rules.2'),
      ('51 rules',            jsonb_set(e, '{rules}', (select jsonb_agg('r' || g) from generate_series(1, 51) g)), 'rules'),
      ('rule too long',       jsonb_set(e, '{rules}', to_jsonb(array[repeat('x', 2001)])),                    'rules.1'),
      ('control character',   jsonb_set(e, '{themes,0,name}', to_jsonb('bad' || chr(7) || 'name')),           'themes.A.name'),
      ('name too long',       jsonb_set(e, '{themes,0,name}', to_jsonb(repeat('n', 201))),                    'themes.A.name'),
      ('question too long',   jsonb_set(e, '{themes,0,questions,0,question}', to_jsonb(repeat('q', 8001))),  'questions.A.1.question'),
      ('hint 1 too long',     jsonb_set(e, '{themes,0,questions,0,hint1}', to_jsonb(repeat('h', 4001))),      'questions.A.1.hint1'),
      ('hint 2 too long',     jsonb_set(e, '{themes,0,questions,0,hint2}', to_jsonb(repeat('h', 4001))),      'questions.A.1.hint2'),
      ('description too long', jsonb_set(e, '{themes,0,description}', to_jsonb(repeat('d', 1001))),           'themes.A.description'),
      ('extra top-level key', e || '{"unlock_cost": 5}',                                                      'content'),
      ('extra theme key',     jsonb_set(e, '{themes,0,unlock_cost}', '1'),                                    'themes.A'),
      ('missing rules key',   e - 'rules',                                                                     'content'),
      ('not an object',       '[]'::jsonb,                                                                    'content'),
      ('null content',        'null'::jsonb,                                                                  'content')
    ) v(label, content, field)
  loop
    n := n + 1;
    begin
      perform pg_temp.renew(r.content, t, n);
      raise exception 'NOT rejected: %', r.label;
    exception when others then
      get stacked diagnostics d = pg_exception_detail;
      if sqlerrm <> 'VALIDATION_FAILED' or d is null or position('"' || r.field || '"' in d) = 0 then
        raise exception 'wrong rejection for [%]: % / % (wanted VALIDATION_FAILED naming %)', r.label, sqlerrm, d, r.field;
      end if;
    end;
  end loop;
  -- a SQL NULL document, a missing / malformed token
  perform pg_temp.rejects(format($s$select pg_temp.renew(null, %L, 400)$s$, t), 'VALIDATION_FAILED');
  perform pg_temp.rejects(format($s$select pg_temp.renew(%L::jsonb, null, 401)$s$, e::text), 'VALIDATION_FAILED');
  perform pg_temp.rejects(format($s$select pg_temp.renew(%L::jsonb, 'not-a-token', 402)$s$, e::text), 'VALIDATION_FAILED');
  perform pg_temp.rejects(format($s$select public.renew_competition(pg_temp.staff(1), %L::jsonb, %L, null)$s$, e::text, t), 'VALIDATION_FAILED');   -- no key
  -- more than 20 problems: only the first 20 are reported
  perform pg_temp.rejects(format($s$select pg_temp.renew(%L::jsonb, %L, 403)$s$,
    (select jsonb_set(e, '{themes}', (select jsonb_agg(jsonb_set(th, '{name}', '""')) from jsonb_array_elements(e -> 'themes') th))::text), t), 'VALIDATION_FAILED');
  assert pg_temp.world_fp() = (select fp from world0), 'a rejected request changed nothing at all';
end $$;

-- ===== 4. the concurrency token ============================================================================================
do $$
declare t text := (select tok from world0);
begin
  perform pg_temp.rejects(format($s$select pg_temp.renew(%L::jsonb, %L, 410)$s$, pg_temp.edited()::text, repeat('0', 64)), 'CONTENT_CHANGED');
  assert pg_temp.world_fp() = (select fp from world0);
  -- ANY change of any editable value changes the token, whoever made it
  update hints set body_md = body_md || ' ' where id = 100;
  assert pg_temp.tok() <> t, 'a hint edit moves the token';
  perform pg_temp.rejects(format($s$select pg_temp.renew(%L::jsonb, %L, 411)$s$, pg_temp.edited()::text, t), 'CONTENT_CHANGED');
  update hints set body_md = rtrim(body_md) where id = 100;
  assert pg_temp.tok() = t, 'restoring the text restores the token';
  update competition set rules = '["x"]';
  assert pg_temp.tok() <> t, 'rules are part of the token';
  update competition set rules = null;
  assert pg_temp.tok() = t;
  update questions set reward_coins = reward_coins + 1 where id = 7;
  assert pg_temp.tok() <> t, 'a reward edit moves the token';
  update questions set reward_coins = reward_coins - 1 where id = 7;
  assert pg_temp.tok() = t;
end $$;

-- ===== 5. teams in every state: who blocks and who does not ================================================================
-- fixture teams T01 (admin a2), T02 (admin a3). Extra teams: T03 NOT_STARTED, T04 FINAL_SUBMITTED, T05 DISQUALIFIED, T06 ENDED.
insert into teams (id, team_code, name, login_id, password_hash, admin_id, coins, status, started_at, ends_at, ended_at, timer_seconds,
                   final_submitted_at, score_override)
select pg_temp.team_id(n), 'T0' || n, 'Test Team ' || n, 'test_team_0' || n, 'TEST-NOT-A-HASH', pg_temp.staff(2), 500,
       s::team_status, case when s = 'NOT_STARTED' then null else '2026-12-01 08:00:00+00'::timestamptz end,
       case when s = 'NOT_STARTED' then null else '2026-12-01 12:00:00+00'::timestamptz end,
       case when s = 'NOT_STARTED' then null else '2026-12-01 10:00:00+00'::timestamptz end,
       case when s = 'NOT_STARTED' then null else 14400 end,
       case when s = 'FINAL_SUBMITTED' then '2026-12-01 10:00:00+00'::timestamptz end,
       case when s = 'DISQUALIFIED' then -1201 end
  from (values (3, 'NOT_STARTED'), (4, 'FINAL_SUBMITTED'), (5, 'DISQUALIFIED'), (6, 'ENDED')) v(n, s);
-- ended_at must be set for the three terminal states and NULL for NOT_STARTED/RUNNING (teams_terminal_has_ended_at): fix T03
update teams set ended_at = null where id = pg_temp.team_id(3);
insert into team_members (id, team_id, slot, admission_no)
select pg_temp.member_id(n, s), pg_temp.team_id(n), s, 'TEST' || n || s from generate_series(3, 6) n cross join generate_series(1, 4) s;
insert into coin_transactions (team_id, type, amount, balance_after, created_at)
select pg_temp.team_id(n), 'INITIAL_GRANT', 500, 500, now() from generate_series(3, 6) n;
update teams set final_submitted_by = pg_temp.member_id(4, 1) where id = pg_temp.team_id(4);

do $$
declare r jsonb;
begin
  -- the finished and the never-started teams never block (competition still SETUP)
  r := app.renewal_readiness();
  assert (r ->> 'ready')::boolean and (r ->> 'blocked_count')::int = 0 and (r ->> 'teams')::int = 6, r::text;
end $$;

select pg_temp.status('open', 20);
select pg_temp.start(1, 21), pg_temp.start(2, 22);
select pg_temp.at('2026-12-01 12:01:00+00');
select pg_temp.unlock(1, 1, 23), pg_temp.unlock(2, 1, 24);
-- T01 enters Q1 (ACTIVE); T02 has Q1 AVAILABLE and has not entered it (its team timer is running)
select pg_temp.enter(1, 1, 25);
create temp table world1 as select pg_temp.world_fp() as fp, pg_temp.tok() as tok;
do $$
declare b jsonb; t text := (select tok from world1);
begin
  b := pg_temp.blockers(pg_temp.edited(), t, 30);
  assert (b ->> 'ready')::boolean = false and (b ->> 'blocked_count')::int = 2, b::text;
  assert (b -> 'blockers') @> '[{"team_code":"T01","reason":"ACTIVE_QUESTION"},{"team_code":"T02","reason":"TEAM_TIMER_RUNNING"}]'::jsonb, b::text;
  assert not (b -> 'blockers') @> '[{"team_code":"T03"}]'::jsonb and not (b -> 'blockers') @> '[{"team_code":"T04"}]'::jsonb
     and not (b -> 'blockers') @> '[{"team_code":"T05"}]'::jsonb and not (b -> 'blockers') @> '[{"team_code":"T06"}]'::jsonb;
  assert pg_temp.world_fp() = (select fp from world1), 'a blocked renewal deleted and changed nothing';
  assert (select status from competition) = 'RUNNING', 'and left the lifecycle alone';
  assert (pg_temp.cur() #>> '{readiness,ready}')::boolean = false, 'the editor sees the same readiness';
end $$;

-- T01 submits (PENDING_APPROVAL, awaiting the approval workflow): no longer "solving". T02 still blocks.
select pg_temp.at('2026-12-01 12:02:00+00');
select pg_temp.submit(1, 1, 31);
do $$
declare b jsonb := app.renewal_readiness();
begin
  assert (b ->> 'blocked_count')::int = 1 and (b -> 'blockers') @> '[{"team_code":"T02","reason":"TEAM_TIMER_RUNNING"}]'::jsonb, b::text;
  assert (b ->> 'pending_submissions')::int = 1, 'the pending submission is reported (it is deleted with its team)';
end $$;
-- T02 enters Q1 and submits too: both teams are now "submitted, awaiting approval" -> nothing blocks
select pg_temp.enter(2, 1, 32);
select pg_temp.at('2026-12-01 12:03:00+00');
select pg_temp.submit(2, 1, 33);
do $$
declare b jsonb := app.renewal_readiness();
begin
  assert (b ->> 'ready')::boolean and (b ->> 'pending_submissions')::int = 2, b::text;
end $$;
-- the admin approves T02's Q1: Q2 becomes ACTIVE automatically -> T02 is solving again and blocks
select pg_temp.approve(3, 2, 1, 34);
do $$
declare b jsonb := app.renewal_readiness();
begin
  assert (b -> 'blockers') @> '[{"team_code":"T02","reason":"ACTIVE_QUESTION"}]'::jsonb and (b ->> 'blocked_count')::int = 1, b::text;
end $$;
-- the overall timer of T02 runs out (it is not persisted as ENDED yet): the team no longer blocks, ACTIVE question or not
select pg_temp.at('2026-12-01 16:01:30+00');
do $$
declare b jsonb := app.renewal_readiness();
begin
  assert (select status from teams where id = pg_temp.team_id(2)) = 'RUNNING' and exists (select 1 from team_questions where team_id = pg_temp.team_id(2) and state = 'ACTIVE');
  assert (b ->> 'ready')::boolean, 'an expired overall timer is "ran out": ' || b::text;
end $$;
-- a PAUSED competition freezes the clock: T02's timer is NOT expired again at the paused instant
select pg_temp.at('2026-12-01 12:30:00+00');
select pg_temp.status('pause', 35);
select pg_temp.at('2026-12-01 16:01:30+00');
do $$
declare b jsonb := app.renewal_readiness();
begin
  assert (b ->> 'blocked_count')::int = 1 and (b -> 'blockers') @> '[{"team_code":"T02","reason":"ACTIVE_QUESTION"}]'::jsonb, 'paused: the clock reads the pause instant: ' || b::text;
end $$;
select pg_temp.status('resume', 36);
select pg_temp.at('2026-12-01 20:30:00+00');
do $$ begin assert (app.renewal_readiness() ->> 'ready')::boolean, 'long after both timers'; end $$;

-- ===== 6. atomic rollback: a deletion that is blocked undoes EVERYTHING =====================================================
-- An ADMIN created by another ADMIN (impossible through the application; only by hand) cannot be reached by the Super Admin's
-- deletion (the foreign key staff_users.created_by stops deleting its creator): the existing pathway raises DELETE_BLOCKED and the
-- whole renewal must roll back — no admin or team deleted, no content published, lifecycle unchanged.
insert into staff_users (id, username, display_name, password_hash, role, created_by)
values (pg_temp.staff(9), 'test_odd_admin', 'Odd', 'TEST-NOT-A-HASH', 'ADMIN', pg_temp.staff(2));
create temp table world2 as select pg_temp.world_fp() as fp, pg_temp.tok() as tok;
do $$
declare t text := (select tok from world2);
begin
  perform pg_temp.rejects(format($s$select pg_temp.renew(%L::jsonb, %L, 40)$s$, pg_temp.edited()::text, t), 'DELETE_BLOCKED');
  assert pg_temp.world_fp() = (select fp from world2), 'rolled back: every table is exactly as before';
  assert pg_temp.tok() = t and (select status from competition) = 'RUNNING' and (select rules from competition) is null;
  assert (select count(*) from staff_users where role = 'ADMIN') = 3 and (select count(*) from teams) = 6;
  assert not exists (select 1 from request_log where idem_key = pg_temp.key(40)) and not exists (select 1 from audit_events where event_type = 'COMPETITION_RENEWED');
end $$;
delete from staff_users where id = pg_temp.staff(9);

-- ===== 7. a successful renewal ============================================================================================
-- unrelated rows that must survive: the Super Admin (and its session), an unrelated throttle key, the buy-time options and keys
insert into sessions (token_hash, kind, staff_id, expires_at) values (sha256(convert_to('renew-super-session', 'UTF8')), 'STAFF', pg_temp.staff(1), app.now() + interval '1 hour');
insert into sessions (token_hash, kind, staff_id, expires_at) values (sha256(convert_to('renew-admin-session', 'UTF8')), 'STAFF', pg_temp.staff(2), app.now() + interval '1 hour');
insert into auth_throttle (key, window_start, attempts) values ('staff:other', now(), 3), ('team:test_team_01', now(), 2);
select app.idem_store(pg_temp.staff(1), pg_temp.key(60), 'create_admin', 'unrelated', '{"x": 1}');
create temp table before_ok as
  select (select to_jsonb(s) from staff_users s where id = pg_temp.staff(1)) as super,
         (select count(*) from sessions where staff_id = pg_temp.staff(1)) as super_sessions,
         pg_temp.settings_fp() as sfp, pg_temp.tok() as tok,
         (select state_version from competition) as sv,
         (select count(*) from audit_events) as audits,
         (select count(*) from question_buy_time_options) as bto, (select count(*) from question_keys) as keys;
do $$
declare
  b record; r jsonb; again jsonb; e jsonb := pg_temp.edited(); t text; nteams int := (select count(*) from teams); nadm int := (select count(*) from staff_users where role = 'ADMIN');
  npend int := (select count(*) from submissions where status = 'PENDING');
begin
  select * into b from before_ok;
  t := b.tok;
  r := pg_temp.renew(e, t, 50);
  assert (r ->> 'replayed')::boolean = false;
  assert (r #>> '{deleted,admins}')::int = nadm and (r #>> '{deleted,teams}')::int = nteams, r::text;
  assert (r #>> '{competition,from}') = 'RUNNING' and (r #>> '{competition,to}') = 'SETUP';
  -- the pending submissions that went with their teams are counted in the same transaction and reported (the UI shows the number)
  assert npend >= 1 and (r #>> '{discarded,pending_submissions}')::int = npend, format('pending=%s result=%s', npend, r);

  -- deletion scope: every admin and every team (with everything they owned) is gone ...
  assert (select count(*) from staff_users where role = 'ADMIN') = 0 and (select count(*) from teams) = 0;
  assert (select count(*) from team_members) = 0 and (select count(*) from team_themes) = 0 and (select count(*) from team_questions) = 0
     and (select count(*) from submissions) = 0 and (select count(*) from coin_transactions) = 0 and (select count(*) from answer_drafts) = 0
     and (select count(*) from hint_purchases) = 0 and (select count(*) from team_time_purchases) = 0 and (select count(*) from ufm_challenges) = 0;
  assert (select count(*) from sessions where kind = 'MEMBER') = 0 and not exists (select 1 from sessions where staff_id = pg_temp.staff(2));
  assert not exists (select 1 from auth_throttle where key = 'team:test_team_01') and exists (select 1 from auth_throttle where key = 'staff:other');
  -- ... and the Super Admin, its session and unrelated records are untouched
  assert (select to_jsonb(s) from staff_users s where id = pg_temp.staff(1)) = b.super, 'the Super Admin row is byte-identical';
  assert (select count(*) from staff_users) = 1 and (select count(*) from sessions where staff_id = pg_temp.staff(1)) = b.super_sessions;
  assert exists (select 1 from request_log where team_id = pg_temp.staff(1) and idem_key = pg_temp.key(60)), 'the Super Admin''s own unrelated record is kept';
  assert (select count(*) from question_buy_time_options) = b.bto and (select count(*) from question_keys) = b.keys;
  assert (select count(*) from audit_events where event_type = 'TEAM_DELETED') = nteams and (select count(*) from audit_events where event_type = 'ADMIN_DELETED') = nadm,
         'the existing pathway audited every deletion';

  -- content: exactly what was submitted, in the DB, readable by the app
  assert app.renewal_content_json() = e, 'the database holds exactly the submitted content';
  assert (select body_md from questions where id = 1) = E'Q A.1 NEW\n\nFind $\\sum_{k=1}^{n} k$ — done?\n  indented line\n', 'multiline text, markdown and trailing newline are preserved byte for byte';
  assert (select name from themes where id = 1) = 'NEW “A” — Ünïcode ✓ & <b>' and (select description from themes where id = 1) like E'First line\nSecond line%日本語';
  assert (select reward_coins from questions where id = 1) = 777 and (select reward_coins from questions where id = 50) = 123456;
  assert (select body_md from hints where id = 1) = E'NEW TIER-1 A.1\nline two' and (select body_md from hints where id = 2) = 'NEW TIER-2 A.1 ✓';
  assert (public.get_competition_rules() -> 'rules') = (e -> 'rules') and jsonb_array_length(public.get_competition_rules() -> 'rules') = 3;
  assert pg_temp.settings_fp() = b.sfp, 'no gameplay setting, price, timer, id, difficulty, key or buy-time option changed';
  assert (r #>> '{changed,themes}')::int = 2 and (r #>> '{changed,questions}')::int = 2 and (r #>> '{changed,hints}')::int = 2, r::text;

  -- lifecycle: only what the next competition needs
  assert (select status from competition) = 'SETUP' and (select opened_at from competition) is null and (select paused_at from competition) is null
     and (select ended_at from competition) is null;
  assert (select state_version from competition) = b.sv + 1;
  assert (r ->> 'token') = pg_temp.tok() and (r ->> 'token') <> t;

  -- audit trail: one event, counts and tokens, no content text
  assert (select count(*) from audit_events where event_type = 'COMPETITION_RENEWED') = 1;
  assert (select payload ->> 'admins_deleted' from audit_events where event_type = 'COMPETITION_RENEWED') = nadm::text
     and (select payload ->> 'pending_submissions_discarded' from audit_events where event_type = 'COMPETITION_RENEWED') = '1'
     and (select payload ->> 'token_before' from audit_events where event_type = 'COMPETITION_RENEWED') = t
     and (select payload::text from audit_events where event_type = 'COMPETITION_RENEWED') not like '%Ünïcode%';

  -- idempotent replay: same key, same request -> the stored answer, no second deletion, no second audit row
  again := pg_temp.renew(e, t, 50);
  assert (again ->> 'replayed')::boolean and (again #>> '{deleted,admins}') = (r #>> '{deleted,admins}') and (again ->> 'token') = (r ->> 'token');
  assert (select count(*) from audit_events where event_type = 'COMPETITION_RENEWED') = 1 and (select state_version from competition) = b.sv + 1;
  -- the same key for a different request is refused, never silently replayed
  perform pg_temp.rejects(format($s$select pg_temp.renew(%L::jsonb, %L, 50)$s$, jsonb_set(e, '{rules}', '["other"]')::text, t), 'IDEMPOTENCY_KEY_REUSED');
  -- a second tab still holding the OLD token with a fresh key
  perform pg_temp.rejects(format($s$select pg_temp.renew(%L::jsonb, %L, 51)$s$, e::text, t), 'CONTENT_CHANGED');
end $$;

-- ===== 8. the next competition: provision, open, play, and get paid the NEW reward =========================================
do $$
declare r jsonb; ts jsonb; q jsonb; sid uuid; tid uuid; mid uuid; bal int;
begin
  perform public.create_admin(pg_temp.staff(1), 'next_admin', 'next-admin-pw-1', pg_temp.key(70));
  perform public.create_team((select id from staff_users where username = 'next_admin'), 'N1', 'Next Team', 'next_team_1', 'next-team-pass-1',
                             array['NX1', 'NX2', 'NX3', 'NX4'], pg_temp.key(71));
  tid := (select id from teams where team_code = 'N1');
  mid := (select id from team_members where team_id = tid and slot = 1);
  perform pg_temp.at('2026-12-02 09:00:00+00');
  r := pg_temp.status('open', 72);                                                     -- the EXISTING workflow
  assert (r #>> '{competition,status}') = 'RUNNING' and (r ->> 'changed')::boolean;
  perform public.start_team_competition(tid, mid, pg_temp.key(73));
  ts := public.unlock_theme(tid, mid, 1::smallint, pg_temp.key(74));
  assert (ts #>> '{state,themes,0,name}') = 'NEW “A” — Ünïcode ✓ & <b>', 'the snapshot carries the new theme name';
  assert (ts #>> '{state,themes,0,description}') like E'First line\nSecond line%', 'and the new description';
  q := public.start_question(tid, mid, 1::smallint, pg_temp.key(75));
  q := public.get_question_for_team(tid, mid, 1::smallint);
  assert q::text like '%Q A.1 NEW%', 'the participant reads the new question: ' || q::text;
  perform public.submit_answer(tid, mid, 1::smallint, 'ans', 'because', pg_temp.key(76));
  sid := (select id from submissions where team_id = tid and question_id = 1);
  bal := (select coins from teams where id = tid);
  perform public.approve_submission((select id from staff_users where username = 'next_admin'), sid, pg_temp.key(77));
  assert (select coins from teams where id = tid) = bal + 777, 'approval pays the NEW reward';
  assert (select amount from coin_transactions where team_id = tid and type = 'QUESTION_REWARD') = 777;
  assert (select reward_awarded from submissions where id = sid) = 777;
end $$;

-- ===== 9. renewing from ENDED (terminal today), with more than 100 admins ===================================================
select pg_temp.status('end', 80);
insert into staff_users (username, display_name, password_hash, role, created_by)
select 'bulk_admin_' || g, 'Bulk ' || g, 'TEST-NOT-A-HASH', 'ADMIN', pg_temp.staff(1) from generate_series(1, 205) g;
do $$
declare r jsonb; e jsonb := jsonb_set(pg_temp.edited(), '{rules}', '["only rule"]');
begin
  assert (select status from competition) = 'ENDED' and (select ended_at from competition) is not null;
  perform pg_temp.rejects($s$select pg_temp.status('open', 81)$s$, 'INVALID_COMPETITION_TRANSITION');      -- why a reset is needed at all
  r := pg_temp.renew(e, pg_temp.tok(), 82);
  assert (r #>> '{deleted,admins}')::int = 206 and (r #>> '{deleted,teams}')::int = 1, r::text;          -- 205 + next_admin, in chunks of 100
  assert (select count(*) from staff_users) = 1 and (select count(*) from teams) = 0;
  assert (select status from competition) = 'SETUP' and (select ended_at from competition) is null and (select opened_at from competition) is null;
  assert (select jsonb_array_length(rules) from competition) = 1;
  -- nothing to delete, same content: still fine, deletes nothing, changes nothing
  r := pg_temp.renew(e, pg_temp.tok(), 83);
  assert (r #>> '{deleted,admins}')::int = 0 and (r #>> '{changed,themes}')::int = 0 and (r #>> '{changed,questions}')::int = 0 and (r #>> '{changed,hints}')::int = 0, r::text;
  assert (select status from competition) = 'SETUP';
  -- the next competition can be provisioned and opened again
  perform pg_temp.rejects($s$select pg_temp.status('open', 84)$s$, 'COMPETITION_NOT_READY');            -- no team yet: the ordinary guard applies
  perform public.create_admin(pg_temp.staff(1), 'third_admin', 'third-admin-pw-1', pg_temp.key(85));
  perform public.create_team((select id from staff_users where username = 'third_admin'), 'M1', 'Third Team', 'third_team_1', 'third-team-pass-1',
                             array['TX1', 'TX2', 'TX3', 'TX4'], pg_temp.key(86));
  assert (pg_temp.status('open', 87) #>> '{competition,status}') = 'RUNNING';
end $$;

-- ===== 10. privileges: service_role only ===================================================================================
do $$
declare f text;
begin
  foreach f in array array['public.get_renewal_content(uuid)', 'public.get_competition_rules()', 'public.renew_competition(uuid,jsonb,text,uuid)',
                           'app.renewal_content_json()', 'app.renewal_content_token()', 'app.renewal_readiness()',
                           'app.renewal_content_problems(jsonb)', 'app.renewal_themes(jsonb)', 'app.renewal_questions(jsonb)'] loop
    assert not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute')
       and not has_function_privilege('public', f, 'execute'), f || ' must not be executable by anon / authenticated / public';
  end loop;
  assert has_function_privilege('service_role', 'public.renew_competition(uuid,jsonb,text,uuid)', 'execute')
     and has_function_privilege('service_role', 'public.get_renewal_content(uuid)', 'execute')
     and has_function_privilege('service_role', 'public.get_competition_rules()', 'execute');
end $$;

rollback;
