-- Firmware releases for over-the-air updates (ADR 0012).
--
-- An admin uploads a firmware file with its version from the dashboard's Firmware tab. The
-- Worker stores the file in the private `firmware` Storage bucket and a row here. At most one
-- release is active: collars call `GET /api/firmware/check` with their version and download
-- the active release when it differs. Only the Worker (secret key) writes; admins can read.

create table public.firmware_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null unique
    check (length(version) <= 64 and version ~ '^\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$'),
  file_name text not null check (length(file_name) between 1 and 255),
  -- Object path in the `firmware` bucket.
  storage_path text not null unique,
  size_bytes bigint not null check (size_bytes > 0),
  -- Lowercase hex SHA-256 of the file: the collar verifies its download against it.
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  notes text check (length(notes) <= 2000),
  active boolean not null default false,
  uploaded_by text not null,
  uploaded_at timestamptz not null default now()
);
create unique index firmware_releases_one_active on public.firmware_releases (active) where active;
comment on table public.firmware_releases is 'Uploaded firmware files; the active one is offered to collars (ADR 0012).';

alter table public.firmware_releases enable row level security;

create policy "admins read firmware releases" on public.firmware_releases
  for select to authenticated using (public.is_admin());

-- Makes one release the active one (or none, with null) in a single transaction.
create or replace function public.activate_firmware(p_id uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.firmware_releases set active = false where active and id is distinct from p_id;
  if p_id is not null then
    update public.firmware_releases set active = true where id = p_id;
    if not found then
      raise exception 'firmware release % not found', p_id using errcode = 'P0002';
    end if;
  end if;
end;
$$;

revoke execute on function public.activate_firmware(uuid) from public, anon, authenticated;
grant execute on function public.activate_firmware(uuid) to service_role;

-- ------------------------------------------------------------------ storage

-- Private bucket: no storage policies, so only the secret key (the Worker) reads or writes.
-- 32 MiB is far above any collar image and below the free plan's 50 MB per-file limit.
insert into storage.buckets (id, name, public, file_size_limit)
values ('firmware', 'firmware', false, 33554432)
on conflict (id) do nothing;
