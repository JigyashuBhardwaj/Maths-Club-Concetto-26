-- Gameplay engine (migration 14): team-wide theme unlock, server-side start_question, server-backed drafts, submit,
-- the controlled approval path, the fixed reward, next-question activation, timeouts, the participant-safe question
-- read, idempotency, privileges. The multi-connection races are in supabase/tests/concurrency/team_play.concurrency.mjs.
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
create function pg_temp.start(t int, s int, n int) returns jsonb language sql as
  $$ select public.start_team_competition(pg_temp.team_id(t), pg_temp.member_id(t, s), pg_temp.key(n)) $$;
create function pg_temp.unlock(t int, s int, theme int, n int) returns jsonb language sql as
  $$ select public.unlock_theme(pg_temp.team_id(t), pg_temp.member_id(t, s), theme::smallint, pg_temp.key(n)) $$;
create function pg_temp.enter(t int, s int, q int, n int) returns jsonb language sql as
  $$ select public.start_question(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint, pg_temp.key(n)) $$;
create function pg_temp.q(t int, s int, q int) returns jsonb language sql as
  $$ select public.get_question_for_team(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint)->'question' $$;
create function pg_temp.draft(t int, s int, q int, a text, v int) returns jsonb language sql as
  $$ select public.save_draft(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint, a, v, '') $$;
create function pg_temp.submit(t int, s int, q int, a text, n int) returns jsonb language sql as
  $$ select public.submit_answer(pg_temp.team_id(t), pg_temp.member_id(t, s), q::smallint, a, 'because', pg_temp.key(n)) $$;
create function pg_temp.approve(who uuid, sub uuid, n int) returns jsonb language sql as
  $$ select public.approve_submission(who, sub, pg_temp.key(n)) $$;
create function pg_temp.state(t int, s int) returns jsonb language sql as
  $$ select public.get_team_state(pg_temp.team_id(t), pg_temp.member_id(t, s)) $$;
create function pg_temp.tq(t int, q int) returns team_questions language sql as
  $$ select * from team_questions where team_id = pg_temp.team_id(t) and question_id = q $$;
create function pg_temp.coins(t int) returns int language sql as $$ select coins from teams where id = pg_temp.team_id(t) $$;
create function pg_temp.tv(t int) returns bigint language sql as $$ select state_version from teams where id = pg_temp.team_id(t) $$;
create function pg_temp.sub(t int, q int) returns uuid language sql as
  $$ select id from submissions where team_id = pg_temp.team_id(t) and question_id = q and status = 'PENDING' $$;
create function pg_temp.ms(ts text) returns bigint language sql as $$ select (extract(epoch from ts::timestamptz) * 1000)::bigint $$;

-- ===== 1. nothing is playable before the competition runs and the team has started ==================================
select pg_temp.rejects($s$select pg_temp.unlock(1, 1, 1, 1)$s$, 'COMPETITION_NOT_RUNNING');
select pg_temp.status('open', 2);
select pg_temp.rejects($s$select pg_temp.unlock(1, 1, 1, 1)$s$, 'TEAM_NOT_STARTED');
select pg_temp.rejects($s$select pg_temp.enter(1, 1, 1, 3)$s$, 'TEAM_NOT_STARTED');
select pg_temp.at('2026-12-01 12:00:00+00');
select pg_temp.start(1, 1, 4);
select pg_temp.start(2, 1, 5);
do $$ begin
  assert (select ends_at from teams where id = pg_temp.team_id(1)) = timestamptz '2026-12-01 16:00:00+00',
    'the team timer is exactly 14400 s from the first valid member';
  assert (select count(*) from team_themes) = 0 and (select count(*) from team_questions) = 0, 'entering the competition unlocks nothing';
end $$;

