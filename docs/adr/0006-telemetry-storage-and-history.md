# ADR 0006: Telemetry storage, history API and clearing data

- Status: Accepted (phase 4; the history and clear API move behind auth in phase 5)
- Date: 2026-10-19

## Context

Everything the collars send must be stored with its time, browsable per device and time range,
and clearable. CLAUDE.md fixes Supabase Postgres, a service-role writer in the bridge, batched
writes (rule 10) and RLS on every table.

## Decisions

### 1. Schema (`supabase/migrations/20261019100000_telemetry_storage.sql`)

| Table | Holds |
| --- | --- |
| `devices` | One row per collar plus its latest state (location, battery, temperature, connectivity, firmware) |
| `gps_points`, `battery_readings`, `signal_readings` | Typed time series, primary key `(device_id, ts)` |
| `device_messages` | All other topics (status, events, responses, settings, diagnostics) as validated JSON, with a `category` column |
| `rejected_messages` | Messages that failed validation (rule 4) |
| `device_members` | Per-device access (`viewer` / `operator` / `owner`) for phase 5 RLS |

- Every row stores **`ts`** (device time from the payload `timestamp`; for the Last Will, which
  has no timestamp, the receive time) and **`received_at`** (bridge time).
- Raw IMU is not stored (rule 10). GPS points that moved less than 5 m since the last stored
  point are skipped, but one point is still stored at least every 5 minutes, so a resting dog
  keeps a timeline.
- Duplicates (QoS 1, rule 6) collapse on the time-series primary keys and on `device_messages.dedupe_key`
  = md5(device, topic, ts, payload).
- Retained messages are replays: they update `devices` but aren't added to history.
- RLS: members can `select` their devices' rows. There are no write policies. `ingest_batch`
  and `clear_history` can be executed only by `service_role`.
- Retention via pg_cron, daily: telemetry and messages 30 days, diagnostics and rejected
  messages 7 days.

### 2. Ingestion

The bridge buffers rows (`IngestBuffer`) and flushes them every 5 s, plus on each alarm tick,
in **one** `rpc("ingest_batch")` call per flush. That call is atomic and costs one request. A
failed flush puts the rows back and retries; the buffer is capped at 5,000 rows, oldest dropped
first, with the count reported in `/api/health`. Without `SUPABASE_URL`/`SUPABASE_SECRET_KEY`,
storage stays `disabled` and live view keeps working.

This settles ADR 0001 §5: events and responses are buffered like telemetry. A DO eviction can
lose up to about 5 s of acked messages. That's accepted for now; revisit if commands (phase 8)
need stronger guarantees.

### 3. History and clear API (development only until phase 5)

- `GET /api/devices`
- `GET /api/devices/:id/history/{gps|battery|signal|messages}?from&to&limit&category`
  (default range is the last 24 h, `limit` ≤ 10,000)
- `DELETE /api/devices/:id/history`, `DELETE /api/history`

These read and write with the service-role key, so they share `/api/live`'s dev gate:
`LIVE_VIEW_UNAUTHENTICATED=true` **and** a localhost hostname (ADR 0004). Phase 5 replaces
them with browser reads through supabase-js under RLS, and puts clearing behind the `owner` role
plus `audit_log`.

`clear_history(device?)` deletes history and rejected messages for one device or for all.
Devices with no members are removed entirely; devices that have members keep their row but
lose their latest state. The bridge first drops that device's buffered rows and live state, so
nothing old is written back.

### 4. Dashboard

The web app has two tabs. **Live** is ADR 0004. **History** has a device picker, a time range
(1 h to 30 days presets, or custom), and sections: Location (track map, distance, max speed,
table), Battery & temperature (uPlot chart and table), Signal (chart), Events & status
(category filter) and Data (clear). Each section can be downloaded as CSV.

## Consequences

- Before data is stored, the migration has to be pushed to the Supabase project
  (`supabase link`, then `supabase db push`) and the secret key set (README).
- Local Supabase (`supabase start`) can't run on the owner's machine (Docker published ports
  are unreachable there). The migration and `ingest_batch` were verified on a plain
  `supabase/postgres` container plus PostgREST reached over the container IPs.
