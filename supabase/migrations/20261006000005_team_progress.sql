-- Patch B / migration 5 of 9 — per-team progress: unlocked themes, question states and timers, drafts, hints.

create table team_themes (               -- a row exists iff the theme is unlocked
  team_id      uuid not null references teams(id) on delete restrict,
  theme_id     smallint not null references themes(id) on delete restrict,
  unlocked_by  uuid not null,
  unlocked_at  timestamptz not null,
  cost_paid    int not null check (cost_paid >= 0),
  primary key (team_id, theme_id),
  constraint team_themes_member_in_team foreign key (unlocked_by, team_id) references team_members(id, team_id) on delete restrict
);

-- 5 rows are created when a theme is unlocked: Q1 AVAILABLE (no timer until a participant enters it → start_question),
-- Q2..Q5 LOCKED. A question timer starts when the question becomes ACTIVE — never at theme unlock.
create table team_questions (
  team_id                 uuid not null references teams(id) on delete restrict,
  question_id             smallint not null,
  theme_id                smallint not null,                    -- denormalised for indexes; kept consistent by the FK below
  ordinal                 smallint not null check (ordinal between 1 and 5),
  state                   question_state not null default 'LOCKED',
  timer_deadline          timestamptz,            -- set iff ACTIVE (authoritative, shared by all members)
  timer_remaining_seconds int,                    -- set iff PENDING_APPROVAL (timer frozen while approval is pending)
  extra_seconds           int not null default 0 check (extra_seconds >= 0),   -- total purchased, informational
  time_purchase_count     int not null default 0 check (time_purchase_count >= 0),
  activated_at            timestamptz,            -- set when the question becomes ACTIVE (the timer start)
  approved_at             timestamptz,
  timed_out_at            timestamptz,
  primary key (team_id, question_id),
  constraint team_questions_question_fk foreign key (question_id, theme_id) references questions(id, theme_id) on delete restrict,
  constraint team_questions_theme_unlocked_fk foreign key (team_id, theme_id) references team_themes(team_id, theme_id) on delete restrict,
  constraint team_questions_active_has_deadline   check ((state = 'ACTIVE') = (timer_deadline is not null)),
  constraint team_questions_pending_has_remaining check ((state = 'PENDING_APPROVAL') = (timer_remaining_seconds is not null)),
  constraint team_questions_remaining_nonneg      check (timer_remaining_seconds is null or timer_remaining_seconds >= 0),
  -- LOCKED and AVAILABLE questions have never been started: no timer start is recorded
  constraint team_questions_unstarted_no_activation check ((state in ('LOCKED', 'AVAILABLE')) = (activated_at is null)),
  -- INV-04: only Q1 is ever AVAILABLE (Q2..Q5 go LOCKED -> ACTIVE when the previous question is approved)
  constraint team_questions_available_only_q1 check (state <> 'AVAILABLE' or ordinal = 1),
  constraint team_questions_approved_at  check ((state = 'APPROVED')  = (approved_at is not null)),
  constraint team_questions_timed_out_at check ((state = 'TIMED_OUT') = (timed_out_at is not null))
);
create index tq_team_state_idx on team_questions (team_id, state);
create index tq_due_idx        on team_questions (timer_deadline) where state = 'ACTIVE';   -- timeout sweeper

-- QN+1 cannot become ACTIVE / PENDING_APPROVAL / APPROVED / TIMED_OUT until QN is APPROVED (database-level guard).
create function app.question_order_guard() returns trigger language plpgsql as $$
begin
  if new.ordinal > 1
     and new.state in ('ACTIVE', 'PENDING_APPROVAL', 'APPROVED', 'TIMED_OUT')
     and not exists (select 1 from team_questions p
                      where p.team_id = new.team_id and p.theme_id = new.theme_id
                        and p.ordinal = new.ordinal - 1 and p.state = 'APPROVED') then
    raise exception 'QUESTION_PREVIOUS_NOT_APPROVED' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger team_questions_order before insert or update of state on team_questions
  for each row execute function app.question_order_guard();

create table answer_drafts (             -- one shared draft per team+question; KEPT after a rejection (locked UI-2.1 rule)
  team_id      uuid not null references teams(id) on delete restrict,
  question_id  smallint not null references questions(id) on delete restrict,
  answer       text not null default '',
  explanation  text not null default '',
  version      int  not null default 0,  -- optimistic concurrency (see API_SPEC saveDraft)
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  primary key (team_id, question_id),
  constraint answer_drafts_length check (length(answer) <= 10000 and length(explanation) <= 10000),
  constraint answer_drafts_member_in_team foreign key (updated_by, team_id) references team_members(id, team_id) on delete restrict
);

create table hint_purchases (
  team_id       uuid not null references teams(id) on delete restrict,
  hint_id       smallint not null references hints(id) on delete restrict,
  purchased_by  uuid not null,
  cost_paid     int not null check (cost_paid >= 0),
  purchased_at  timestamptz not null,
  primary key (team_id, hint_id),        -- a team can never pay twice for the same hint
  constraint hint_purchases_member_in_team foreign key (purchased_by, team_id) references team_members(id, team_id) on delete restrict
);

-- Tier 2 requires Tier 1 of the same question (second guard; buy_hint will check first, under the team lock)
create function app.hint_tier_order() returns trigger language plpgsql as $$
begin
  if (select tier from hints where id = new.hint_id) = 2
     and not exists (select 1
                       from hint_purchases p
                       join hints h1 on h1.id = p.hint_id and h1.tier = 1
                      where p.team_id = new.team_id
                        and h1.question_id = (select question_id from hints where id = new.hint_id)) then
    raise exception 'HINT_TIER1_REQUIRED' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger hint_purchases_tier_order before insert on hint_purchases
  for each row execute function app.hint_tier_order();