-- ===== 2. unlock: team-wide, charged once, Q1 AVAILABLE with no timer ===============================================
select pg_temp.rejects($s$select pg_temp.unlock(1, 1, 99, 10)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.unlock_theme(pg_temp.team_id(1), pg_temp.member_id(2, 1), 1::smallint, pg_temp.key(10))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.unlock_theme(pg_temp.team_id(1), gen_random_uuid(), 1::smallint, pg_temp.key(10))$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select public.unlock_theme(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, null)$s$, 'VALIDATION_FAILED');
create temp table v0 as select pg_temp.tv(1) as tv1, pg_temp.tv(2) as tv2;
select pg_temp.at('2026-12-01 12:01:00+00');
create temp table u1 as select pg_temp.unlock(1, 3, 1, 11) as j;       -- member 3 unlocks theme 1
do $$
declare j jsonb := (select j from u1);
begin
  assert not (j->>'replayed')::boolean and (j->>'theme_id')::int = 1;
  assert pg_temp.coins(1) = 400, 'unlock_cost (100) charged exactly once';
  assert (select count(*) from team_themes where team_id = pg_temp.team_id(1) and theme_id = 1) = 1;
  assert (select unlocked_by = pg_temp.member_id(1, 3) and cost_paid = 100 from team_themes where team_id = pg_temp.team_id(1) and theme_id = 1);
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'THEME_UNLOCK' and amount = -100 and balance_after = 400) = 1;
  assert (select count(*) from team_questions where team_id = pg_temp.team_id(1) and theme_id = 1) = 5;
  assert (pg_temp.tq(1, 1)).state = 'AVAILABLE' and (pg_temp.tq(1, 1)).timer_deadline is null and (pg_temp.tq(1, 1)).activated_at is null,
    'Q1 is AVAILABLE and its timer has NOT started';
  assert (select count(*) from team_questions where team_id = pg_temp.team_id(1) and theme_id = 1 and state = 'LOCKED' and ordinal > 1) = 4, 'Q2..Q5 stay LOCKED';
  assert pg_temp.tv(1) = (select tv1 from v0) + 1, 'state_version moved once';
  assert pg_temp.tv(2) = (select tv2 from v0) and pg_temp.coins(2) = 500, 'the other team is untouched';
  assert (select count(*) from audit_events where event_type = 'THEME_UNLOCKED' and team_id = pg_temp.team_id(1)) = 1;
  -- team-wide: another member sees the unlock in the snapshot
  assert (select (e->>'status') = 'IN_PROGRESS' from jsonb_array_elements(pg_temp.state(1, 4)->'themes') e where (e->>'id')::int = 1);
  assert (select (e->>'status') = 'LOCKED' from jsonb_array_elements(pg_temp.state(1, 4)->'themes') e where (e->>'id')::int = 2);
  assert (pg_temp.state(1, 4)->'team'->>'coins')::int = 400;
  assert (select e->'questions'->0->>'state' = 'AVAILABLE' and e->'questions'->1->>'state' = 'LOCKED'
            from jsonb_array_elements(pg_temp.state(1, 2)->'themes') e where (e->>'id')::int = 1);
end $$;
-- retry of the same request: replayed, nothing moves
do $$ declare j jsonb; v bigint := pg_temp.tv(1); begin
  j := pg_temp.unlock(1, 3, 1, 11);
  assert (j->>'replayed')::boolean;
  assert pg_temp.coins(1) = 400 and pg_temp.tv(1) = v and (select count(*) from team_themes where team_id = pg_temp.team_id(1)) = 1;
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'THEME_UNLOCK') = 1;
end $$;
-- a second member unlocking the same theme with a different key: rejected, no second charge
select pg_temp.rejects($s$select pg_temp.unlock(1, 1, 1, 12)$s$, 'THEME_ALREADY_UNLOCKED');
-- the same key reused for a different theme is a conflict, never a silent replay
select pg_temp.rejects($s$select pg_temp.unlock(1, 3, 2, 11)$s$, 'IDEMPOTENCY_KEY_REUSED');
do $$ begin
  assert pg_temp.coins(1) = 400 and (select count(*) from team_themes where team_id = pg_temp.team_id(1)) = 1;
end $$;
-- insufficient coins: 500 coins buys five themes, the sixth is refused without touching anything
select pg_temp.unlock(2, 1, 1, 20); select pg_temp.unlock(2, 2, 2, 21); select pg_temp.unlock(2, 3, 3, 22);
select pg_temp.unlock(2, 4, 4, 23); select pg_temp.unlock(2, 1, 5, 24);
select pg_temp.rejects($s$select pg_temp.unlock(2, 1, 6, 25)$s$, 'INSUFFICIENT_COINS');
do $$ begin
  assert pg_temp.coins(2) = 0 and (select count(*) from team_themes where team_id = pg_temp.team_id(2)) = 5;
  assert not exists (select 1 from team_themes where team_id = pg_temp.team_id(2) and theme_id = 6);
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(2) and type = 'THEME_UNLOCK') = 5;
end $$;
-- the INSUFFICIENT_COINS detail carries have/need only
do $$ declare d text; begin
  begin perform pg_temp.unlock(2, 1, 6, 26);
  exception when others then get stacked diagnostics d = pg_exception_detail;
    assert (d::jsonb->>'have')::int = 0 and (d::jsonb->>'need')::int = 100, d;
  end;
end $$;

