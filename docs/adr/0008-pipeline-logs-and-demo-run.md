# 0008 – Saved processing logs and a Demo run

- Status: Accepted
- Date: 2026-10-19

## Context

During development we want to see, for every message, what the backend did with it:
accepted or rejected (and why), saved to history, thinned (< 5 m), live only (IMU),
retained replay. We also want to look at that log later, not only while the page is open.
And we want to trigger a short test run from the dashboard without starting `pnpm sim` in a
terminal.

## Decisions

1. **Processing log in the bridge.** `MqttBridge` writes one log line per inbound message
   (`describeInbound`) plus lines for bridge/storage/demo events (connected, disconnected,
   flush failed/recovered, demo started/finished). Each line has `{seq, at, level, source,
   deviceId, topic, message, detail}` (`PipelineLog` in `@udara/contracts`, times in epoch
   seconds). For inbound messages, `detail.payload` holds the JSON exactly as received, also
   for rejected messages, so you can see what the device actually sent. It is capped at
   4000 characters (`truncated: true` beyond that); invalid UTF-8 is decoded lossily.
2. **Live and saved.** Lines go to browsers as a `log` event on `/api/live` (new browsers get
   the last 300 in the snapshot) and are buffered with the ingest batch. Each flush writes them
   to `pipeline_logs` after `ingest_batch`. If only the log insert fails, only the log lines
   are retried.
3. **Debug lines are live only.** Raw IMU arrives on every tick and isn't stored (rule 10),
   so its lines are `debug` and aren't saved.
4. **Free-tier budget.** A line is about 200 bytes. pg_cron runs every hour and keeps `info`
   lines for 3 days and `warn`/`error` lines for 14 days. `clear_history` also clears the
   device's lines. RLS: members can read their devices' lines. Lines without a device are
   service role only.
5. **Demo run without MQTT.** `POST /api/demo` starts 2 fake collars (`SimDevice` from
   `tools/simulator`) for 60 s, plus scripted extras: geofence exit/enter, low battery,
   tamper, a diagnostic error and one invalid battery payload that is rejected. Their messages
   enter the bridge's inbound path (`handleInbound`) directly. Validation, live view, storage
   and logs are the real code; only the MQTT transport is skipped. This keeps rule 2: the
   bridge never publishes in the `backend` (device → cloud) namespace. `pnpm sim` is still the
   end-to-end test over the broker.
6. **Development only.** `/api/demo` and `/api/logs` sit behind the same dev guard as the live
   view (ADR 0004): `LIVE_VIEW_UNAUTHENTICATED=true` and a localhost URL.

## Consequences

- The Live tab has a ▶ Demo button and a 3-column split at the bottom. Two columns hold a
  side list of topics plus the selected topic's table (one table at a time). The third holds
  that topic's log lines (Live/Saved). The Logs tab lists every saved line with filters,
  paging, live tail and CSV export.
- The Topics tab lists every topic the bridge subscribes to (device → cloud) and publishes
  (cloud → device), from `topicDocs()` in `@udara/contracts`, the same source as the
  committed JSON Schema files. It shows QoS/retain, a field table, the spec example, the
  last JSON received live and the full JSON Schema. It loads on demand because it bundles
  Zod. `@udara/contracts/live` is a Zod-free entry point for the rest of the UI.
- Demo collars (`demo01`, `demo02`) get stored like real ones. "Clear data" in History removes
  them.
- Continuous traffic writes about 2× the rows it wrote before. If the database gets close to
  500 MB, shorten the info retention first.
- Once auth exists (phase 5), `/api/logs` must check `device_members`, and device-less lines
  should be limited to owners/admins.
