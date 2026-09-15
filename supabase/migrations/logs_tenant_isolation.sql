-- Tenant isolation for the automation log (SaaS-readiness).
-- tempo_automation_logs had NO user_id and a policy that let ANY authenticated
-- user read ALL rows — a cross-teacher leak. Scope it to the owning teacher,
-- like every other table.
-- Run in: Supabase Dashboard → SQL Editor (clear the editor first).

alter table tempo_automation_logs
  add column if not exists user_id uuid;

-- Replace the permissive read policy with owner-only.
drop policy if exists "authenticated_read" on tempo_automation_logs;
drop policy if exists "owner_all" on tempo_automation_logs;
create policy "owner_all" on tempo_automation_logs
  for all using (auth.uid() = user_id);

-- Fast per-teacher lookups for the activity feed.
create index if not exists idx_logs_user_id
  on tempo_automation_logs (user_id);

-- NOTE: existing rows keep user_id = null and become invisible to everyone
-- (they are old single-teacher test logs). New rows are stamped with the
-- owning teacher by the redeployed Edge Functions.