-- ===== 3. the participant-safe question read ========================================================================
do $$
declare j jsonb;
begin
  j := pg_temp.q(1, 2, 1);                                         -- AVAILABLE: metadata only
  assert j->>'state' = 'AVAILABLE' and (j->>'reward_coins')::int = 50 and (j->>'time_limit_seconds')::int = 240;
  assert not (j ? 'body_md') and not (j ? 'draft') and not (j ? 'deadline'), 'an AVAILABLE question exposes no body until it is entered';
  assert j::text not like '%PLACEHOLDER%', 'no question text at all';
end $$;
select pg_temp.rejects($s$select pg_temp.q(1, 1, 2)$s$, 'QUESTION_NOT_ACTIVE');                  -- LOCKED Q2 of an unlocked theme
select pg_temp.rejects($s$select pg_temp.q(1, 1, 6)$s$, 'THEME_LOCKED');                         -- theme 2 not unlocked
select pg_temp.rejects($s$select pg_temp.q(1, 1, 999)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.get_question_for_team(pg_temp.team_id(1), pg_temp.member_id(2, 1), 1::smallint)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.enter(1, 1, 2, 30)$s$, 'QUESTION_NOT_AVAILABLE');        -- Q2 is LOCKED
select pg_temp.rejects($s$select pg_temp.enter(1, 1, 6, 30)$s$, 'THEME_LOCKED');
select pg_temp.rejects($s$select pg_temp.enter(1, 1, 999, 30)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.start_question(pg_temp.team_id(1), pg_temp.member_id(2, 1), 1::smallint, pg_temp.key(30))$s$, 'FORBIDDEN');
-- no draft may be saved before the question is entered
select pg_temp.rejects($s$select pg_temp.draft(1, 1, 1, 'early', 0)$s$, 'QUESTION_NOT_ACTIVE');
select pg_temp.rejects($s$select pg_temp.submit(1, 1, 1, 'early', 31)$s$, 'QUESTION_NOT_ACTIVE');

-- ===== 4. start_question: AVAILABLE -> ACTIVE exactly once, one deadline for the whole team ==========================
select pg_temp.at('2026-12-01 12:05:00+00');
create temp table e1 as select pg_temp.enter(1, 2, 1, 40) as j;     -- member 2 enters Q1
do $$
declare j jsonb := (select j from e1); v bigint;
begin
  assert (j->>'started_now')::boolean and not (j->>'replayed')::boolean;
  assert (pg_temp.tq(1, 1)).state = 'ACTIVE' and (pg_temp.tq(1, 1)).activated_at = timestamptz '2026-12-01 12:05:00+00';
  assert (pg_temp.tq(1, 1)).timer_deadline = timestamptz '2026-12-01 12:09:00+00', 'the question timer starts at activation: now + time limit';
  assert (j->'question'->>'state') = 'ACTIVE' and (j->'question'->>'deadline')::bigint = pg_temp.ms('2026-12-01 12:09:00+00');
  assert j->'question' ? 'body_md', 'the body is delivered once the question is ACTIVE';
  assert (select count(*) from audit_events where event_type = 'QUESTION_STARTED' and team_id = pg_temp.team_id(1)) = 1;
  -- the team timer is a separate clock: 14400 s from 12:00, untouched by the question
  assert (select ends_at from teams where id = pg_temp.team_id(1)) = timestamptz '2026-12-01 16:00:00+00';
  -- a second member entering later gets the SAME deadline and nothing restarts
  perform pg_temp.at('2026-12-01 12:06:00+00');
  v := pg_temp.tv(1);
  j := pg_temp.enter(1, 4, 1, 41);
  assert not (j->>'started_now')::boolean and (j->'question'->>'deadline')::bigint = pg_temp.ms('2026-12-01 12:09:00+00');
  assert (pg_temp.tq(1, 1)).timer_deadline = timestamptz '2026-12-01 12:09:00+00' and pg_temp.tv(1) = v, 'a second entry is a no-op';
  -- a retried request replays
  j := pg_temp.enter(1, 2, 1, 40);
  assert (j->>'replayed')::boolean and (j->'question'->>'deadline')::bigint = pg_temp.ms('2026-12-01 12:09:00+00');
  assert (select count(*) from audit_events where event_type = 'QUESTION_STARTED' and team_id = pg_temp.team_id(1)) = 1;
  -- the read agrees, with the remaining time derived from the server clock
  j := pg_temp.q(1, 3, 1);
  assert (j->>'remaining_seconds')::int = 180 and j->>'state' = 'ACTIVE';
end $$;
-- theme 1 of team 2 keeps its own, independent state (no ACTIVE question there)
do $$ begin
  assert not exists (select 1 from team_questions where team_id = pg_temp.team_id(2) and state = 'ACTIVE');
