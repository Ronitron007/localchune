-- RLS filters rows only AFTER Postgres' table-level ACL check passes.
-- Supabase's current default gives anon/authenticated/service_role only Dxtm
-- on new tables, so a policy without a matching GRANT never runs.
-- service_role's BYPASSRLS skips row filtering, NOT the ACL.
grant select on public.members, public.credit_grants to authenticated;
grant select, insert, update, delete
   on public.allowlist, public.members, public.credit_grants to service_role;

-- allowlist is deliberately NOT granted to authenticated: it has zero policies
-- for that role and must stay invisible to clients. Owners reach it only via
-- the security definer functions added in a later task.
