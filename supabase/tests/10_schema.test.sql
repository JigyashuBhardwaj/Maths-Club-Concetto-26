-- Schema structure: tables, enums, keys, constraints, indexes, security flags.
begin;
\ir include/helpers.sql

do $$
declare missing text;
begin
  select string_agg(t, ', ') into missing from unnest(array[
    'competition','staff_users','teams','team_members','sessions','themes','questions','question_keys','hints',
    'team_themes','team_questions','answer_drafts','hint_purchases','submissions','coin_transactions',
    'request_log','audit_events','leaderboard_snapshot','auth_throttle','ufm_challenges']) t
   where to_regclass('public.' || t) is null;
  assert missing is null, 'missing tables: ' || missing;
  assert to_regclass('public.member_sessions') is not null and to_regclass('public.admin_sessions') is not null
     and to_regclass('public.team_sessions') is not null, 'session views missing';
  assert to_regclass('public.team_theme_progress') is not null and to_regclass('public.member_presence') is not null;
  assert to_regclass('app.invariant_coin_balance_mismatch') is not null and to_regclass('app.invariant_team_member_count') is not null;
end $$;

-- canonical enum labels (spelling and order are part of the contract)
do $$
declare e record;
begin
  for e in select * from (values
      ('competition_status', 'SETUP,RUNNING,PAUSED,ENDED'),
      ('team_status',        'NOT_STARTED,RUNNING,FINAL_SUBMITTED,ENDED,DISQUALIFIED'),
      ('question_state',     'LOCKED,AVAILABLE,ACTIVE,PENDING_APPROVAL,APPROVED,TIMED_OUT'),
      ('submission_status',  'PENDING,APPROVED,REJECTED'),
      ('staff_role',         'SUPER_ADMIN,ADMIN'),
      ('presence_state',     'OFFLINE,ONLINE'),
      ('session_kind',       'STAFF,MEMBER'),
      ('coin_tx_type',       'INITIAL_GRANT,THEME_UNLOCK,HINT_PURCHASE,TIME_PURCHASE,QUESTION_REWARD,ADMIN_ADJUSTMENT')
    ) v(name, labels) loop
    assert (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
             where enumtypid = (e.name)::regtype) = e.labels, 'enum ' || e.name || ' labels differ';
  end loop;
end $$;

-- named constraints that carry the locked rules must exist
do $$
declare c text;
begin
  foreach c in array array[
    'competition_ultimate_locked_7200','competition_ufm_floor_locked','teams_started_iff_not_not_started',
    'teams_reset_columns_paired','teams_disqualified_score','teams_final_submit_columns','teams_terminal_has_ended_at',
    'themes_code_matches_id','questions_id_matches_position','team_questions_active_has_deadline',
    'team_questions_pending_has_remaining','team_questions_unstarted_no_activation','team_questions_theme_unlocked_fk',
    'team_questions_question_fk','submissions_reviewed_iff_decided','coin_tx_sign','coin_tx_subject',
    'sessions_principal','sessions_member_belongs_to_team','staff_admin_has_creator'] loop
    assert exists (select 1 from pg_constraint where conname = c), 'constraint missing: ' || c;
  end loop;
end $$;

-- unique indexes that enforce one-of-a-kind rules
do $$
declare i text;
begin
  foreach i in array array['staff_one_super_admin','sessions_one_live_member','submissions_one_pending','ctx_initial',
                           'ctx_theme','ctx_hint','ctx_reward','ctx_time'] loop
    assert exists (select 1 from pg_indexes where schemaname = 'public' and indexname = i and indexdef like 'CREATE UNIQUE%'),
           'unique index missing: ' || i;
  end loop;
  -- query-path / sweeper indexes
  foreach i in array array['teams_due_idx','tq_due_idx','tq_team_state_idx','submissions_queue_idx','submissions_team_idx',
                           'ctx_team_idx','audit_team_idx','audit_type_idx','sessions_team_idx','teams_admin_idx'] loop
    assert exists (select 1 from pg_indexes where schemaname = 'public' and indexname = i), 'index missing: ' || i;
  end loop;
end $$;

-- foreign keys: nothing cascades (history is never deleted), every FK is explicit
do $$
begin
  assert (select count(*) from pg_constraint c join pg_class r on r.oid = c.conrelid
           where c.contype = 'f' and r.relnamespace = 'public'::regnamespace) >= 30, 'expected at least 30 foreign keys';
  assert not exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
                      where c.contype = 'f' and r.relnamespace = 'public'::regnamespace and c.confdeltype in ('c', 'n', 'd')),
         'no foreign key may cascade or null on delete';
end $$;

-- security foundation: RLS enabled AND forced on every table, no policies, no browser-role privileges
do $$
begin
  assert not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                      and not (c.relrowsecurity and c.relforcerowsecurity)), 'every table must have RLS enabled and forced';
  assert not exists (select 1 from pg_policies where schemaname = 'public'), 'no policies may exist for anon/authenticated';
  assert not exists (select 1 from information_schema.role_table_grants
                      where table_schema in ('public', 'app') and grantee in ('anon', 'authenticated', 'PUBLIC')),
         'anon/authenticated/PUBLIC must hold no table privileges';
  assert not has_table_privilege('anon', 'public.teams', 'select') and not has_table_privilege('authenticated', 'public.question_keys', 'select');
  assert not has_schema_privilege('anon', 'app', 'usage');
  assert has_table_privilege('service_role', 'public.teams', 'select');
  assert not has_table_privilege('service_role', 'public.audit_events', 'update') and not has_table_privilege('service_role', 'public.coin_transactions', 'delete');
end $$;

-- the schema never stores a plaintext credential column or a service key
do $$
begin
  assert not exists (select 1 from information_schema.columns where table_schema = 'public'
                      and column_name in ('password', 'plaintext_password', 'service_key', 'secret')), 'no plaintext credential columns';
end $$;
rollback;
