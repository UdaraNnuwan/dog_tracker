-- Phase 4: storage for everything the bridge ingests (ADR 0006).
--
-- Every row has two times:
--   ts           device time from the payload `timestamp` (spec §3), what charts use
--   received_at  when the bridge received the message (server clock)
-- The bridge writes through `ingest_batch` with the Supabase secret key (service_role).
-- Browsers only read, under RLS, devices they are members of (CLAUDE.md "Auth").

-- ------------------------------------------------------------------ tables

create table public.devices (
  id text primary key check (id ~ '^[a-z0-9_-]{1,64}$'),
  name text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Latest known state, maintained by ingest_batch.
  connectivity text check (connectivity in ('online', 'offline')),
  connectivity_at timestamptz,
  latitude double precision,
  longitude double precision,
  location_at timestamptz,
  battery_percent smallint,
  battery_temperature real,
  battery_at timestamptz,
  firmware_version text
);
comment on table public.devices is 'One row per collar with its latest known state.';

create table public.gps_points (
  device_id text not null references public.devices (id) on delete cascade,
  ts timestamptz not null,
  received_at timestamptz not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  speed real,       -- m/s
  accuracy real,    -- m
  satellites smallint,
  primary key (device_id, ts)
);
comment on table public.gps_points is 'telemetry/gps (spec §5.1). Points < 5 m from the previous stored one are thinned (rule 10).';

create table public.battery_readings (
  device_id text not null references public.devices (id) on delete cascade,
  ts timestamptz not null,
  received_at timestamptz not null,
  voltage real not null,
  percentage smallint not null check (percentage between 0 and 100),
  charging boolean not null,
  temperature real, -- °C
  primary key (device_id, ts)
);
comment on table public.battery_readings is 'telemetry/battery (spec §5.2).';

create table public.signal_readings (
  device_id text not null references public.devices (id) on delete cascade,
  ts timestamptz not null,
  received_at timestamptz not null,
  rssi real,
  rsrp real,
  rsrq real,
  sinr real,
  primary key (device_id, ts)
);
comment on table public.signal_readings is 'telemetry/signal_strength (spec §5.4).';

-- status/*, event/*, response/*, settings/response/*, diagnostic/* as validated JSON.
create table public.device_messages (
  id bigint generated always as identity primary key,
  device_id text not null references public.devices (id) on delete cascade,
  topic text not null,
  category text generated always as (split_part(topic, '/', 1)) stored,
  ts timestamptz not null,
  received_at timestamptz not null,
  payload jsonb not null,
  -- Rule 6: QoS 1 duplicates collapse on (device_id, topic, timestamp, payload hash).
  dedupe_key text not null unique
);
create index device_messages_device_category_ts on public.device_messages (device_id, category, ts desc);
comment on table public.device_messages is 'All non-telemetry topics, payload as validated by @udara/contracts.';

create table public.rejected_messages (
  id bigint generated always as identity primary key,
  received_at timestamptz not null,
  topic text not null,
  device_id text,
  reason text not null,
  issues text[] not null default '{}'
);
create index rejected_messages_received_at on public.rejected_messages (received_at desc);
comment on table public.rejected_messages is 'Inbound messages that failed validation (rule 4). Service role only.';

create table public.device_members (
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null references public.devices (id) on delete cascade,
  role text not null check (role in ('viewer', 'operator', 'owner')),
  created_at timestamptz not null default now(),
  primary key (user_id, device_id)
);
create index device_members_device on public.device_members (device_id);

-- ------------------------------------------------------------------ RLS

alter table public.devices enable row level security;
alter table public.gps_points enable row level security;
alter table public.battery_readings enable row level security;
alter table public.signal_readings enable row level security;
alter table public.device_messages enable row level security;
alter table public.rejected_messages enable row level security;
alter table public.device_members enable row level security;

create function public.is_device_member(p_device_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.device_members m
    where m.device_id = p_device_id and m.user_id = (select auth.uid())
  );
$$;

create policy "members read devices" on public.devices
  for select to authenticated using (public.is_device_member(id));
create policy "members read gps" on public.gps_points
  for select to authenticated using (public.is_device_member(device_id));
create policy "members read battery" on public.battery_readings
  for select to authenticated using (public.is_device_member(device_id));
create policy "members read signal" on public.signal_readings
  for select to authenticated using (public.is_device_member(device_id));
create policy "members read messages" on public.device_messages
  for select to authenticated using (public.is_device_member(device_id));
create policy "users read own memberships" on public.device_members
  for select to authenticated using (user_id = (select auth.uid()));
-- rejected_messages: no policies, service role only. Writes everywhere: service role only.

-- ------------------------------------------------------------------ ingestion

-- One call per bridge flush. p_messages items:
--   {device_id, topic, ts (epoch s), received_at (epoch s), retained (bool), data (object)}
-- p_rejected items: {received_at, topic, device_id?, reason, issues[]}
-- Retained messages are replays of state the broker already delivered, so they update
-- `devices` but are not added to history.
create function public.ingest_batch(p_messages jsonb, p_rejected jsonb default '[]'::jsonb)
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

  insert into public.gps_points (device_id, ts, received_at, latitude, longitude, speed, accuracy, satellites)
  select device_id, ts, received_at,
    (data ->> 'latitude')::double precision, (data ->> 'longitude')::double precision,
    (data ->> 'speed')::real, (data ->> 'accuracy')::real, (data ->> 'satellites')::smallint
  from _in where topic = 'telemetry/gps' and not retained
  on conflict do nothing;

  insert into public.battery_readings (device_id, ts, received_at, voltage, percentage, charging, temperature)
  select device_id, ts, received_at,
    (data ->> 'voltage')::real, (data ->> 'percentage')::smallint,
    (data ->> 'charging')::boolean, (data ->> 'temperature')::real
  from _in where topic = 'telemetry/battery' and not retained
  on conflict do nothing;

  insert into public.signal_readings (device_id, ts, received_at, rssi, rsrp, rsrq, sinr)
  select device_id, ts, received_at,
    (data ->> 'rssi')::real, (data ->> 'rsrp')::real, (data ->> 'rsrq')::real, (data ->> 'sinr')::real
  from _in where topic = 'telemetry/signal_strength' and not retained
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
  set battery_percent = b.pct, battery_temperature = b.temp, battery_at = b.ts
  from (
    select distinct on (device_id) device_id, ts,
      (data ->> 'percentage')::smallint as pct, (data ->> 'temperature')::real as temp
    from _in where topic = 'telemetry/battery' order by device_id, ts desc
  ) b
  where d.id = b.device_id and (d.battery_at is null or b.ts >= d.battery_at);

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

revoke execute on function public.ingest_batch(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_batch(jsonb, jsonb) to service_role;

-- ------------------------------------------------------------------ clearing data

-- Deletes stored history for one device, or for every device when p_device_id is null.
-- Devices nobody is a member of are removed entirely (typically simulator collars); devices
-- with members keep their row and memberships but lose history and latest state.
-- Returns the number of history rows deleted. Service role only (the API checks permissions).
create function public.clear_history(p_device_id text default null)
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

create extension if not exists pg_cron;

select cron.schedule(
  'dog-tracker-retention',
  '17 3 * * *',
  $$
    delete from public.gps_points where ts < now() - interval '30 days';
    delete from public.battery_readings where ts < now() - interval '30 days';
    delete from public.signal_readings where ts < now() - interval '30 days';
    delete from public.device_messages where category = 'diagnostic' and ts < now() - interval '7 days';
    delete from public.device_messages where ts < now() - interval '30 days';
    delete from public.rejected_messages where received_at < now() - interval '7 days';
  $$
);
