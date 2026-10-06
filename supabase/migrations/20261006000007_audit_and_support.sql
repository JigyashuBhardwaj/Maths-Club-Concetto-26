-- Patch B / migration 7 of 9 — idempotency log, append-only audit trail and supporting tables.

create table request_log (
  team_id       uuid not null,                   -- or the staff id for staff operations
  idem_key      uuid not null,                   -- client-generated Idempotency-Key
  operation     text not null,
  response      jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (team_id, idem_key)
);
create index request_log_created_idx on request_log (created_at);   -- hourly purge

-- Event types are catalogued in docs/STATE_MACHINE.md §8 (kept as text so the catalogue can grow without a migration).
create table audit_events (
  id              bigserial primary key,
  occurred_at     timestamptz not null default now(),
  actor_kind      text not null check (actor_kind in ('STAFF', 'MEMBER', 'SYSTEM')),
  staff_id        uuid,
  member_id       uuid,
  team_id         uuid,
  event_type      text not null check (event_type <> ''),
  entity_type     text,
  entity_id       text,
  payload         jsonb not null default '{}',   -- before/after values, amounts, reasons
  request_id      uuid,
  ip              inet,
  constraint audit_actor_matches_kind check (
        (actor_kind = 'STAFF'  and staff_id is not null)
     or (actor_kind = 'MEMBER' and member_id is not null)
     or (actor_kind = 'SYSTEM'))
);
create index audit_team_idx on audit_events (team_id, id);
create index audit_type_idx on audit_events (event_type, id);

create function app.audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_events is append-only'; end $$;
create trigger audit_no_update before update or delete on audit_events
  for each row execute function app.audit_immutable();
create trigger audit_no_truncate before truncate on audit_events
  for each statement execute function app.audit_immutable();
revoke update, delete, truncate on audit_events from public, anon, authenticated, service_role;

create table leaderboard_snapshot (      -- single row, refreshed at most every 60 s
  id           smallint primary key default 1 check (id = 1),
  computed_at  timestamptz not null,
  rows         jsonb not null              -- [{rank, team_id, team_name, score, status}]
);

create table auth_throttle (             -- login rate limiting; keyed per account, NOT per IP
  key           text primary key,        -- 'team:<login_id>' | 'staff:<username>'
  window_start  timestamptz not null,
  attempts      int not null check (attempts >= 0),
  locked_until  timestamptz
);

create table ufm_challenges (            -- server-side second step for destructive admin actions (two-step confirmation)
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff_users(id) on delete restrict,
  team_id     uuid not null references teams(id) on delete restrict,
  action      text not null check (action in ('RESET_SCORE', 'DISQUALIFY')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index ufm_challenges_team_idx on ufm_challenges (team_id);
