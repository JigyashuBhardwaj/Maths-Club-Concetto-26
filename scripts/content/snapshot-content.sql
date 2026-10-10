-- B17 rollback support (HUMAN-RUN, read-only): saves the CURRENT content columns to three CSV files in the current directory,
-- BEFORE migration 19 is applied. Nothing is written to the database.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/content/snapshot-content.sql
--
-- Produces b17_themes_before.csv, b17_questions_before.csv, b17_hints_before.csv (and prints the row counts, which must be 10 / 50 / 100).
-- Keep these files until the release has been accepted. restore-content.sql puts exactly these values back.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

select 'themes=' || count(*) from themes;
select 'questions=' || count(*) from questions;
select 'hints=' || count(*) from hints;

\copy (select id, name, description from themes order by id) to 'b17_themes_before.csv' with (format csv, header true)
\copy (select id, body_md, reward_coins from questions order by id) to 'b17_questions_before.csv' with (format csv, header true)
\copy (select id, body_md from hints order by id) to 'b17_hints_before.csv' with (format csv, header true)
