-- UFM persistence, Ultimate Team Timer configuration (4 h / 14,400 s / 240 min), final-submit state, audit trail.
begin;
\ir include/helpers.sql
\ir include/fixture.sql

-- ULTIMATE TEAM TIMER: 4 hours = 14400 seconds = 240 minutes (B15; it was 2 h / 7200 s / 120 min before, and teams that
-- had already started keep their own 7200 s in teams.timer_seconds)
do $$
declare c competition;
begin
  select * into c from competition;
  assert c.ultimate_seconds = 14400, 'ultimate_seconds must be 14400';
  assert c.ultimate_minutes = 240, 'ultimate_minutes must be 240';
  assert c.ultimate_seconds <> 7200 and c.ultimate_minutes <> 120, 'the old 2 h value is gone from the competition row';
  assert c.penalty_per_minute = 5 and c.points_per_completed_theme = 500 and c.points_per_solved_question = 100, 'score weights';
end $$;
select pg_temp.rejects($s$update competition set ultimate_seconds = 7200$s$, 'competition_ultimate_locked_14400');
select pg_temp.rejects($s$update competition set ultimate_seconds = 3600$s$, 'competition_ultimate_locked_14400');
select pg_temp.rejects($s$update competition set ultimate_seconds = 14401$s$, 'competition_ultimate_locked_14400');
do $$ begin assert (select column_default from information_schema.columns where table_name = 'competition' and column_name = 'ultimate_seconds') = '14400'; end $$;

-- timer starts only when the team starts: started_at is paired with status, ends_at is after start
select pg_temp.rejects($s$update teams set started_at = now() where team_code = 'T01'$s$, 'teams_started_iff_not_not_started');
select pg_temp.rejects($s$update teams set status = 'RUNNING' where team_code = 'T01'$s$, 'teams_started_iff_not_not_started');
-- B15: the per-team allowance exists exactly when the team has started, and is positive
select pg_temp.rejects($s$update teams set status = 'RUNNING', started_at = now(), ends_at = now() + interval '1 hour' where team_code = 'T01'$s$, 'teams_timer_seconds_iff_started');
select pg_temp.rejects($s$update teams set timer_seconds = 14400 where team_code = 'T01'$s$, 'teams_timer_seconds_iff_started');
update teams set status = 'RUNNING', started_at = timestamptz '2026-12-01 10:00:00+00', timer_seconds = (select ultimate_seconds from competition),
                 ends_at = timestamptz '2026-12-01 10:00:00+00' + (select ultimate_seconds from competition) * interval '1 second'
 where team_code = 'T01';
do $$ begin assert (select ends_at - started_at from teams where team_code = 'T01') = interval '4 hours', 'ends_at = started_at + 4 h'; end $$;
select pg_temp.rejects($s$update teams set ends_at = started_at - interval '1 second' where team_code = 'T01'$s$, 'teams_ends_after_start');
select pg_temp.rejects($s$update teams set timer_seconds = 0 where team_code = 'T01'$s$, 'teams_timer_seconds_iff_started');

-- app.now() is the single, controllable clock (used to test timers without sleeping)
set app.allow_test_clock = 'on';
set app.test_now = '2026-12-01 12:00:00+00';
do $$ begin assert app.now() = timestamptz '2026-12-01 12:00:00+00', 'test clock'; end $$;
reset app.test_now;
do $$ begin assert app.now() > timestamptz '2026-01-01', 'real clock'; end $$;

-- UFM: Reset = baseline model (history kept), floor -1200; Disqualify = -1201 and terminal
do $$ begin
  assert (select reset_floor_score from competition) = -1200 and (select disqualified_score from competition) = -1201;
  assert (select disqualified_score from competition) = (select reset_floor_score - 1 from competition), 'DQ is one below the floor';
