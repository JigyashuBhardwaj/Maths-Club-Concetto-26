-- Question lifecycle persistence, ordering, one-pending-submission, rejected history, hints, Buy Time config.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

-- unlock theme A for team 1: Q1 AVAILABLE (no timer, never started), Q2..Q5 LOCKED
insert into team_themes (team_id, theme_id, unlocked_by, unlocked_at, cost_paid)
values ('00000000-0000-0000-0000-0000000000b1', 1, '00000000-0000-0000-0000-00000000c101', now(), 100);
insert into team_questions (team_id, question_id, theme_id, ordinal, state)
select '00000000-0000-0000-0000-0000000000b1', q.id, q.theme_id, q.ordinal, case when q.ordinal = 1 then 'AVAILABLE' else 'LOCKED' end::question_state
from questions q where q.theme_id = 1;
do $$ begin
  assert (select count(*) from team_questions) = 5;
  assert (select state from team_questions where question_id = 1) = 'AVAILABLE' and (select timer_deadline from team_questions where question_id = 1) is null, 'Q1 AVAILABLE, no timer at unlock';
  assert (select activated_at from team_questions where question_id = 1) is null, 'unlocking does not start Q1';
end $$;

-- all six canonical states are representable
select pg_temp.rejects($s$update team_questions set state = 'ACTIVE' where question_id = 1$s$, 'team_questions_active_has_deadline');           -- needs a deadline
select pg_temp.rejects($s$update team_questions set state = 'ACTIVE', timer_deadline = now() + interval '4 min' where question_id = 1$s$, 'team_questions_unstarted_no_activation');   -- needs activated_at
update team_questions set state = 'ACTIVE', timer_deadline = now() + interval '4 min', activated_at = now() where question_id = 1;       -- AVAILABLE -> ACTIVE
update team_questions set state = 'PENDING_APPROVAL', timer_deadline = null, timer_remaining_seconds = 180 where question_id = 1;       -- timer frozen while pending
select pg_temp.rejects($s$update team_questions set timer_remaining_seconds = null where question_id = 1$s$, 'team_questions_pending_has_remaining');
select pg_temp.rejects($s$update team_questions set timer_remaining_seconds = -1 where question_id = 1$s$, 'team_questions_remaining_nonneg');
do $$ begin assert (select state from team_questions where question_id = 1) = 'PENDING_APPROVAL'; end $$;

select pg_temp.rejects($s$update team_questions set state = 'AVAILABLE' where question_id = 3$s$, 'team_questions_available_only_q1');   -- INV-04: only Q1 is ever AVAILABLE

-- QN+1 cannot be activated until QN is APPROVED
select pg_temp.rejects($s$update team_questions set state = 'ACTIVE', timer_deadline = now() + interval '4 min', activated_at = now() where question_id = 2$s$, 'QUESTION_PREVIOUS_NOT_APPROVED');
update team_questions set state = 'APPROVED', timer_remaining_seconds = null, approved_at = now() where question_id = 1;
select pg_temp.rejects($s$update team_questions set state = 'APPROVED' where question_id = 1 and false or question_id = 3$s$, 'QUESTION_PREVIOUS_NOT_APPROVED');
update team_questions set state = 'ACTIVE', timer_deadline = now() + interval '4 min', activated_at = now() where question_id = 2;   -- now allowed
select pg_temp.rejects($s$update team_questions set state = 'ACTIVE', timer_deadline = now() + interval '4 min', activated_at = now() where question_id = 3$s$, 'QUESTION_PREVIOUS_NOT_APPROVED');

