-- MQTT spec V3 payloads (ADR 0011).
--
-- * telemetry/gps no longer carries accuracy / satellites.
-- * telemetry/battery no longer carries temperature; temperature, pressure and humidity now
--   come from telemetry/bme_data, stored in the new environment_readings table.
-- * telemetry/signal_strength reports a range (strength_lower_limit / strength_upper_limit)
--   instead of rssi / rsrp / rsrq / sinr.
-- Old columns are dropped: history is kept for 30 days only and the old fields are not sent
-- by V3 firmware.

-- ------------------------------------------------------------------ tables

alter table public.gps_points drop column accuracy, drop column satellites;
comment on table public.gps_points is 'telemetry/gps (spec V3 §1). Points < 5 m from the previous stored one are thinned (rule 10).';

alter table public.battery_readings drop column temperature;
comment on table public.battery_readings is 'telemetry/battery (spec V3 §1).';

alter table public.signal_readings
  drop column rssi, drop column rsrp, drop column rsrq, drop column sinr,
  add column strength_lower_limit real,
  add column strength_upper_limit real;
comment on table public.signal_readings is 'telemetry/signal_strength (spec V3 §1).';

create table public.environment_readings (
  device_id text not null references public.devices (id) on delete cascade,
  ts timestamptz not null,
  received_at timestamptz not null,
  temperature real not null, -- °C
  pressure real not null,    -- hPa or kPa, not fixed by the spec
  humidity real not null check (humidity between 0 and 100),
  primary key (device_id, ts)
);
comment on table public.environment_readings is 'telemetry/bme_data (spec V3 §1).';

alter table public.environment_readings enable row level security;
create policy "members read environment" on public.environment_readings
  for select to authenticated using (public.is_device_member(device_id));

-- The latest temperature now comes from the BME sensor.
alter table public.devices rename column battery_temperature to temperature;
alter table public.devices add column temperature_at timestamptz;

-- ------------------------------------------------------------------ ingestion