end $$;

-- ===== 5. server-backed drafts: shared, compare-and-set =============================================================
select pg_temp.at('2026-12-01 12:06:30+00');
do $$ declare j jsonb; begin
  j := pg_temp.draft(1, 2, 1, 'x = 4', 0);
  assert (j->>'version')::int = 1 and (j->>'updated_by_slot')::int = 2;
  assert (select answer from answer_drafts where team_id = pg_temp.team_id(1) and question_id = 1) = 'x = 4';
  -- another member sees it
  assert pg_temp.q(1, 4, 1)->'draft'->>'answer' = 'x = 4' and (pg_temp.q(1, 4, 1)->'draft'->>'version')::int = 1;
  -- member 4 builds on it
  j := pg_temp.draft(1, 4, 1, 'x = 4, y = 5', 1);
  assert (j->>'version')::int = 2 and (j->>'updated_by_slot')::int = 4;
  -- a stale write is refused and does not overwrite
  assert (select answer from answer_drafts where team_id = pg_temp.team_id(1) and question_id = 1) = 'x = 4, y = 5';
  -- saving identical content again is harmless and returns the current version
  j := pg_temp.draft(1, 2, 1, 'x = 4, y = 5', 1);
  assert (j->>'version')::int = 2, 'identical content under a stale version is not a conflict';
end $$;
select pg_temp.rejects($s$select pg_temp.draft(1, 2, 1, 'stale overwrite', 1)$s$, 'STALE_DRAFT');
select pg_temp.rejects($s$select pg_temp.draft(1, 2, 1, repeat('a', 10001), 2)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select pg_temp.draft(1, 2, 1, 'x', null)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.save_draft(pg_temp.team_id(1), pg_temp.member_id(2, 1), 1::smallint, 'x', 2, '')$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.draft(1, 2, 2, 'x', 0)$s$, 'QUESTION_NOT_ACTIVE');       -- Q2 is LOCKED
do $$ begin
  assert (select version from answer_drafts where team_id = pg_temp.team_id(1) and question_id = 1) = 2;
  assert not exists (select 1 from answer_drafts where team_id = pg_temp.team_id(2)), 'team 2 has no draft: drafts are per team';
  assert (select count(*) from audit_events where team_id = pg_temp.team_id(1) and event_type like 'DRAFT%') = 0, 'autosave is not audited';
end $$;

-- ===== 6. submit: PENDING_APPROVAL, the question timer freezes, the team timer keeps running =========================
select pg_temp.rejects($s$select pg_temp.submit(1, 1, 1, '   ', 50)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.submit_answer(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint, 'a', 'b', null)$s$, 'VALIDATION_FAILED');
select pg_temp.rejects($s$select public.submit_answer(pg_temp.team_id(1), pg_temp.member_id(2, 1), 1::smallint, 'a', 'b', pg_temp.key(50))$s$, 'FORBIDDEN');
select pg_temp.at('2026-12-01 12:07:00+00');
create temp table s1 as select pg_temp.submit(1, 3, 1, 'x = 4, y = 5', 51) as j;
do $$
declare j jsonb := (select j from s1); v bigint;
begin
  assert not (j->>'replayed')::boolean and j->'question'->>'state' = 'PENDING_APPROVAL';
  assert (pg_temp.tq(1, 1)).state = 'PENDING_APPROVAL' and (pg_temp.tq(1, 1)).timer_deadline is null
         and (pg_temp.tq(1, 1)).timer_remaining_seconds = 120, 'frozen at 12:09:00 - 12:07:00 = 120 s';
  assert (select count(*) from submissions where team_id = pg_temp.team_id(1) and question_id = 1 and status = 'PENDING' and member_id = pg_temp.member_id(1, 3)) = 1,
    'the submission records the submitting member';
  assert (select answer = 'x = 4, y = 5' and explanation = 'because' from submissions where team_id = pg_temp.team_id(1) and question_id = 1);
  assert (select count(*) from audit_events where event_type = 'ANSWER_SUBMITTED' and team_id = pg_temp.team_id(1)) = 1;
  assert (j->'question'->'submission'->>'status') = 'PENDING';
  assert (j->'question'->>'remaining_seconds')::int = 120;
  -- time passes: the question stays frozen, the team clock moves on
  perform pg_temp.at('2026-12-01 12:30:00+00');
  assert (pg_temp.state(1, 1)->'team'->>'remaining_seconds')::int = 12600, 'team timer: 16:00 - 12:30';
  assert (select e->'questions'->0->>'state' = 'PENDING_APPROVAL' and (e->'questions'->0->>'remaining_seconds')::int = 120
            from jsonb_array_elements(pg_temp.state(1, 1)->'themes') e where (e->>'id')::int = 1), 'question timer still frozen at 120';
  assert pg_temp.q(1, 2, 1)->>'state' = 'PENDING_APPROVAL' and (pg_temp.q(1, 2, 1)->>'remaining_seconds')::int = 120;
  -- a retry replays, a second submission is refused
  v := pg_temp.tv(1);
  j := pg_temp.submit(1, 3, 1, 'x = 4, y = 5', 51);
  assert (j->>'replayed')::boolean and pg_temp.tv(1) = v;
  assert (select count(*) from submissions where team_id = pg_temp.team_id(1) and question_id = 1) = 1, 'a retried submit creates no duplicate';
