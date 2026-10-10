-- Turns a freshly built database (migrations, then seed.sql) back into the PLACEHOLDER content the pre-B17 tests were written against.
--
-- Since B17 a fresh database holds the OFFICIAL content: migration 19 installs it while the content tables are still empty, and
-- supabase/seed.sql (which runs after the migrations and is ON CONFLICT DO NOTHING) leaves it alone. The older SQL tests, however,
-- assert on seed values (reward 50, "[DEV PLACEHOLDER] ..." text, hint texts). Rather than rewrite them, db-verify runs this file once
-- after the "fresh" tests (supabase/tests/fresh) and before the ordinary ones: it deletes the content rows and lets seed.sql
-- fill them again, so the placeholder state is produced by the real seed, not by a second copy of its values.
--
-- Only ever run on a scratch database with no team data (the guard below refuses otherwise).
-- audit_events is append-only and is not touched; tests that count audit rows therefore compare against a baseline.
\set ON_ERROR_STOP on
do $$ begin
  assert not exists (select 1 from teams), 'placeholder_content.sql: refusing to run on a database that has teams';
end $$;
-- (delete, not truncate: a cascading truncate would reach the append-only coin ledger, which refuses it; with no team data nothing refers to these rows)
delete from hints;
delete from question_buy_time_options;
delete from question_keys;
delete from questions;
delete from themes;
\ir ../../seed.sql
