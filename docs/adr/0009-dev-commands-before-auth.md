# 0009 – Sending commands and settings from the dashboard before auth

- Status: Accepted
- Date: 2026-10-19

## Context

The Topics page lists what the backend publishes (`command/*`, `settings/set|get/*`). We want
to send those from the UI now, to test them with the simulator and demo collars, before login
(phase 5) and the full command feature (phase 8) exist.

## Decisions

1. **API.** `POST /api/devices/:id/commands/:name` (the command's own fields) and
   `POST /api/devices/:id/settings/:setting/{set|get}` (`{value}` for set). The Worker
   builds the payload with the contracts builders. They add `timestamp`, a backend-generated
   UUID `request_id` and `protocol_version`, and validate against the Zod schema and the
   settings registry before anything is published (rules 3, 8). Invalid input gets a 400 with
   the Zod issues. OTA stays out (unknown command).
2. **Publishing.** Only `MqttBridge` publishes: QoS 1, retain=false, `pettracker/device/…`
   only (rule 2). For a running demo collar (ADR 0008) the bridge delivers the message to the
   collar directly instead, because demo collars are not on MQTT.
3. **Tracking (rule 3).** `RequestTracker` in the bridge waits 10 s for the answer on
   `response/{name}` or `settings/response/{setting}` with the same request_id. Without an
   answer it retries up to 2 times with the **same** request_id after a 5–10 s backoff, then
   marks the request `timeout`. A device answer sets `success|failed|rejected|unsupported`.
   A second answer to a finished request is ignored and logged (rule 6). Every state change
   goes to browsers (`request` event on `/api/live`) and to the processing log, with the JSON
   that was sent or received.
4. **UI.** On the Topics page, published topics have a **Send…** button that opens a popup
   with a form generated from the topic's schema, a preview of the JSON, and then the live
   state and the device's answer.
5. **Device tab.** The telemetry tables moved from Live to a Device tab: pick one device, pick
   a topic in the side list, and see its table, the matching log lines, and the settings and
   commands that belong to that topic (`controlsFor`). For example, `telemetry/gps` →
   `gps_interval` set/get + `command/location`, events → buzzer + location, `response/x` →
   `command/x`. Each control shows the current reported setting value and the last
   request's state, and opens the same popup with the device pre-selected.

## Deviations (until phase 5/8)

- **No role check or `audit_log` yet (rule 9).** There are no users before auth, so the
  endpoints sit behind the development guard (ADR 0004: `LIVE_VIEW_UNAUTHENTICATED=true` + a
  localhost URL) and cannot be reached on a deployed Worker. The processing log
  (`pipeline_logs`) is the interim record of what was sent. Phase 5/8 must add the
  `device_members` operator/owner check and write `audit_log`.
- **Requests are tracked in memory.** A bridge restart forgets pending requests. Phase 8
  persists them (command status table + Supabase Realtime).
- **No device existence check.** Any valid device id can be addressed. A request to a device
  that isn't online simply times out (no offline queueing, per the spec §18 defaults).