end $$;
select pg_temp.rejects($s$select pg_temp.submit(1, 1, 1, 'another try', 52)$s$, 'SUBMISSION_PENDING');
select pg_temp.rejects($s$select pg_temp.draft(1, 1, 1, 'edit while pending', 3)$s$, 'QUESTION_NOT_ACTIVE');
select pg_temp.rejects($s$select pg_temp.enter(1, 1, 2, 53)$s$, 'QUESTION_NOT_AVAILABLE');        -- Q2 stays LOCKED until Q1 is approved
do $$ begin
  assert (pg_temp.tq(1, 2)).state = 'LOCKED';
  assert (select count(*) from submissions where team_id = pg_temp.team_id(2)) = 0, 'no cross-team submission';
end $$;

-- ===== 7. approval: authorised reviewers only, the fixed reward once, the next question starts =======================
select pg_temp.rejects($s$select pg_temp.approve(pg_temp.staff(3), pg_temp.sub(1, 1), 60)$s$, 'NOT_FOUND');               -- the other team's admin
select pg_temp.rejects($s$select pg_temp.approve(pg_temp.member_id(1, 1), pg_temp.sub(1, 1), 60)$s$, 'FORBIDDEN');        -- a participant id
select pg_temp.rejects($s$select pg_temp.approve(gen_random_uuid(), pg_temp.sub(1, 1), 60)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.approve(null, pg_temp.sub(1, 1), 60)$s$, 'FORBIDDEN');
select pg_temp.rejects($s$select pg_temp.approve(pg_temp.staff(2), gen_random_uuid(), 60)$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.approve_submission(pg_temp.staff(2), pg_temp.sub(1, 1), null)$s$, 'VALIDATION_FAILED');
update staff_users set is_active = false where id = pg_temp.staff(2);
select pg_temp.rejects($s$select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 1), 60)$s$, 'FORBIDDEN');              -- disabled admin
update staff_users set is_active = true where id = pg_temp.staff(2);
do $$ begin
  assert (pg_temp.tq(1, 1)).state = 'PENDING_APPROVAL' and pg_temp.coins(1) = 400, 'no rejected attempt changed anything';
end $$;
select pg_temp.at('2026-12-01 12:40:00+00');
create temp table a1 as select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 1), 61) as j;
do $$
declare j jsonb := (select j from a1); v bigint;
begin
  assert not (j->>'replayed')::boolean and (j->>'reward_awarded')::int = 50 and (j->>'next_question_activated')::boolean;
  assert (pg_temp.tq(1, 1)).state = 'APPROVED' and (pg_temp.tq(1, 1)).approved_at = timestamptz '2026-12-01 12:40:00+00';
  assert pg_temp.coins(1) = 450, 'the fixed reward (50) is paid';
  assert (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'QUESTION_REWARD' and amount = 50 and balance_after = 450) = 1;
  assert (select status = 'APPROVED' and reward_awarded = 50 and reviewed_by = pg_temp.staff(2) from submissions where team_id = pg_temp.team_id(1) and question_id = 1);
  -- the next question starts with its own deadline; the previous one's timer is not reused
  assert (pg_temp.tq(1, 2)).state = 'ACTIVE' and (pg_temp.tq(1, 2)).timer_deadline = timestamptz '2026-12-01 12:44:00+00'
         and (pg_temp.tq(1, 2)).activated_at = timestamptz '2026-12-01 12:40:00+00';
  assert (pg_temp.tq(1, 3)).state = 'LOCKED', 'only the next question opens';
  assert pg_temp.q(1, 4, 1)->>'state' = 'APPROVED' and pg_temp.q(1, 4, 1) ? 'body_md';
  assert (pg_temp.q(1, 4, 1)->'submission'->>'reward_awarded')::int = 50;
  assert (select count(*) from audit_events where event_type = 'SUBMISSION_APPROVED' and team_id = pg_temp.team_id(1)) = 1;
  -- a retry replays; a second approval with a new key is refused; the reward is never paid twice
  v := pg_temp.tv(1);
  j := pg_temp.approve(pg_temp.staff(2), (select id from submissions where team_id = pg_temp.team_id(1) and question_id = 1), 61);
  assert (j->>'replayed')::boolean and pg_temp.coins(1) = 450 and pg_temp.tv(1) = v;
