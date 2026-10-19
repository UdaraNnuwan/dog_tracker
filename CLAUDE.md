# CLAUDE.md – Udara Smart Dog Collar Monitoring

Realtime monitoring web app for Smart Dog Collar devices. The single source of truth for
topics and payloads is `docs/spec/Smart_Dog_Collar_MQTT_Interface_Specification_v1.2.pdf`
(referred to as "the spec"). When code and spec disagree, the spec wins; record any
deliberate deviation in `docs/adr/`.

## Stack
- TypeScript (strict) everywhere, pnpm workspaces, Node 20+.
- `apps/web`: React + Vite, TanStack Router + TanStack Query, Tailwind + shadcn/ui,
  Leaflet (OSM raster tiles; no WebGL, ADR 0005), uPlot for time series.
- `apps/worker`: one Cloudflare Worker serving the SPA (static assets) + Hono API under `/api/*`.
  - Durable Object `MqttBridge` (single instance, id "main"): the only MQTT client.
    Connects to HiveMQ Cloud over WSS :8884 `/mqtt`, MQTT 3.1.1, fixed clientId,
    cleanSession=false, subscribes `pettracker/backend/#` QoS 1. Also hosts browser
    WebSockets (Hibernation API) at `/api/live` for live telemetry fan-out.
    Writes to Supabase with `@supabase/supabase-js` using the Supabase secret key
    (`sb_secret_…`, formerly service_role; Worker secret only).
  - Hono API is only for things that need the bridge or privileged writes: commands, settings, health.
  - Cron Trigger: bridge watchdog.
- Database: **Supabase Postgres**. Schema, RLS policies and pg_cron retention jobs live in
  `supabase/migrations` (Supabase CLI). Generate types with `supabase gen types typescript`
  into `packages/db-types` and use them in web + worker.
- Browser reads history/events directly with supabase-js (publishable key + user session) under RLS.
  Alerts and command status update live via Supabase Realtime `postgres_changes`.
  High-rate telemetry does NOT go through Supabase Realtime (quota); it uses the DO WebSocket.
- `packages/contracts`: topic builder/parser + Zod schema for every topic payload,
  exported JSON Schema (generated, committed) for the firmware team.
- `tools/simulator`: Node + mqtt.js fake collars (multi-device, GPS walk, battery drain,
  LWT, events, command responses with configurable delay/failure/duplicates).
- Tests: Vitest (+ @cloudflare/vitest-pool-workers for worker), Playwright e2e against simulator.
- Login: Supabase Auth **email + password, no email verification** ("Confirm email" OFF in
  Auth > Providers > Email). Public sign-up is OFF; an owner/admin creates users from an in-app
  user-management page (Worker calls `auth.admin.createUser` with `email_confirm: true` using the
  secret key). No magic links or OTP. Password reset is done by an admin, not by email.
- Auth: Supabase Auth. Access is per device via `device_members(user_id, device_id, role)` with
  role `viewer` | `operator` | `owner`, enforced by RLS. The Worker verifies the Supabase JWT
  (JWKS) on `/api/*` and `/api/live`, then checks `device_members` before commands/settings.
- Notifications: in-app live toasts + Telegram bot.

## Topic model (from the spec)
`pettracker/{destination}/{device_id}/{main_topic}/{sub_topic}`
- `backend` = device → cloud; `device` = cloud → device. device_id lowercase, no spaces.
- Ingest (subscribe): telemetry/{gps,battery,imu,signal_strength}, status/{system,network,connectivity},
  event/{geofence,low_battery,tamper}, response/{location,buzzer,reboot,peripheral,sleep},
  settings/response/{setting}, diagnostic/{log,crash,debug_log,sensor_health}.
- Publish: command/{location,buzzer,reboot,peripheral,sleep}, settings/{set|get}/{setting}.
  OTA (`command/firmware_update`) is a spec proposal: do NOT implement.

## Non-negotiable rules
1. **No broker credentials, tokens or secrets in the frontend bundle or in git.** Secrets via
   `wrangler secret put` (HIVEMQ_*, SUPABASE_SECRET_KEY, TELEGRAM_BOT_TOKEN); local dev via
   `.dev.vars` (gitignored). Browser never talks to HiveMQ. Only the Supabase URL + publishable key go
   to the frontend; the secret key never does. RLS is enabled on every table, no exceptions.
2. Only `MqttBridge` publishes to MQTT. All publishes are QoS 1 and **retain=false** (spec §10:
   commands must never be retained).
3. Every command/settings request gets a backend-generated UUID `request_id`. Ack timeout 10 s,
   up to 2 retries with the **same** request_id, 5–10 s backoff, then status `timeout`.
   Responses deduped by request_id (spec §7).
4. Validate every inbound message with the contracts Zod schema before use: topic namespace,
   known device, types, ranges, max size. Invalid → `rejected_messages` + structured log, never throw
   out of the message handler. Ignore unknown extra fields (spec §15).
5. `timestamp` fields are integer epoch **seconds**. Convert at the UI edge only.
6. QoS 1 means duplicates: dedupe events by (device_id, topic, timestamp, payload hash).
7. Connectivity = retained `status/connectivity` + LWT; also watchdog "no telemetry for N min".
8. Settings are validated against the settings registry in `packages/contracts`
   (currently `gps_interval`: integer seconds 10..86400) before publishing.
9. Commands and settings changes require role operator/owner and are written to `audit_log`.
10. Stay within free tiers: batch upserts to Supabase (buffer in DO, flush every 5–10 s,
    `onConflict` for dedupe), do not persist raw IMU (live only), skip GPS points that moved < 5 m,
    pg_cron deletes telemetry older than 30 days (DB limit 500 MB), keep one MqttBridge instance.

## Defaults for spec open decisions (§18)
MQTT 3.1.1; GPS speed m/s (UI shows km/h); gyro deg/s; geofence computed on device
(app only displays + alerts); no offline command queueing; settings catalogue = gps_interval only.

## Code conventions
- Small modules, pure functions for parsing/validation/alert rules (easy to unit test).
- No `any`; shared types come from `packages/contracts` (`z.infer`).
- Structured JSON logging: `{level, msg, device_id?, topic?, request_id?}`.
- Every new topic/payload: schema + fixture from the spec example + test, in the same PR.
- Conventional commits. Each phase ends green on `pnpm lint && pnpm typecheck && pnpm test`.
- Write an ADR in `docs/adr/` for any architectural decision or spec deviation.

## Commands
- `pnpm i` · `pnpm dev` (web + `wrangler dev`) · `pnpm sim --devices 5` · `pnpm replay` (CSV test data, ADR 0007)
- `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm e2e`
- `pnpm --filter @udara/contracts gen:schema` (regenerate committed JSON Schema after any schema change)
- `supabase start` (local Postgres) · `supabase migration new <name>` · `supabase db push` · `pnpm db:types`
- Deploy: CI on `main` runs `wrangler deploy` (staging env on PRs).

## Build phases
1 scaffold + MQTT spike · 2 contracts · 3 simulator · 4 Supabase schema + RLS + ingestion · 5 Supabase Auth + API ·
6 live (DO WebSocket + Realtime) · 7 frontend · 8 alerts + commands · 9 hardening (e2e, rate limits, runbook).
Do one phase at a time and stop for review.
