-- Smoke test of schema constraints. Expect exactly 15 ERROR lines: checks T1-T12, T14 and T15 must each be rejected (T8, the audit table, produces two: update and delete). T7b, T13, T16 and T17 must SUCCEED (no error).
-- Run: psql -d <scratch db> -f docs/evidence/schema.sql ; psql -d <scratch db> -f docs/evidence/schema-smoke.sql
\set ON_ERROR_STOP off
select count(*) as tables from information_schema.tables where table_schema='public' and table_type='BASE TABLE';
insert into competition default values;
insert into staff_users(username,display_name,password_hash,role) values ('root','Root','x','SUPER_ADMIN');
\echo --- T1 second super admin must fail
insert into staff_users(username,display_name,password_hash,role) values ('root2','Root2','x','SUPER_ADMIN');
insert into staff_users(username,display_name,password_hash,role) values ('adm','Adm','x','ADMIN');
insert into teams(team_code,name,login_id,password_hash,admin_id,coins) select 'T1','Team1','t1','x',id,500 from staff_users where username='adm';
insert into team_members(team_id,slot,admission_no) select id,1,'ADM001' from teams;
\echo --- T2 duplicate admission no must fail
insert into team_members(team_id,slot,admission_no) select id,2,'ADM001' from teams;
\echo --- T3 negative coins must fail
update teams set coins=-1;
insert into themes values (1,'A','Algebra','d','{x}','EASY',25,1);
insert into questions values (1,1,1,'q','EASY',40,600,120,10,null);
insert into coin_transactions(team_id,type,amount,balance_after,created_at) select id,'INITIAL_GRANT',500,500,now() from teams;
\echo --- T4 second initial grant must fail
insert into coin_transactions(team_id,type,amount,balance_after,created_at) select id,'INITIAL_GRANT',500,500,now() from teams;
insert into coin_transactions(team_id,type,amount,balance_after,theme_id,created_at) select id,'THEME_UNLOCK',-25,475,1,now() from teams;
\echo --- T5 second unlock ledger row for same theme must fail
insert into coin_transactions(team_id,type,amount,balance_after,theme_id,created_at) select id,'THEME_UNLOCK',-25,450,1,now() from teams;
insert into team_members(team_id,slot,admission_no) select id,2,'ADM002' from teams;
insert into submissions(team_id,question_id,member_id,answer,explanation,submitted_at) select t.id,1,m.id,'42','because',now() from teams t join team_members m on m.team_id=t.id and m.slot=1;
\echo --- T6 second PENDING submission same team/question must fail
insert into submissions(team_id,question_id,member_id,answer,explanation,submitted_at) select t.id,1,m.id,'43','again',now() from teams t join team_members m on m.team_id=t.id and m.slot=2;
\echo --- T7 team_question ACTIVE without deadline must fail
insert into team_themes select t.id,1,m.id,now(),25 from teams t join team_members m on m.team_id=t.id and m.slot=1;
insert into team_questions(team_id,question_id,theme_id,ordinal,state) select id,1,1,1,'ACTIVE' from teams;
\echo --- T7b AVAILABLE question without a deadline must succeed (no error expected)
insert into team_questions(team_id,question_id,theme_id,ordinal,state) select id,1,1,1,'AVAILABLE' from teams;
\echo --- T11 AVAILABLE question WITH a deadline must fail
update team_questions set timer_deadline = now() + interval '10 min';
\echo --- T12 tier 2 hint without tier 1 must fail
insert into hints values (1,1,1,'h1',15),(2,1,2,'h2',30);
insert into hint_purchases select t.id,2,m.id,30,now() from teams t join team_members m on m.team_id=t.id and m.slot=1;
\echo --- T13 tier 1 then tier 2 must succeed (no error expected)
insert into hint_purchases select t.id,1,m.id,15,now() from teams t join team_members m on m.team_id=t.id and m.slot=1;
insert into hint_purchases select t.id,2,m.id,30,now() from teams t join team_members m on m.team_id=t.id and m.slot=1;
select hint_id from hint_purchases order by hint_id;
\echo --- T8 audit update/delete must fail
insert into audit_events(actor_kind,event_type) values ('SYSTEM','TEST');
update audit_events set event_type='X';
delete from audit_events;
\echo --- T9 two live sessions for one member must fail
insert into sessions(token_hash,kind,team_id,member_id,expires_at) select '\x01',  'MEMBER', team_id, id, now()+interval '1h' from team_members where slot=1;
insert into sessions(token_hash,kind,team_id,member_id,expires_at) select '\x02',  'MEMBER', team_id, id, now()+interval '1h' from team_members where slot=1;
\echo --- T10 session with both staff and member must fail
insert into sessions(token_hash,kind,staff_id,team_id,member_id,expires_at) select '\x03','MEMBER',(select id from staff_users limit 1),team_id,id,now()+interval '1h' from team_members where slot=2;
\echo --- T14 score_override on a team that is not DISQUALIFIED must fail
update teams set score_override = -1201;
\echo --- T15 score_reset_at without a baseline must fail
update teams set score_reset_at = now();
\echo --- T16 reset baseline recorded on a RUNNING team must succeed (no error expected)
update teams set status='RUNNING', started_at=now(), ends_at=now()+interval '4 hours', score_reset_at=now(), score_reset_baseline=850;
select status, score_reset_baseline, score_override from teams;
\echo --- T17 disqualify (override + DISQUALIFIED + ended_at) after a reset must succeed (no error expected)
update teams set status='DISQUALIFIED', ended_at=now(), score_override=-1201;
select status, score_reset_baseline, score_override from teams;
\echo --- views
select * from team_theme_progress;
select member_id is not null as has, online from member_presence order by 1 limit 2;
\echo --- test clock
set app.allow_test_clock='on'; set app.test_now='2026-10-10 10:00:00+00'; select app.now();
reset app.test_now; select (app.now() > '2026-01-01') as real_clock;
set app.test_now='2020-01-01'; reset app.allow_test_clock; select (app.now() > '2026-01-01') as ignores_test_now_when_not_allowed;
