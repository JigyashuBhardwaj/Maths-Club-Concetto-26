-- Patch B14 / migration 15 — the Admin "My Teams" live control matrix (READ side only) and member presence.
--
-- What this migration adds
--   * app.presence_timeout_seconds()  the ONE definition of "how long without a sign of life before a member is OUT" (75 s).
--   * member_presence (view)          re-declared on that constant and now also requires the session not to be expired.
--   * public.admin_matrix(staff)      one row per team the Admin OWNS: M1..M4 presence, the ten A..J theme cells, Final Submit.
--   * public.admin_team_theme(...)    the five-question drill-down of one theme cell, with the pending submission (if any).
--   * drops public.list_pending_submissions (the temporary B13 review queue, replaced by the matrix drill-down).
--
-- What it deliberately does NOT touch: create_team / list_admin_teams / team ownership (B12), approve_submission /
-- disapprove_submission and every other mutation (B13), coins, scoring, timers, the competition structure. Reward amounts
-- stay question-level data (questions.reward_coins, seeded to 50): approve_submission already pays exactly that column.
--
-- Both new functions are pure reads (STABLE, no writes, no audit). Ownership is enforced HERE, in the database: the staff
-- id comes from the session, a team the caller does not own is NOT_FOUND (indistinguishable from an unknown id), and a
-- Super Admin gets FORBIDDEN exactly as list_admin_teams does (the matrix is the Admin's own board).
-- No reference answer or solution note is ever selected (question_keys is not read by any function in this file).

-- ---------------------------------------------------------------------------------------------------------------
-- Presence. "Authenticated" and "online" are different: a live session proves the member signed in, `last_seen_at`
-- proves the browser is still talking to us. It is refreshed by every authenticated request (resolve_session) and by the
-- participant heartbeat (POST /api/p/heartbeat, every 25 s, even from a hidden tab). A member is ONLINE while their live,
-- unexpired session was seen within the timeout. Logout revokes the session, so OUT is immediate; a closed browser or a
-- lost network goes OUT when the timeout runs out; any request after that makes them ONLINE again.
-- ---------------------------------------------------------------------------------------------------------------
create function app.presence_timeout_seconds() returns int
language sql immutable
as $$ select 75 $$;

create or replace view member_presence with (security_invoker = true) as
select m.id as member_id, m.team_id, m.slot,
       (case when exists (select 1 from sessions s
                           where s.member_id = m.id and s.revoked_at is null
                             and s.expires_at > app.now()
                             and s.last_seen_at > app.now() - make_interval(secs => app.presence_timeout_seconds()))
             then 'ONLINE' else 'OFFLINE' end)::presence_state as presence
from team_members m;

-- ---------------------------------------------------------------------------------------------------------------
-- app.require_owner_admin: the caller must be an active ADMIN who owns the team. Anything else is an error that does
-- not reveal whether the team exists.
-- ---------------------------------------------------------------------------------------------------------------
create function app.require_owner_admin(p_staff_id uuid, p_team_id uuid) returns void
language plpgsql stable
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if p_staff_id is null or not exists (select 1 from staff_users where id = p_staff_id and role = 'ADMIN' and is_active) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_team_id is null or not exists (select 1 from teams where id = p_team_id and admin_id = p_staff_id) then
    perform app.fail('NOT_FOUND');
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- admin_matrix(staff_id)
--   { server_now, presence_timeout_seconds,
--     teams: [ { id, team_code, name, status, final_submitted,
--                members: [ { slot, presence } ] (always M1..M4 that exist),
--                themes:  [ { code, state: NORMAL|RED|GREEN, approved, pending } ] (always A..J, in order) } ] }
--   RED   = at least one question of the theme is PENDING_APPROVAL (the Admin has something to review)
--   GREEN = all five questions are APPROVED
--   NORMAL otherwise (an unlocked theme with nothing pending is NOT red)
-- ---------------------------------------------------------------------------------------------------------------
create function public.admin_matrix(p_staff_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
begin
  if p_staff_id is null or not exists (select 1 from staff_users where id = p_staff_id and role = 'ADMIN' and is_active) then
    perform app.fail('FORBIDDEN');
  end if;
  return jsonb_build_object(
    'server_now', app.epoch_ms(app.now()),
    'presence_timeout_seconds', app.presence_timeout_seconds(),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id,
               'team_code', t.team_code,
               'name', t.name,
               'status', t.status::text,
               'final_submitted', (t.status = 'FINAL_SUBMITTED'),
               'members', (select coalesce(jsonb_agg(jsonb_build_object('slot', p.slot, 'presence', p.presence::text)
                                                      order by p.slot), '[]'::jsonb)
                             from member_presence p where p.team_id = t.id),
               'themes', (select jsonb_agg(jsonb_build_object(
                                    'code', th.code,
                                    'state', case when c.pending > 0 then 'RED'
                                                  when c.approved = 5 then 'GREEN'
                                                  else 'NORMAL' end,
                                    'approved', c.approved,
                                    'pending', c.pending) order by th.id)
                            from themes th
                            cross join lateral (
                              select count(*) filter (where tq.state = 'APPROVED')         as approved,
                                     count(*) filter (where tq.state = 'PENDING_APPROVAL') as pending
                                from team_questions tq
                               where tq.team_id = t.id and tq.theme_id = th.id) c)
             ) order by t.created_at, t.team_code)
        from teams t where t.admin_id = p_staff_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- admin_team_theme(staff_id, team_id, theme_code)
--   { server_now, team: {id, team_code, name}, theme: {code, name},
--     questions: [ { id, ordinal, label ("D.2"), color: WHITE|RED|GREEN, state, submission: null | {...} } ] }
--   color  GREEN = APPROVED, RED = PENDING_APPROVAL, WHITE = anything else (locked, available, active, timed out)
--   state  the raw question state, for the label ("Active", "Locked", ...). A theme the team has not unlocked has no
--          team_questions rows: its five questions are reported LOCKED.
--   submission  only for a RED question: the PENDING submission (answer, explanation, who, when) and the question text,
--          i.e. exactly what the existing approve/disapprove endpoints act on. NEVER a reference answer or key.
-- ---------------------------------------------------------------------------------------------------------------
create function public.admin_team_theme(p_staff_id uuid, p_team_id uuid, p_theme_code text) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, extensions, app, pg_temp
as $$
declare
  v_team  teams%rowtype;
  v_theme themes%rowtype;
begin
  perform app.require_owner_admin(p_staff_id, p_team_id);
  select * into v_team from teams where id = p_team_id;
  select * into v_theme from themes where code = upper(btrim(coalesce(p_theme_code, '')));
  if not found then
    perform app.fail('NOT_FOUND');
  end if;

  return jsonb_build_object(
    'server_now', app.epoch_ms(app.now()),
    'team', jsonb_build_object('id', v_team.id, 'team_code', v_team.team_code, 'name', v_team.name),
    'theme', jsonb_build_object('code', v_theme.code, 'name', v_theme.name),
    'questions', (
      select jsonb_agg(jsonb_build_object(
               'id', q.id,
               'ordinal', q.ordinal,
               'label', v_theme.code || '.' || q.ordinal,
               'color', case tq.state::text when 'APPROVED' then 'GREEN'
                                            when 'PENDING_APPROVAL' then 'RED'
                                            else 'WHITE' end,
               'state', coalesce(tq.state::text, 'LOCKED'),
               'submission', case when tq.state = 'PENDING_APPROVAL' then
                   (select jsonb_build_object(
                             'id', sub.id,
                             'body_md', q.body_md,
                             'answer', sub.answer,
                             'explanation', sub.explanation,
                             'submitted_by_slot', m.slot,
                             'submitted_at', app.epoch_ms(sub.submitted_at),
                             'reward_coins', q.reward_coins)
                      from submissions sub
                      left join team_members m on m.id = sub.member_id
                     where sub.team_id = tq.team_id and sub.question_id = tq.question_id and sub.status = 'PENDING')
                 end) order by q.ordinal)
        from questions q
        left join team_questions tq on tq.team_id = p_team_id and tq.question_id = q.id
       where q.theme_id = v_theme.id));
end $$;

-- The temporary B13 review queue is replaced by the matrix drill-down; nothing else uses it.
drop function public.list_pending_submissions(uuid);

revoke all on function app.presence_timeout_seconds()                         from public, anon, authenticated;
revoke all on function app.require_owner_admin(uuid, uuid)                    from public, anon, authenticated;
revoke all on function public.admin_matrix(uuid)                              from public, anon, authenticated;
revoke all on function public.admin_team_theme(uuid, uuid, text)              from public, anon, authenticated;

grant execute on function app.presence_timeout_seconds()                      to service_role;
grant execute on function app.require_owner_admin(uuid, uuid)                 to service_role;
grant execute on function public.admin_matrix(uuid)                           to service_role;
grant execute on function public.admin_team_theme(uuid, uuid, text)          to service_role;
