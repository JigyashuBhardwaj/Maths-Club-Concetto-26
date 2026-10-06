-- Patch B / migration 8 of 9 — derived views and read-only invariant checkers (no game logic).

-- progress per team+theme (5 = QUESTIONS_PER_THEME)
create view team_theme_progress with (security_invoker = true) as
select team_id, theme_id,
       count(*) filter (where state = 'APPROVED') as approved_count,
       coalesce(bool_or(state = 'TIMED_OUT'), false) as has_timed_out,
       count(*) filter (where state = 'APPROVED') = 5 as completed
from team_questions group by team_id, theme_id;

-- presence: OFFLINE / ONLINE (a member is ONLINE while a live session has been seen in the last 75 s)
create view member_presence with (security_invoker = true) as
select m.id as member_id, m.team_id, m.slot,
       (case when exists (select 1 from sessions s
                           where s.member_id = m.id and s.revoked_at is null
                             and s.last_seen_at > app.now() - interval '75 seconds')
             then 'ONLINE' else 'OFFLINE' end)::presence_state as presence
from team_members m;

-- Invariant checkers: each returns the offending rows and must be empty at all times.
create view app.invariant_coin_balance_mismatch as          -- INV: teams.coins = last ledger balance_after
select t.id as team_id, t.coins, coalesce(l.balance_after, 0) as ledger_balance
from teams t
left join lateral (select balance_after from coin_transactions c where c.team_id = t.id order by c.id desc limit 1) l on true
where t.coins <> coalesce(l.balance_after, 0);

create view app.invariant_team_member_count as              -- INV: 1..4 members per team once the team exists
select t.id as team_id, count(m.id) as members
from teams t left join team_members m on m.team_id = t.id
group by t.id having count(m.id) not between 1 and 4;