end $$;
select pg_temp.rejects($s$select pg_temp.approve(pg_temp.staff(2), (select id from submissions where team_id = pg_temp.team_id(1) and question_id = 1), 62)$s$, 'SUBMISSION_NOT_PENDING');
select pg_temp.rejects($s$select public.disapprove_submission(pg_temp.staff(2), (select id from submissions where team_id = pg_temp.team_id(1) and question_id = 1), 'too late', pg_temp.key(63))$s$, 'SUBMISSION_NOT_PENDING');
do $$ begin
  assert pg_temp.coins(1) = 450 and (select count(*) from coin_transactions where team_id = pg_temp.team_id(1) and type = 'QUESTION_REWARD') = 1;
end $$;
-- a Super Admin may review any team
select pg_temp.at('2026-12-01 12:41:00+00');
select pg_temp.submit(1, 1, 2, 'second answer', 70);
do $$ begin
  assert (pg_temp.tq(1, 2)).timer_remaining_seconds = 180;
  perform pg_temp.approve(pg_temp.staff(1), pg_temp.sub(1, 2), 71);
  assert (pg_temp.tq(1, 2)).state = 'APPROVED' and (pg_temp.tq(1, 3)).state = 'ACTIVE' and pg_temp.coins(1) = 500;
end $$;

-- ===== 8. disapproval keeps the draft and returns the question to ACTIVE with the frozen time =======================
select pg_temp.at('2026-12-01 12:42:00+00');
select pg_temp.submit(1, 2, 3, 'wrong guess', 80);                    -- Q3 activated 12:41, deadline 12:45 -> 180 s left
create temp table tq3 as select (pg_temp.tq(1, 3)).timer_remaining_seconds as rem;
select pg_temp.at('2026-12-01 12:50:00+00');
do $$
declare v_sub uuid := pg_temp.sub(1, 3); j jsonb;
begin
  assert (select rem from tq3) = 180;
  j := public.disapprove_submission(pg_temp.staff(2), v_sub, 'Check the units', pg_temp.key(81));
  assert not (j->>'replayed')::boolean and j->'submission'->>'status' = 'REJECTED';
  assert (select status = 'REJECTED' and review_note = 'Check the units' and reward_awarded is null from submissions where id = v_sub);
  assert (pg_temp.tq(1, 3)).state = 'ACTIVE' and (pg_temp.tq(1, 3)).timer_deadline = timestamptz '2026-12-01 12:53:00+00',
    'the question resumes with the frozen remaining time from the moment of disapproval';
  assert pg_temp.coins(1) = 500, 'no coins move on disapproval';
  assert (select answer from answer_drafts where team_id = pg_temp.team_id(1) and question_id = 3) = 'wrong guess', 'the draft is kept';
  assert pg_temp.q(1, 1, 3)->'last_rejection'->>'note' = 'Check the units';
  assert not (pg_temp.q(1, 1, 3) ? 'submission'), 'a rejected submission is no longer the live one';
  assert (select count(*) from audit_events where event_type = 'SUBMISSION_REJECTED' and team_id = pg_temp.team_id(1)) = 1;
  -- retry replays
  j := public.disapprove_submission(pg_temp.staff(2), v_sub, 'Check the units', pg_temp.key(81));
  assert (j->>'replayed')::boolean;
  -- the team can submit again
  perform pg_temp.submit(1, 1, 3, 'right guess', 82);
  assert (select count(*) from submissions where team_id = pg_temp.team_id(1) and question_id = 3) = 2;
end $$;
select pg_temp.rejects($s$select public.disapprove_submission(pg_temp.staff(3), pg_temp.sub(1, 3), 'x', pg_temp.key(83))$s$, 'NOT_FOUND');
select pg_temp.rejects($s$select public.disapprove_submission(pg_temp.staff(2), pg_temp.sub(1, 3), repeat('n', 501), pg_temp.key(83))$s$, 'VALIDATION_FAILED');

-- ===== 9. timeouts: derived on read, materialised by the next successful mutation, submit refused ===================
-- Q3 is PENDING_APPROVAL (frozen). Approve it, then let Q4 run out.
select pg_temp.approve(pg_temp.staff(2), pg_temp.sub(1, 3), 90);
select pg_temp.at('2026-12-01 12:51:00+00');
do $$ begin
  assert (pg_temp.tq(1, 4)).state = 'ACTIVE' and (pg_temp.tq(1, 4)).timer_deadline = timestamptz '2026-12-01 12:54:00+00';
