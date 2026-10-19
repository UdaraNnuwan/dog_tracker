# ADR 0004: Development live view before authentication

- Status: Accepted (temporary, remove in phase 5)
- Date: 2026-10-19

## Context

With the bridge connected (phase 1) and validating messages (phase 2), there was still no way to
see the data in the app: the live WebSocket was planned for phase 6, behind Supabase Auth from
phase 5. To develop and demo against the simulator (phase 3), we pulled a minimal live view
forward. CLAUDE.md requires `/api/live` to verify a Supabase JWT, and that auth doesn't exist yet.

## Decision

- **`/api/live`** (Worker route → `MqttBridge.fetch`) accepts browser WebSockets using the
  Hibernation API (`ctx.acceptWebSocket`). Each new socket first gets a snapshot (the latest reading
  per device and topic, held in memory by `LiveState` and capped at 200 devices). After that it
  gets one `LiveEvent` per inbound message: `message` for accepted ones, `rejected` for ones that
  failed validation. The event types live in `@udara/contracts` (`live.ts`), shared by worker and web.
- **No login, development only.** The route serves only when **both** conditions hold:
  1. `LIVE_VIEW_UNAUTHENTICATED=true`. This is set only in `.dev.vars` and is never a deployed
     var or secret.
  2. The request hostname is `localhost`, `127.0.0.1` or `[::1]`.

  Otherwise it returns `401 {"error":"auth_required"}`. A plain GET (no upgrade) returns
  `{"live":"available"}`, which the browser uses as a probe, because a failed WebSocket upgrade
  doesn't expose its HTTP status.
- **Web:** `apps/web` renders `LiveView` (device list, Leaflet map with OSM raster tiles (ADR 0005),
  a summary of location/temperature/battery/speed/signal, latest readings, message log, and a
  **live log by topic**: one collapsible table per topic, columns are the payload fields, the last
  100 messages each, plus a `rejected` section; it can be filtered to the selected device and paused)
  with plain CSS. Phase 7 replaces it with the planned TanStack/Tailwind/shadcn dashboard.

## Consequences

- Anyone with access to a developer's machine can read the live feed. On the public broker
  (ADR 0003) the data is public anyway.
- **Phase 5 must** remove the `LIVE_VIEW_UNAUTHENTICATED` path, verify the Supabase JWT on
  `/api/live` and filter events by `device_members`. Today every client sees every device.
- The live view holds no history: a page reload shows only the latest reading per topic, and
  trails restart. History comes from Supabase (phase 4).
- Raw IMU is broadcast live but never persisted (rule 10).