-- Buy Time purchases (structure only; the buy_time operation is Phase 5). Q2 is ACTIVE here; options of question 2 are ids 4..6.
insert into team_time_purchases (team_id, question_id, seq, option_id, seconds_added, cost_paid, purchased_by, purchased_at)
values ('00000000-0000-0000-0000-0000000000b1', 2, 1, 4, 120, 20, '00000000-0000-0000-0000-00000000c101', now());
select pg_temp.rejects($s$insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b1', 2, 1, 5, 240, 40, '00000000-0000-0000-0000-00000000c102', now())$s$, 'TIME_PURCHASE_SEQ_MISMATCH');   -- replay of seq 1 is rejected
select pg_temp.rejects($s$insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b1', 2, 3, 5, 240, 40, '00000000-0000-0000-0000-00000000c102', now())$s$, 'TIME_PURCHASE_SEQ_MISMATCH');   -- gap
select pg_temp.rejects($s$insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b1', 2, 2, 5, 240, 99, '00000000-0000-0000-0000-00000000c102', now())$s$, 'BUY_TIME_OPTION_MISMATCH');   -- price must equal the option
select pg_temp.rejects($s$insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b1', 2, 2, 1, 120, 20, '00000000-0000-0000-0000-00000000c102', now())$s$, 'ttp_option_fk');              -- option 1 belongs to question 1
select pg_temp.rejects($s$insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b1', 2, 2, 5, 240, 40, '00000000-0000-0000-0000-00000000c201', now())$s$, 'ttp_member_in_team');
select pg_temp.rejects($s$insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b1', 3, 1, 7, 120, 20, '00000000-0000-0000-0000-00000000c101', now())$s$, 'BUY_TIME_NOT_ACTIVE');       -- Q3 is LOCKED
select pg_temp.rejects($s$insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b2', 2, 1, 4, 120, 20, '00000000-0000-0000-0000-00000000c201', now())$s$, 'BUY_TIME_NOT_ACTIVE');   -- team 2 has no Q2 (no active question)
-- a different option may be bought next; options are configuration, so a cap is honoured when one is set
insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b1', 2, 2, 6, 480, 80, '00000000-0000-0000-0000-00000000c102', now());
update question_buy_time_options set max_purchases = 1 where id = 4;
select pg_temp.rejects($s$insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b1', 2, 3, 4, 120, 20, '00000000-0000-0000-0000-00000000c101', now())$s$, 'TIME_PURCHASE_LIMIT');
update question_buy_time_options set max_purchases = null where id = 4;
insert into team_time_purchases values ('00000000-0000-0000-0000-0000000000b1', 2, 3, 4, 120, 20, '00000000-0000-0000-0000-00000000c101', now());   -- unlimited again: the same option can repeat
-- a later price change does not rewrite history (purchases keep what was paid)
update question_buy_time_options set cost = 25 where id = 4;
do $$ begin assert (select cost_paid from team_time_purchases where seq = 1 and question_id = 2) = 20, 'purchase snapshot keeps the price paid'; end $$;
update question_buy_time_options set cost = 20 where id = 4;
-- purchase history is append-only for the service role (no privilege), and options have a valid shape
do $$ begin assert not has_table_privilege('service_role', 'public.team_time_purchases', 'update') and not has_table_privilege('service_role', 'public.team_time_purchases', 'delete'); end $$;
select pg_temp.rejects($s$insert into question_buy_time_options (id, question_id, seconds, cost, display_order) values (200, 1, 0, 10, 4)$s$, 'question_buy_time_options_seconds_check');
select pg_temp.rejects($s$insert into question_buy_time_options (id, question_id, seconds, cost, display_order) values (200, 1, 60, -1, 4)$s$, 'question_buy_time_options_cost_check');
select pg_temp.rejects($s$insert into question_buy_time_options (id, question_id, seconds, cost, max_purchases, display_order) values (200, 1, 60, 5, -1, 4)$s$, 'question_buy_time_options_max_purchases_check');
select pg_temp.rejects($s$insert into question_buy_time_options (id, question_id, seconds, cost, display_order) values (200, 1, 60, 5, 1)$s$, '23505');          -- display_order 1 already used for question 1
select pg_temp.rejects($s$insert into question_buy_time_options (id, question_id, seconds, cost, display_order) values (200, 1, 120, 5, 4)$s$, '23505');         -- same seconds twice for one question
select pg_temp.rejects($s$insert into question_buy_time_options (id, question_id, seconds, cost, display_order) values (200, 99, 60, 5, 1)$s$, '23503');
insert into question_buy_time_options (id, question_id, seconds, cost, display_order) values (200, 1, 60, 5, 4);   -- a fourth option is allowed: it is configuration

-- TIMED_OUT is representable (and a timed-out question never counts as approved, so the next stays blocked)
update team_questions set state = 'TIMED_OUT', timer_deadline = null, timed_out_at = now() where question_id = 2;
select pg_temp.rejects($s$update team_questions set state = 'ACTIVE', timer_deadline = now() + interval '4 min', activated_at = now() where question_id = 3$s$, 'QUESTION_PREVIOUS_NOT_APPROVED');
do $$ begin
  assert (select array_agg(state::text order by question_id) from team_questions) = array['APPROVED','TIMED_OUT','LOCKED','LOCKED','LOCKED'];
  assert (select completed from team_theme_progress) = false and (select has_timed_out from team_theme_progress), 'a timed-out theme can never complete';
end $$;
-- rows are tied to an unlocked theme and to the right theme
select pg_temp.rejects($s$insert into team_questions (team_id, question_id, theme_id, ordinal) values ('00000000-0000-0000-0000-0000000000b1', 6, 2, 1)$s$, 'team_questions_theme_unlocked_fk');
select pg_temp.rejects($s$insert into team_questions (team_id, question_id, theme_id, ordinal) values ('00000000-0000-0000-0000-0000000000b2', 6, 1, 1)$s$, 'team_questions_question_fk');   -- question 6 is not in theme 1
-- unlocking a theme twice is impossible
select pg_temp.rejects($s$insert into team_themes (team_id, theme_id, unlocked_by, unlocked_at, cost_paid) values ('00000000-0000-0000-0000-0000000000b1', 1, '00000000-0000-0000-0000-00000000c101', now(), 100)$s$, '23505');
-- the unlocking member must belong to the team
select pg_temp.rejects($s$insert into team_themes (team_id, theme_id, unlocked_by, unlocked_at, cost_paid) values ('00000000-0000-0000-0000-0000000000b1', 2, '00000000-0000-0000-0000-00000000c201', now(), 100)$s$, 'team_themes_member_in_team');

-- submissions: records member, answer, explanation, timestamps, reviewer/status
insert into submissions (id, team_id, question_id, member_id, answer, explanation, submitted_at)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', 1, '00000000-0000-0000-0000-00000000c103', 'wrong answer', 'because', now());
-- one pending submission per team/question
select pg_temp.rejects($s$insert into submissions (team_id, question_id, member_id, answer, explanation, submitted_at) values ('00000000-0000-0000-0000-0000000000b1', 1, '00000000-0000-0000-0000-00000000c104', 'again', '', now())$s$, 'submissions_one_pending');
-- ...but another team may submit the same question, and another question is independent
insert into submissions (team_id, question_id, member_id, answer, explanation, submitted_at)
values ('00000000-0000-0000-0000-0000000000b2', 1, '00000000-0000-0000-0000-00000000c201', 'team2', '', now()),
       ('00000000-0000-0000-0000-0000000000b1', 2, '00000000-0000-0000-0000-00000000c101', 'q2', '', now());
-- the submitting member must belong to the team; answers are not empty
select pg_temp.rejects($s$insert into submissions (team_id, question_id, member_id, answer, explanation, submitted_at) values ('00000000-0000-0000-0000-0000000000b1', 3, '00000000-0000-0000-0000-00000000c201', 'x', '', now())$s$, 'submissions_member_in_team');
select pg_temp.rejects($s$insert into submissions (team_id, question_id, member_id, answer, explanation, submitted_at) values ('00000000-0000-0000-0000-0000000000b1', 3, '00000000-0000-0000-0000-00000000c101', '', '', now())$s$, 'submissions_answer_check');
-- a decision needs a reviewer and a timestamp; a reward only exists on approval
select pg_temp.rejects($s$update submissions set status = 'REJECTED', reviewed_at = now() where id = '00000000-0000-0000-0000-0000000000d1'$s$, 'submissions_decided_has_reviewer');
select pg_temp.rejects($s$update submissions set reviewed_at = now() where id = '00000000-0000-0000-0000-0000000000d1'$s$, 'submissions_reviewed_iff_decided');
select pg_temp.rejects($s$update submissions set status = 'REJECTED', reviewed_by = '00000000-0000-0000-0000-0000000000a3' where id = '00000000-0000-0000-0000-0000000000d1'$s$, 'submissions_reviewed_iff_decided');
select pg_temp.rejects($s$update submissions set reward_awarded = 50 where id = '00000000-0000-0000-0000-0000000000d1'$s$, 'submissions_reward_only_if_approved');
-- reject it: the row is KEPT (auditable) and a new pending submission is then allowed
update submissions set status = 'REJECTED', reviewed_by = '00000000-0000-0000-0000-0000000000a3', reviewed_at = now(), review_note = 'check step 2'
 where id = '00000000-0000-0000-0000-0000000000d1';
insert into submissions (team_id, question_id, member_id, answer, explanation, submitted_at)
values ('00000000-0000-0000-0000-0000000000b1', 1, '00000000-0000-0000-0000-00000000c101', 'better answer', 'because', now());
do $$ begin
  assert (select count(*) from submissions where team_id = '00000000-0000-0000-0000-0000000000b1' and question_id = 1) = 2, 'rejected history stays next to the new pending submission';
  assert (select count(*) from submissions where team_id = '00000000-0000-0000-0000-0000000000b1' and question_id = 1 and status = 'REJECTED') = 1;
end $$;
-- the rejected-answer draft survives a rejection: the draft row is independent of submissions (UI-2.1 rule)
insert into answer_drafts (team_id, question_id, answer, explanation, updated_by)
values ('00000000-0000-0000-0000-0000000000b1', 1, 'wrong answer', 'because', '00000000-0000-0000-0000-00000000c103');
select pg_temp.rejects($s$insert into answer_drafts (team_id, question_id, answer, updated_by) values ('00000000-0000-0000-0000-0000000000b1', 2, 'x', '00000000-0000-0000-0000-00000000c201')$s$, 'answer_drafts_member_in_team');
do $$ begin assert (select answer from answer_drafts where question_id = 1) = 'wrong answer', 'draft kept after rejection'; end $$;

-- hints: Tier 2 requires Tier 1 (same question, same team); each hint is bought at most once
select pg_temp.rejects($s$insert into hint_purchases (team_id, hint_id, purchased_by, cost_paid, purchased_at) values ('00000000-0000-0000-0000-0000000000b1', 2, '00000000-0000-0000-0000-00000000c101', 80, now())$s$, 'HINT_TIER1_REQUIRED');
insert into hint_purchases (team_id, hint_id, purchased_by, cost_paid, purchased_at) values ('00000000-0000-0000-0000-0000000000b1', 1, '00000000-0000-0000-0000-00000000c101', 40, now());
select pg_temp.rejects($s$insert into hint_purchases (team_id, hint_id, purchased_by, cost_paid, purchased_at) values ('00000000-0000-0000-0000-0000000000b1', 1, '00000000-0000-0000-0000-00000000c102', 40, now())$s$, '23505');
insert into hint_purchases (team_id, hint_id, purchased_by, cost_paid, purchased_at) values ('00000000-0000-0000-0000-0000000000b1', 2, '00000000-0000-0000-0000-00000000c102', 80, now());   -- now allowed
-- Tier 1 of ANOTHER question does not unlock Tier 2 of this one; Tier 1 of another team does not either
select pg_temp.rejects($s$insert into hint_purchases (team_id, hint_id, purchased_by, cost_paid, purchased_at) values ('00000000-0000-0000-0000-0000000000b1', 4, '00000000-0000-0000-0000-00000000c101', 80, now())$s$, 'HINT_TIER1_REQUIRED');
insert into hint_purchases (team_id, hint_id, purchased_by, cost_paid, purchased_at) values ('00000000-0000-0000-0000-0000000000b2', 3, '00000000-0000-0000-0000-00000000c201', 40, now());
select pg_temp.rejects($s$insert into hint_purchases (team_id, hint_id, purchased_by, cost_paid, purchased_at) values ('00000000-0000-0000-0000-0000000000b1', 4, '00000000-0000-0000-0000-00000000c101', 80, now())$s$, 'HINT_TIER1_REQUIRED');
select pg_temp.rejects($s$insert into hints (id, question_id, tier, body_md, cost) values (101, 1, 1, 'x', 1)$s$, 'hints_id_check');
select pg_temp.rejects($s$insert into hints (id, question_id, tier, body_md, cost) values (99, 1, 3, 'x', 1)$s$, 'hints_tier_check');

-- Buy Time is configuration (question_buy_time_options), validated in the purchase tests above
select pg_temp.rejects($s$update team_questions set time_purchase_count = -1$s$, 'team_questions_time_purchase_count_check');

-- reviewer keys live in their own table (a participant-facing query never touches it)
do $$ begin
  assert not exists (select 1 from information_schema.columns where table_name in ('questions', 'hints') and column_name in ('reference_answer', 'solution_notes'));
end $$;
rollback;