end $$;
select pg_temp.rejects($s$update competition set reset_floor_score = -1000$s$, 'competition_ufm_floor_locked');
select pg_temp.rejects($s$update competition set disqualified_score = -1200$s$, 'competition_ufm_floor_locked');
select pg_temp.rejects($s$update teams set score_reset_at = now() where team_code = 'T01'$s$, 'teams_reset_columns_paired');        -- both or neither
select pg_temp.rejects($s$update teams set score_reset_baseline = 850 where team_code = 'T01'$s$, 'teams_reset_columns_paired');
update teams set score_reset_at = now(), score_reset_baseline = 850 where team_code = 'T01';     -- Reset: team keeps RUNNING, nothing is deleted
do $$ begin assert (select status from teams where team_code = 'T01') = 'RUNNING' and (select coins from teams where team_code = 'T01') = 500; end $$;
select pg_temp.rejects($s$update teams set score_override = -1201 where team_code = 'T01'$s$, 'teams_disqualified_score');          -- only a DQ pins the score
select pg_temp.rejects($s$update teams set status = 'DISQUALIFIED', ended_at = now() where team_code = 'T01'$s$, 'teams_disqualified_score');   -- DQ needs the override
select pg_temp.rejects($s$update teams set status = 'DISQUALIFIED', ended_at = now(), score_override = 0 where team_code = 'T01'$s$, 'teams_disqualified_score');
select pg_temp.rejects($s$update teams set status = 'DISQUALIFIED', score_override = -1201 where team_code = 'T01'$s$, 'teams_terminal_has_ended_at');
update teams set status = 'DISQUALIFIED', ended_at = now(), score_override = -1201 where team_code = 'T01';
do $$ begin assert (select score_override from teams where team_code = 'T01') = -1201 and (select score_reset_baseline from teams where team_code = 'T01') = 850, 'reset history survives a DQ'; end $$;
-- two-step confirmation persistence (the second step is enforced by the engine later)
insert into ufm_challenges (staff_id, team_id, action, expires_at)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'RESET_SCORE', now() + interval '60 seconds');
select pg_temp.rejects($s$insert into ufm_challenges (staff_id, team_id, action, expires_at) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'DELETE_TEAM', now())$s$, 'ufm_challenges_action_check');

-- final submission state model: FINAL_SUBMITTED needs its timestamp, ended_at and a member of the team
select pg_temp.rejects($s$update teams set status = 'FINAL_SUBMITTED', started_at = now(), timer_seconds = 14400, ended_at = now() where team_code = 'T02'$s$, 'teams_final_submit_columns');
select pg_temp.rejects($s$update teams set status = 'FINAL_SUBMITTED', started_at = now(), timer_seconds = 14400, ended_at = now(), final_submitted_at = now(), final_submitted_by = '00000000-0000-0000-0000-00000000c101' where team_code = 'T02'$s$, '23503');   -- member of team 1, not 2
update teams set status = 'FINAL_SUBMITTED', started_at = now(), timer_seconds = 14400, ended_at = now(), final_submitted_at = now(),
                 final_submitted_by = '00000000-0000-0000-0000-00000000c202', final_score = 1200, final_completed_themes = 2,
                 final_solved_questions = 10, final_minutes_taken = 120 where team_code = 'T02';
-- B15: the 0..120 clamp belonged to the 2 h timer; a 4 h team may legitimately take up to 240 minutes (B16 owns the rounding)
select pg_temp.rejects($s$update teams set final_minutes_taken = -1 where team_code = 'T02'$s$, 'teams_final_minutes_taken_nonneg');
update teams set final_minutes_taken = 121 where team_code = 'T02';
update teams set final_minutes_taken = 240 where team_code = 'T02';
do $$ begin assert (select final_minutes_taken from teams where team_code = 'T02') = 240, 'minutes taken may reach 240 (4 h)'; end $$;

-- competition state is limited to the canonical set and its timestamps stay coherent
select pg_temp.rejects($s$update competition set status = 'PAUSED'$s$, 'competition_paused_has_timestamp');
select pg_temp.rejects($s$update competition set status = 'ENDED'$s$, 'competition_ended_has_timestamp');
select pg_temp.rejects($s$update competition set status = 'OPEN'$s$, '22P02');
select pg_temp.rejects($s$insert into competition (id) values (2)$s$, 'competition_id_check');
update competition set status = 'RUNNING', opened_at = now();

-- audit trail: structured, append-only (no update/delete/truncate), actor must be identified
insert into audit_events (actor_kind, staff_id, team_id, event_type, entity_type, entity_id, payload)
values ('STAFF', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'UFM_RESET_SCORE', 'team', 'T01', '{"baseline":850}');
insert into audit_events (actor_kind, event_type) values ('SYSTEM', 'COMPETITION_OPENED');
select pg_temp.rejects($s$insert into audit_events (actor_kind, event_type) values ('STAFF', 'X')$s$, 'audit_actor_matches_kind');
select pg_temp.rejects($s$insert into audit_events (actor_kind, event_type) values ('MEMBER', 'X')$s$, 'audit_actor_matches_kind');
select pg_temp.rejects($s$update audit_events set event_type = 'X'$s$, 'append-only');
select pg_temp.rejects($s$delete from audit_events$s$, 'append-only');
select pg_temp.rejects($s$truncate audit_events$s$, 'append-only');
do $$ begin assert (select count(*) from audit_events) = 2; end $$;

-- idempotency log: the same key cannot be recorded twice for one principal
insert into request_log (team_id, idem_key, operation, response) values ('00000000-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111', 'unlockTheme', '{}');
select pg_temp.rejects($s$insert into request_log (team_id, idem_key, operation, response) values ('00000000-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111', 'unlockTheme', '{}')$s$, '23505');
-- single-row tables
select pg_temp.rejects($s$insert into leaderboard_snapshot (id, computed_at, rows) values (2, now(), '[]')$s$, 'leaderboard_snapshot_id_check');
rollback;
