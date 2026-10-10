-- B17 rollback (HUMAN-RUN): puts back the content columns saved by snapshot-content.sql. Run it in the directory that holds the
-- three b17_*_before.csv files.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/content/restore-content.sql
--
-- Like migration 19 it changes content columns only (themes.name / description, questions.body_md / reward_coins, hints.body_md):
-- no team, ledger, timer, submission, hint purchase, score or penalty is touched. One transaction: everything or nothing.
-- Caution: a submission approved AFTER migration 19 keeps the reward it was paid then; restoring the old reward does not
-- claw coins back (the ledger is append-only by design). Roll back before the competition opens, or accept that.
\set ON_ERROR_STOP on
begin;

create temp table b17_t (id int, name text, description text) on commit drop;
create temp table b17_q (id int, body_md text, reward_coins int) on commit drop;
create temp table b17_h (id int, body_md text) on commit drop;
\copy b17_t from 'b17_themes_before.csv' with (format csv, header true)
\copy b17_q from 'b17_questions_before.csv' with (format csv, header true)
\copy b17_h from 'b17_hints_before.csv' with (format csv, header true)

do $restore$
declare
  n_t int; n_q int; n_h int;
begin
  if (select count(*) from b17_t) <> 10 or (select count(*) from b17_q) <> 50 or (select count(*) from b17_h) <> 100 then
    raise exception 'restore: the snapshot files must hold 10 themes, 50 questions and 100 hints';
  end if;

  update themes t set name = s.name, description = s.description from b17_t s
   where t.id = s.id and (t.name, t.description) is distinct from (s.name, s.description);
  get diagnostics n_t = row_count;
  update questions q set body_md = s.body_md, reward_coins = s.reward_coins from b17_q s
   where q.id = s.id and (q.body_md, q.reward_coins) is distinct from (s.body_md, s.reward_coins);
  get diagnostics n_q = row_count;
  update hints h set body_md = s.body_md from b17_h s
   where h.id = s.id and h.body_md is distinct from s.body_md;
  get diagnostics n_h = row_count;

  if n_t + n_q + n_h > 0 then
    insert into audit_events (occurred_at, actor_kind, event_type, entity_type, entity_id, payload)
    values (clock_timestamp(), 'SYSTEM', 'CONTENT_RESTORED', 'COMPETITION', '1',
            jsonb_build_object('themes_changed', n_t, 'questions_changed', n_q, 'hints_changed', n_h));
  end if;
  raise notice 'content restored: % themes, % questions, % hints', n_t, n_q, n_h;
end $restore$;

commit;
