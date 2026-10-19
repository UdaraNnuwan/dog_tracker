-- Admin role (ADR 0010): users with app_metadata.role = 'admin' have every privilege.
-- app_metadata can only be written with the secret key (`pnpm seed:users --admin …`), so a
-- user can never promote themselves. Today the browser reads through the Worker (service
-- role); these policies make the same rule hold once it reads Supabase directly (phase 5).

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

-- Admins count as members of every device: all "members read …" policies now include them.
create or replace function public.is_device_member(p_device_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1 from public.device_members m
    where m.device_id = p_device_id and m.user_id = (select auth.uid())
  );
$$;

-- What members can't see, admins can: every membership, device-less log lines, rejections.
create policy "admins read memberships" on public.device_members
  for select to authenticated using (public.is_admin());
create policy "admins read all logs" on public.pipeline_logs
  for select to authenticated using (public.is_admin());
create policy "admins read rejected messages" on public.rejected_messages
  for select to authenticated using (public.is_admin());
