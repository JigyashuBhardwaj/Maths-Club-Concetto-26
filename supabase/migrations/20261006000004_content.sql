-- Patch B / migration 4 of 9 — competition content: 10 themes (A–J) × 5 questions = 50 questions, hints, reviewer keys.
-- Content is seeded (supabase/seed.sql) and read-only at runtime. There are NO themes K or L.

create table themes (
  id            smallint primary key check (id between 1 and 10),
  code          char(1) not null unique check (code between 'A' and 'J'),   -- 'A'..'J' (admin matrix columns)
  name          text not null,
  description   text not null,
  topics        text[] not null default '{}',
  difficulty    difficulty not null,
  unlock_cost   int not null check (unlock_cost >= 0),          -- configurable content data, not a code constant
  display_order smallint not null unique,
  -- the code is the id'th letter of the alphabet: 1 = A ... 10 = J
  constraint themes_code_matches_id check (code = chr(64 + id))
);

create table questions (
  id                  smallint primary key check (id between 1 and 50),
  theme_id            smallint not null references themes(id) on delete restrict,
  ordinal             smallint not null check (ordinal between 1 and 5),
  body_md             text not null,                            -- Markdown + KaTeX (decision DEC-15)
  difficulty          difficulty not null,
  reward_coins        int not null check (reward_coins >= 0),   -- fixed per question; an admin never chooses it
  time_limit_seconds  int not null check (time_limit_seconds > 0),   -- the per-question timer (4:00 in the seed)
  buy_time_seconds    int not null check (buy_time_seconds > 0),
  buy_time_cost       int not null check (buy_time_cost >= 0),
  max_time_purchases  int check (max_time_purchases is null or max_time_purchases >= 0),   -- null = unlimited
  unique (theme_id, ordinal),
  unique (id, theme_id),                                         -- lets progress tables prove question ↔ theme agreement
  constraint questions_id_matches_position check (id = (theme_id - 1) * 5 + ordinal)
);

-- reviewer-only material, kept in a separate table so it can never ride along in a participant query
create table question_keys (
  question_id       smallint primary key references questions(id) on delete restrict,
  reference_answer  text not null,
  solution_notes    text
);

create table hints (
  id           smallint primary key check (id between 1 and 100),
  question_id  smallint not null references questions(id) on delete restrict,
  tier         smallint not null check (tier in (1, 2)),
  body_md      text not null,
  cost         int not null check (cost >= 0),                  -- configurable content data
  unique (question_id, tier),
  unique (id, question_id)
);