end $$;
select pg_temp.at('2026-12-01 12:54:01+00');
do $$ declare v bigint := pg_temp.tv(1); begin
  -- a pure read reports TIMED_OUT but writes nothing
  assert pg_temp.q(1, 1, 4)->>'state' = 'TIMED_OUT' and not (pg_temp.q(1, 1, 4) ? 'deadline');
  assert (select e->'questions'->3->>'state' = 'TIMED_OUT' from jsonb_array_elements(pg_temp.state(1, 1)->'themes') e where (e->>'id')::int = 1);
  assert (select e->>'status' = 'FAILED' from jsonb_array_elements(pg_temp.state(1, 1)->'themes') e where (e->>'id')::int = 1);
  assert (pg_temp.tq(1, 4)).state = 'ACTIVE' and pg_temp.tv(1) = v, 'reads never write';
end $$;
select pg_temp.rejects($s$select pg_temp.submit(1, 1, 4, 'too late', 91)$s$, 'QUESTION_TIMED_OUT');
select pg_temp.rejects($s$select pg_temp.draft(1, 1, 4, 'too late', 0)$s$, 'QUESTION_TIMED_OUT');
select pg_temp.rejects($s$select pg_temp.enter(1, 1, 4, 92)$s$, 'QUESTION_NOT_AVAILABLE');
do $$ begin
  assert not exists (select 1 from submissions where team_id = pg_temp.team_id(1) and question_id = 4), 'a late submit stored nothing';
end $$;
-- a successful mutation (another unlock) materialises the timeout
select pg_temp.unlock(1, 2, 2, 93);
do $$ begin
  assert (pg_temp.tq(1, 4)).state = 'TIMED_OUT' and (pg_temp.tq(1, 4)).timed_out_at = timestamptz '2026-12-01 12:54:00+00' and (pg_temp.tq(1, 4)).timer_deadline is null,
    'timed out at its deadline, not at the moment it was noticed';
  assert (select count(*) from audit_events where event_type = 'QUESTION_TIMED_OUT' and team_id = pg_temp.team_id(1)) = 1;
  assert (pg_temp.tq(1, 5)).state = 'LOCKED', 'Q5 never opens behind a timed-out Q4';
end $$;

-- ===== 10. two themes: independent question timers, independent from the team timer ================================
do $$ declare e jsonb; begin
  e := pg_temp.enter(1, 3, 6, 100);                                  -- theme 2, Q1
  assert (e->'question'->>'deadline')::bigint = pg_temp.ms('2026-12-01 12:58:01+00'), 'its own deadline, now + 240';
  assert (pg_temp.tq(1, 6)).state = 'ACTIVE';
  -- a different theme's timeout does not touch this one, and both teams' clocks stay separate
  assert (select ends_at from teams where id = pg_temp.team_id(1)) = timestamptz '2026-12-01 16:00:00+00';
  assert (select ends_at from teams where id = pg_temp.team_id(2)) = timestamptz '2026-12-01 16:00:00+00';
end $$;
-- a second ACTIVE question in another theme at the same time is legal
select pg_temp.unlock(1, 1, 3, 101);
select pg_temp.at('2026-12-01 13:00:00+00');
do $$ begin
  perform pg_temp.enter(1, 1, 11, 102);
  assert (select count(*) from team_questions where team_id = pg_temp.team_id(1) and state = 'ACTIVE' and ordinal = 1) = 1;
  assert (pg_temp.tq(1, 6)).state = 'TIMED_OUT' and (pg_temp.tq(1, 6)).timed_out_at = timestamptz '2026-12-01 12:58:01+00', 'theme 2 ran its own clock to its own deadline';
  assert (pg_temp.tq(1, 11)).state = 'ACTIVE' and (pg_temp.tq(1, 11)).timer_deadline = timestamptz '2026-12-01 13:04:00+00';
end $$;

-- ===== 11. isolation: team 2 sees nothing of team 1 =================================================================
select pg_temp.rejects($s$select pg_temp.q(2, 1, 26)$s$, 'THEME_LOCKED');
do $$
declare j jsonb;
begin
  j := pg_temp.enter(2, 1, 1, 110);
  assert (j->>'started_now')::boolean;
  assert (pg_temp.tq(2, 1)).timer_deadline = timestamptz '2026-12-01 13:04:00+00', 'team 2 has its own deadline';
  j := pg_temp.q(2, 1, 1);
  assert j->'draft'->>'answer' = '' and (j->'draft'->>'version')::int = 0 and not (j ? 'submission'), 'team 2 sees none of team 1''s draft or submission';
  assert pg_temp.state(2, 1)::text not like '%x = 4%' and pg_temp.state(2, 1)::text not like '%wrong guess%';
