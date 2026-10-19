-- Saved processing log of the bridge (ADR 0008): one line per inbound message (accepted,
-- stored, thinned, rejected…) plus bridge/storage/demo events. `debug` lines (raw IMU) are
-- live only and never written here.

create table public.pipeline_logs (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  level text not null check (level in ('info', 'warn', 'error')),
  source text not null check (source in ('ingest', 'bridge', 'storage', 'demo')),
  -- No foreign key: lines for rejected/unknown devices are kept, and logs outlive a device row.
  device_id text check (device_id ~ '^[a-z0-9_-]{1,64}$'),
  topic text,
  message text not null,
  detail jsonb
);
create index pipeline_logs_at on public.pipeline_logs (at desc, id desc);
create index pipeline_logs_device_at on public.pipeline_logs (device_id, at desc);
comment on table public.pipeline_logs is 'Bridge processing log (ADR 0008). Written by the bridge with the service role.';

alter table public.pipeline_logs enable row level security;

-- Members read lines of their devices. Device-less lines (bridge, storage) are service role only.
create policy "members read device logs" on public.pipeline_logs
  for select to authenticated
  using (device_id is not null and public.is_device_member(device_id));

-- ------------------------------------------------------------------ clearing data

-- Same as before, plus the device's log lines (all lines when clearing everything).
create or replace function public.clear_history(p_device_id text default null)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  n bigint := 0;
  c bigint;
begin
  delete from public.gps_points where p_device_id is null or device_id = p_device_id;
  get diagnostics c = row_count; n := n + c;
  delete from public.battery_readings where p_device_id is null or device_id = p_device_id;
  get diagnostics c = row_count; n := n + c;
  delete from public.signal_readings where p_device_id is null or device_id = p_device_id;
  get diagnostics c = row_count; n := n + c;
  delete from public.device_messages where p_device_id is null or device_id = p_device_id;
  get diagnostics c = row_count; n := n + c;
  delete from public.rejected_messages where p_device_id is null or device_id = p_device_id;
  get diagnostics c = row_count; n := n + c;
  delete from public.pipeline_logs where p_device_id is null or device_id = p_device_id;
  get diagnostics c = row_count; n := n + c;

  delete from public.devices d
  where (p_device_id is null or d.id = p_device_id)
    and not exists (select 1 from public.device_members m where m.device_id = d.id);
  update public.devices
  set connectivity = null, connectivity_at = null, latitude = null, longitude = null,
      location_at = null, battery_percent = null, battery_temperature = null, battery_at = null
  where p_device_id is null or id = p_device_id;
  return n;
end;
$$;

revoke execute on function public.clear_history(text) from public, anon, authenticated;
grant execute on function public.clear_history(text) to service_role;

-- ------------------------------------------------------------------ retention (rule 10)

-- One line per message adds up fast (~200 bytes each): info lines are kept 3 days,
-- warnings and errors 14 days. Hourly so a busy day never piles up (ADR 0008).
select cron.schedule(
  'dog-tracker-log-retention',
  '23 * * * *',
  $$
    delete from public.pipeline_logs where level = 'info' and at < now() - interval '3 days';
    delete from public.pipeline_logs where at < now() - interval '14 days';
  $$
);
