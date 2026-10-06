-- Patch B / migration 3 of 9 — teams, members (slots M1–M4) and sessions.

create table teams (
  id                     uuid primary key default gen_random_uuid(),
  team_code              text   not null unique,        -- "Team ID" in the brief, e.g. T17
  name                   text   not null,
  login_id               citext not null unique,        -- "Team Login ID"
  password_hash          text   not null,
  admin_id               uuid   not null references staff_users(id) on delete restrict,   -- the assigned admin
  status                 team_status not null default 'NOT_STARTED',
  coins                  int    not null check (coins >= 0),   -- authoritative balance; every change has a ledger row
  started_at             timestamptz,                    -- Ultimate Team Timer start (first member enters the competition)
  ends_at                timestamptz,                    -- started_at + ultimate_seconds (+ pause shifts)
  ended_at               timestamptz,                    -- set on FINAL_SUBMITTED / ENDED / DISQUALIFIED
  final_submitted_at     timestamptz,
  final_submitted_by     uuid,                           -- team_members.id (FK added below)
  score_override         int,                            -- Disqualify only: -1201; wins over every computed score
  score_reset_at         timestamptz,                    -- last UFM Reset; NULL if never reset
  score_reset_baseline   int,                            -- raw score at that instant; official = max(-1200, raw - baseline)
  final_score            int,                            -- cache, see compute_team_score()
  final_completed_themes int,
  final_solved_questions int,
  final_minutes_taken    int check (final_minutes_taken is null or final_minutes_taken between 0 and 120),
  state_version          bigint not null default 0,      -- bumped by every team-affecting transaction
  created_by             uuid references staff_users(id) on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint teams_started_iff_not_not_started check ((status = 'NOT_STARTED') = (started_at is null)),
  constraint teams_ends_after_start             check (ends_at is null or ends_at > started_at),
  constraint teams_reset_columns_paired         check ((score_reset_at is null) = (score_reset_baseline is null)),
  -- UFM: only a disqualification pins the score, and it pins it to exactly -1201 (competition.disqualified_score)
  constraint teams_disqualified_score           check ((status = 'DISQUALIFIED') = (score_override is not null)
                                                       and (score_override is null or score_override = -1201)),
  constraint teams_final_submit_columns         check ((status = 'FINAL_SUBMITTED') = (final_submitted_at is not null)),
  constraint teams_terminal_has_ended_at        check ((status in ('FINAL_SUBMITTED', 'ENDED', 'DISQUALIFIED')) = (ended_at is not null))
);
create index teams_admin_idx  on teams (admin_id);
create index teams_status_idx on teams (status);
create index teams_due_idx    on teams (ends_at) where status = 'RUNNING';   -- expiry sweeper
create trigger teams_touch before update on teams
  for each row execute function app.touch_updated_at();

create table team_members (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references teams(id) on delete restrict,
  slot          smallint not null check (slot between 1 and 4),   -- M1..M4
  admission_no  text not null unique,                    -- globally unique across all teams (normalised by the app)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (team_id, slot),
  unique (id, team_id),                                  -- lets other tables prove "this member belongs to this team"
  constraint team_members_admission_normalised check (admission_no = upper(btrim(admission_no)) and admission_no <> '')
);
create trigger team_members_touch before update on team_members
  for each row execute function app.touch_updated_at();

-- the member who final-submitted must belong to this very team
alter table teams
  add constraint teams_final_submitted_by_fk foreign key (final_submitted_by, id) references team_members(id, team_id) on delete restrict;

-- One table for every login session (decision A2). member_sessions / admin_sessions / team_sessions below are read-only views.
create table sessions (
  id             uuid primary key default gen_random_uuid(),
  token_hash     bytea not null unique,                  -- sha256 of the cookie value; the token itself is never stored
  kind           session_kind not null,
  staff_id       uuid references staff_users(id) on delete restrict,
  team_id        uuid references teams(id) on delete restrict,
  member_id      uuid references team_members(id) on delete restrict,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoke_reason  text check (revoke_reason in ('LOGOUT', 'SUPERSEDED', 'FULLSCREEN_EXIT', 'ADMIN_DISABLED', 'EXPIRED')),
  ip             inet,
  user_agent     text,
  constraint sessions_principal check (
        (kind = 'STAFF'  and staff_id is not null and member_id is null and team_id is null)
     or (kind = 'MEMBER' and member_id is not null and team_id is not null and staff_id is null)),
  constraint sessions_member_belongs_to_team foreign key (member_id, team_id) references team_members(id, team_id),
  constraint sessions_expiry_after_creation check (expires_at > created_at),
  constraint sessions_revoke_pair check ((revoked_at is null) = (revoke_reason is null))
);
-- at most one live session per member; a new login revokes the old one in the same transaction
create unique index sessions_one_live_member on sessions (member_id) where kind = 'MEMBER' and revoked_at is null;
create index sessions_team_idx  on sessions (team_id)  where revoked_at is null;
create index sessions_staff_idx on sessions (staff_id) where revoked_at is null;
create trigger sessions_touch before update on sessions
  for each row execute function app.touch_updated_at();

-- Read-only role-shaped views over the sessions table (no data is duplicated).
create view member_sessions with (security_invoker = true) as
select s.id, s.team_id, s.member_id, m.slot as member_slot, s.created_at, s.last_seen_at, s.expires_at,
       s.revoked_at, s.revoke_reason, (s.revoked_at is null and s.expires_at > app.now()) as is_live
from sessions s join team_members m on m.id = s.member_id
where s.kind = 'MEMBER';

create view admin_sessions with (security_invoker = true) as
select s.id, s.staff_id, u.role as staff_role, s.created_at, s.last_seen_at, s.expires_at,
       s.revoked_at, s.revoke_reason, (s.revoked_at is null and s.expires_at > app.now()) as is_live
from sessions s join staff_users u on u.id = s.staff_id
where s.kind = 'STAFF';

-- Team-level competition run state (the authoritative Ultimate Team Timer lives on `teams`).
create view team_sessions with (security_invoker = true) as
select t.id as team_id, t.status, t.started_at, t.ends_at, t.ended_at, t.final_submitted_at, t.final_submitted_by,
       t.state_version
from teams t;
