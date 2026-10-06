-- Patch B / migration 9 of 9 — security foundation (decision A2/A3, docs/SECURITY.md SEC-06).
--
-- Model: the browser holds no database credentials that can read or write anything. Every table has row level
-- security ENABLED and FORCED and there are NO policies for anon/authenticated, so the Supabase anon/authenticated
-- keys can see nothing. All access goes through server code using the service role (never exposed to the browser),
-- and, from Phase 5, through SECURITY DEFINER engine functions that check ownership server-side:
--   PARTICIPANT → only their own team (session.team_id), ADMIN → only teams with teams.admin_id = their id,
--   SUPER_ADMIN → everything. Ownership is therefore enforced by the server, never by the client.

do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('alter table public.%I force row level security', t.relname);
  end loop;
end $$;

-- No default exposure through the Supabase Data API: remove every grant from the browser-facing roles.
revoke all on all tables    in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

revoke all on schema app from public, anon, authenticated;
revoke all on all tables    in schema app from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;

-- The server (service role) works through explicit grants. The audit trail and the coin ledger stay append-only.
grant usage on schema public, app to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant select on all tables in schema app to service_role;
grant execute on all functions in schema app to service_role;
revoke update, delete, truncate on audit_events      from service_role;
revoke update, delete, truncate on coin_transactions from service_role;
