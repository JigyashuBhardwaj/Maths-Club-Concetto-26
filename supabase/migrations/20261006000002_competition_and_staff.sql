-- Patch B / migration 2 of 9 — the single competition row and staff accounts.

create table competition (
  id                          smallint primary key default 1 check (id = 1),
  status                      competition_status not null default 'SETUP',
  -- LOCKED: the Ultimate Team Timer is 2 hours = 7,200 s = 120 min (supersedes the Phase 0 value).
  ultimate_seconds            int  not null default 7200,
  ultimate_minutes            int  generated always as (ultimate_seconds / 60) stored,
  initial_coins               int  not null default 500,
  points_per_completed_theme  int  not null default 500,
  points_per_solved_question  int  not null default 100,
  penalty_per_minute          int  not null default 5,
  -- UFM (locked): a reset-adjusted score never goes below reset_floor_score; a disqualified team is pinned one below it.
  reset_floor_score           int  not null default -1200,
  disqualified_score          int  not null default -1201,
  opened_at                   timestamptz,                   -- SETUP -> RUNNING
  paused_at                   timestamptz,                   -- set while PAUSED
  ended_at                    timestamptz,
  state_version               bigint not null default 0,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint competition_ultimate_locked_7200 check (ultimate_seconds = 7200),
  constraint competition_initial_coins_nonneg check (initial_coins >= 0),
  constraint competition_ufm_floor_locked     check (reset_floor_score = -1200 and disqualified_score = reset_floor_score - 1),
  constraint competition_paused_has_timestamp check ((status = 'PAUSED') = (paused_at is not null)),
  constraint competition_ended_has_timestamp  check ((status = 'ENDED') = (ended_at is not null))
);
create trigger competition_touch before update on competition
  for each row execute function app.touch_updated_at();

create table staff_users (
  id            uuid primary key default gen_random_uuid(),
  username      citext not null unique,
  display_name  text   not null,
  password_hash text   not null,                 -- argon2id (or bcrypt fallback); never a plaintext password
  role          staff_role not null,
  is_active     boolean not null default true,
  created_by    uuid references staff_users(id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_login_at timestamptz,
  -- the Super Admin is provisioned out of band; every ADMIN is created by (and traceable to) a staff member
  constraint staff_admin_has_creator check (role = 'SUPER_ADMIN' or created_by is not null)
);
-- exactly one Super Admin can ever exist
create unique index staff_one_super_admin on staff_users ((role)) where role = 'SUPER_ADMIN';
create trigger staff_users_touch before update on staff_users
  for each row execute function app.touch_updated_at();