end $$;

-- ===== 12. reference answers and reviewer data never reach a participant ============================================
do $$
declare j text;
begin
  for j in select pg_temp.q(1, 1, q)::text from generate_series(1, 4) q
           union all select pg_temp.state(1, 1)::text
           union all select public.get_question_for_team(pg_temp.team_id(1), pg_temp.member_id(1, 1), 1::smallint)::text
           union all select pg_temp.enter(1, 1, 1, 120)::text
           union all select pg_temp.unlock(1, 1, 3, 101)::text
  loop
    assert j not like '%reference_answer%' and j not like '%solution_notes%' and j not like '%DEV-PLACEHOLDER-ANSWER%'
       and j not like '%reviewed_by%' and j not like '%password%' and j not like '%question_keys%', left(j, 200);
  end loop;
end $$;

-- ===== 13. pause / end gate gameplay; resume settles what ran out before the pause and shifts the rest =============
select pg_temp.at('2026-12-01 13:04:30+00');
select pg_temp.enter(2, 1, 6, 130);                                     -- team 2, theme 2 Q1: deadline 13:08:30
select pg_temp.at('2026-12-01 13:05:00+00');
select pg_temp.status('pause', 131);
select pg_temp.rejects($s$select pg_temp.unlock(1, 1, 4, 132)$s$, 'COMPETITION_PAUSED');
select pg_temp.rejects($s$select pg_temp.enter(1, 1, 7, 133)$s$, 'COMPETITION_PAUSED');
select pg_temp.rejects($s$select pg_temp.draft(2, 1, 6, 'x', 0)$s$, 'COMPETITION_PAUSED');
select pg_temp.rejects($s$select pg_temp.submit(2, 1, 6, 'x', 134)$s$, 'COMPETITION_PAUSED');
select pg_temp.at('2026-12-01 13:10:00+00');
select pg_temp.status('resume', 136);
do $$ begin
  -- team 1 Q11 and team 2 Q1 had already passed their deadlines (13:04) when the pause began: they time out, not shift
  assert (pg_temp.tq(1, 11)).state = 'TIMED_OUT' and (pg_temp.tq(1, 11)).timed_out_at = timestamptz '2026-12-01 13:04:00+00';
  assert (pg_temp.tq(2, 1)).state = 'TIMED_OUT';
  -- team 2 Q6 had 3.5 minutes left at the pause: the pause is not charged to the question
  assert (pg_temp.tq(2, 6)).state = 'ACTIVE' and (pg_temp.tq(2, 6)).timer_deadline = timestamptz '2026-12-01 13:13:30+00';
end $$;
select pg_temp.status('end', 137);
select pg_temp.rejects($s$select pg_temp.unlock(1, 1, 4, 138)$s$, 'COMPETITION_NOT_RUNNING');
select pg_temp.rejects($s$select pg_temp.submit(2, 1, 6, 'x', 139)$s$, 'COMPETITION_NOT_RUNNING');

-- ===== 14. privileges: service_role only ============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.unlock_theme(uuid,uuid,smallint,uuid)',
    'public.start_question(uuid,uuid,smallint,uuid)',
    'public.get_question_for_team(uuid,uuid,smallint)',
    'public.save_draft(uuid,uuid,smallint,text,integer,text)',
    'public.submit_answer(uuid,uuid,smallint,text,text,uuid)',
    'public.approve_submission(uuid,uuid,uuid)',
    'public.disapprove_submission(uuid,uuid,text,uuid)']
  loop
    assert not has_function_privilege('anon', f, 'execute'), f || ' must not be callable by anon';
    assert not has_function_privilege('authenticated', f, 'execute'), f || ' must not be callable by authenticated';
    assert has_function_privilege('service_role', f, 'execute'), f || ' must be callable by service_role';
    assert (select prosecdef from pg_proc where oid = f::regprocedure), f || ' must be SECURITY DEFINER';
    assert (select proconfig::text like '%search_path=%' from pg_proc where oid = f::regprocedure), f || ' must pin its search_path';
  end loop;
  foreach f in array array[
    'app.assert_member(uuid,uuid)', 'app.settle_questions(uuid)', 'app.require_reviewer(uuid,uuid)', 'app.question_json(uuid,smallint)']
  loop
    assert not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute'), f;
  end loop;
end $$;

rollback;
