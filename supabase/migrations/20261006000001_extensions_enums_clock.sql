-- Patch B / migration 1 of 9 — extensions, canonical enums, the app schema and the controllable clock.
-- Source: docs/DATA_MODEL.md §2, §3 (reconciled with the locked amendments; see docs/DATABASE_FOUNDATION.md).

create extension if not exists citext;
create extension if not exists pgcrypto;

-- Supabase already provides these roles. They are created only on a plain PostgreSQL (CI / local verification).
do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin;
exception when duplicate_object then null; end $$;

-- Canonical state names (locked; do not rename).
create type competition_status as enum ('SETUP', 'RUNNING', 'PAUSED', 'ENDED');
create type team_status        as enum ('NOT_STARTED', 'RUNNING', 'FINAL_SUBMITTED', 'ENDED', 'DISQUALIFIED');
create type question_state     as enum ('LOCKED', 'AVAILABLE', 'ACTIVE', 'PENDING_APPROVAL', 'APPROVED', 'TIMED_OUT');
create type submission_status  as enum ('PENDING', 'APPROVED', 'REJECTED');
create type staff_role         as enum ('SUPER_ADMIN', 'ADMIN');          -- PARTICIPANT is not a staff role
create type session_kind       as enum ('STAFF', 'MEMBER');
create type presence_state     as enum ('OFFLINE', 'ONLINE');
create type difficulty         as enum ('EASY', 'MEDIUM', 'HARD');
create type coin_tx_type       as enum ('INITIAL_GRANT', 'THEME_UNLOCK', 'HINT_PURCHASE',
                                        'TIME_PURCHASE', 'QUESTION_REWARD', 'ADMIN_ADJUSTMENT');

create schema if not exists app;

-- The single time source for every competition rule. In production it is clock_timestamp();
-- tests may switch the clock with `set app.allow_test_clock = 'on'; set app.test_now = '...'`.
create function app.now() returns timestamptz language sql stable as $$
  select case
    when current_setting('app.allow_test_clock', true) = 'on'
     and nullif(current_setting('app.test_now', true), '') is not null
    then current_setting('app.test_now')::timestamptz
    else clock_timestamp()
  end
$$;

create function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