create or replace function public.ingest_batch(p_messages jsonb, p_rejected jsonb default '[]'::jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  create temporary table _in on commit drop as
  select
    m ->> 'device_id' as device_id,
    m ->> 'topic' as topic,
    to_timestamp((m ->> 'ts')::double precision) as ts,
    to_timestamp((m ->> 'received_at')::double precision) as received_at,
    coalesce((m ->> 'retained')::boolean, false) as retained,
    m -> 'data' as data
  from jsonb_array_elements(p_messages) as m;

  insert into public.devices as d (id, first_seen_at, last_seen_at)
  select device_id, min(received_at), max(received_at) from _in group by device_id
  on conflict (id) do update
    set last_seen_at = greatest(d.last_seen_at, excluded.last_seen_at);

  insert into public.gps_points (device_id, ts, received_at, latitude, longitude, speed)
  select device_id, ts, received_at,
    (data ->> 'latitude')::double precision, (data ->> 'longitude')::double precision,
    (data ->> 'speed')::real
  from _in where topic = 'telemetry/gps' and not retained
  on conflict do nothing;

  insert into public.battery_readings (device_id, ts, received_at, voltage, percentage, charging)
  select device_id, ts, received_at,
    (data ->> 'voltage')::real, (data ->> 'percentage')::smallint, (data ->> 'charging')::boolean
  from _in where topic = 'telemetry/battery' and not retained
  on conflict do nothing;

  insert into public.signal_readings (device_id, ts, received_at, strength_lower_limit, strength_upper_limit)
  select device_id, ts, received_at,
    (data ->> 'strength_lower_limit')::real, (data ->> 'strength_upper_limit')::real
  from _in where topic = 'telemetry/signal_strength' and not retained
  on conflict do nothing;

  insert into public.environment_readings (device_id, ts, received_at, temperature, pressure, humidity)
  select device_id, ts, received_at,
    (data ->> 'temperature')::real, (data ->> 'pressure')::real, (data ->> 'humidity')::real
  from _in where topic = 'telemetry/bme_data' and not retained
  on conflict do nothing;

  insert into public.device_messages (device_id, topic, ts, received_at, payload, dedupe_key)
  select device_id, topic, ts, received_at, data,
    md5(device_id || '|' || topic || '|' || extract(epoch from ts)::text || '|' || data::text)
  from _in where topic not like 'telemetry/%' and not retained
  on conflict (dedupe_key) do nothing;

  -- Latest state: newest reading per device, never moving backwards in time.
  update public.devices d
  set latitude = g.lat, longitude = g.lon, location_at = g.ts
  from (
    select distinct on (device_id) device_id, ts,
      (data ->> 'latitude')::double precision as lat, (data ->> 'longitude')::double precision as lon
    from _in where topic = 'telemetry/gps' order by device_id, ts desc
  ) g
  where d.id = g.device_id and (d.location_at is null or g.ts >= d.location_at);

  update public.devices d
  set battery_percent = b.pct, battery_at = b.ts
  from (
    select distinct on (device_id) device_id, ts, (data ->> 'percentage')::smallint as pct
    from _in where topic = 'telemetry/battery' order by device_id, ts desc
  ) b
  where d.id = b.device_id and (d.battery_at is null or b.ts >= d.battery_at);

  update public.devices d
  set temperature = e.temp, temperature_at = e.ts
  from (
    select distinct on (device_id) device_id, ts, (data ->> 'temperature')::real as temp
    from _in where topic = 'telemetry/bme_data' order by device_id, ts desc
  ) e
  where d.id = e.device_id and (d.temperature_at is null or e.ts >= d.temperature_at);

  update public.devices d
  set connectivity = c.status, connectivity_at = c.ts
  from (
    select distinct on (device_id) device_id, received_at as ts, data ->> 'status' as status
    from _in where topic = 'status/connectivity' order by device_id, received_at desc
  ) c
  where d.id = c.device_id and (d.connectivity_at is null or c.ts >= d.connectivity_at);

  update public.devices d
  set firmware_version = s.fw
  from (
    select distinct on (device_id) device_id, data ->> 'firmware_version' as fw
    from _in where topic = 'status/system' and data ? 'firmware_version'
    order by device_id, ts desc
  ) s
  where d.id = s.device_id;

  insert into public.rejected_messages (received_at, topic, device_id, reason, issues)
  select to_timestamp((r ->> 'received_at')::double precision), r ->> 'topic', r ->> 'device_id',
    r ->> 'reason',
    coalesce(array(select jsonb_array_elements_text(r -> 'issues')), '{}')
  from jsonb_array_elements(p_rejected) as r;
end;
$$;

-- ------------------------------------------------------------------ clearing data

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
  delete from public.environment_readings where p_device_id is null or device_id = p_device_id;
  get diagnostics c = row_count; n := n + c;
  delete from public.device_messages where p_device_id is null or device_id = p_device_id;
  get diagnostics c = row_count; n := n + c;
  delete from public.rejected_messages where p_device_id is null or device_id = p_device_id;
  get diagnostics c = row_count; n := n + c;

  delete from public.devices d
  where (p_device_id is null or d.id = p_device_id)
    and not exists (select 1 from public.device_members m where m.device_id = d.id);
  update public.devices
  set connectivity = null, connectivity_at = null, latitude = null, longitude = null,
      location_at = null, battery_percent = null, battery_at = null,
      temperature = null, temperature_at = null
  where p_device_id is null or id = p_device_id;
  return n;
end;
$$;

-- ------------------------------------------------------------------ retention (rule 10)

-- Same job name: pg_cron replaces the existing schedule.
select cron.schedule(
  'dog-tracker-retention',
  '17 3 * * *',
  $$
    delete from public.gps_points where ts < now() - interval '30 days';
    delete from public.battery_readings where ts < now() - interval '30 days';
    delete from public.signal_readings where ts < now() - interval '30 days';
    delete from public.environment_readings where ts < now() - interval '30 days';
    delete from public.device_messages where category = 'diagnostic' and ts < now() - interval '7 days';
    delete from public.device_messages where ts < now() - interval '30 days';
    delete from public.rejected_messages where received_at < now() - interval '7 days';
  $$
);
