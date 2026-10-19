# ADR 0001: MQTT client inside the `MqttBridge` Durable Object

- Status: Accepted (phase 1 spike)
- Date: 2026-10-07

## Context

CLAUDE.md fixes the shape: one `MqttBridge` Durable Object (id `"main"`) is the only MQTT
client. It connects to HiveMQ Cloud over WSS :8884 `/mqtt` with MQTT 3.1.1, a fixed clientId and
`cleanSession=false`, and subscribes to `pettracker/backend/#` at QoS 1. This ADR records how that
runs inside the Workers runtime and the trade-offs that come with it.

## Decisions


### 1. Own minimal MQTT 3.1.1 codec instead of mqtt.js

`apps/worker/src/mqtt/codec.ts` (pure encode/decode) and `session.ts` (one connection's state
machine) implement only what the bridge needs: CONNECT/CONNACK, SUBSCRIBE/SUBACK, PUBLISH QoS 0/1,
PUBACK, PINGREQ/PINGRESP and DISCONNECT. That comes to about 500 lines with comments.

Why not mqtt.js:
- It is built on Node streams, `Buffer` and its own WebSocket stream wrapper. In Workers it needs
  `nodejs_compat` plus shims, and its reconnect and keep-alive timers run on `setTimeout`, which
  doesn't survive Durable Object eviction. Our liveness comes from the DO alarm (§3).
- **Rule 2 is enforced by the API shape.** `MqttSession.publish(topic, payload)` has no QoS or
  retain parameters: it always sends QoS 1 with retain=false. The bridge also refuses any topic
  outside `pettracker/device/{device_id}/…` (`isPublishableDeviceTopic` in `@udara/contracts`).
- It keeps the bundle small (about 80 KiB in total with Hono).

The cost is that we own the protocol code. Mitigations:
- Wire-level unit tests (`test/codec.test.ts`, `test/session.test.ts`).
- A live smoke test against a real HiveMQ broker (see "Verification").
- The phase 3 simulator uses mqtt.js, an independent implementation, so every e2e run
  cross-checks the codec.

### 2. Transport: outbound WebSocket via `fetch()` upgrade

`fetch("https://<host>:8884/mqtt", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "mqtt" } })`,
then `accept()` and `binaryType = "arraybuffer"`. Recent compatibility dates default `binaryType`
to `"blob"`, and Blob frames need an async read that would break in-order packet processing. The
smoke test caught exactly this, so it is set explicitly. One WebSocket frame may carry a partial
packet or several packets, so `PacketReader` reassembles packets across frames.

(Considered: raw MQTT over TLS on :8883 via `cloudflare:sockets` `connect()`. That would also work,
but CLAUDE.md specifies WSS, and HiveMQ's WebSocket listener is the documented path for
browser-like clients.)

### 3. Liveness: alarm loop, watchdog cron, reconnect backoff

- **DO alarm every 15 s** (`TICK_MS`). With the bridge connected, `session.tick()` sends PINGREQ
  after 30 s of send-idleness (half the 60 s keep-alive) and closes the connection when a PINGRESP
  is more than 60 s late. CONNACK has a 30 s timeout. When disconnected, the alarm reconnects once
  the backoff has elapsed.
- **Backoff**: 1 s → 2 → 5 → 10 → 30 → 60 s, ±20 % jitter. A CONNACK refusal (bad credentials,
  not authorized) jumps straight to 60 s, because retrying fast won't fix credentials.
- **Eviction**: alarms are persisted. If the runtime evicts the object and drops the socket, the
  next alarm (≤ 15 s later) starts a fresh instance, which reconnects.
- **Cron watchdog** (`* * * * *`) calls `ensureConnected()`. It bootstraps the bridge after a
  deploy and re-arms the alarm if it was ever lost. It respects the backoff.

### 4. Session: fixed clientId per environment, `cleanSession=false`

HiveMQ keeps our subscription and **queues QoS 1 messages** (events, responses, connectivity)
while the bridge is down, then delivers them on reconnect. QoS 0 telemetry published during a gap
is lost; that's accepted, since the next sample replaces it.

**Every environment needs its own clientId** (`MQTT_CLIENT_ID`: prod `udara-dog-collar-bridge`,
staging `…-staging`, local dev set in `.dev.vars`). Two bridges sharing an id make the broker
disconnect one whenever the other connects, and they kick each other off in a loop.

### 5. Inbound PUBACK before persistence

The message handler is synchronous and must not throw (rule 4). A throw is caught and logged, and
the message is still acked so one bad payload can't wedge the queue. The PUBACK goes out right
after the handler returns. From phase 4 the handler only buffers, and the buffer flushes to
Supabase every 5–10 s (rule 10). **A message can therefore be acked and then lost if the object
is evicted before the next flush.** That is accepted for telemetry. Phase 4 must decide whether
events and responses are written immediately instead.

### 6. Outbound in-flight publishes are not re-sent at the MQTT layer

MQTT 3.1.1 §4.4 says a `cleanSession=0` client re-sends unacked PUBLISHes after reconnecting. We
don't. In-flight publishes are rejected when the connection drops, and the command layer (rule 3:
10 s ack timeout, 2 retries with the **same** `request_id`) retries them. The device dedupes by
`request_id` (spec §7.4). This avoids two competing retry mechanisms, plus in-memory MQTT state
that eviction would lose anyway. It deviates from the MQTT spec, not from the collar spec.

### 7. Cost (free tier)

An open outbound WebSocket keeps the DO resident, and outbound sockets can't hibernate, so the
bridge accrues duration around the clock: 128 MB × 86,400 s ≈ **11,060 GB-s/day**. Against the
Workers Free Durable Objects allowance (13,000 GB-s/day at time of writing; re-check the
current pricing page), **that leaves room for only one always-on bridge per account.** A
permanently running staging bridge would exceed it. Options: run the staging bridge only during
testing (stop its cron or use a separate account), or move to the paid plan.

Alarms add about 5,760 DO requests/day and cron about 1,440 Worker invocations/day, both well
inside the limits. Ingest is logged as one summary line per tick, not one line per message, to
stay inside the Workers Logs quota. DOs must be SQLite-backed (`new_sqlite_classes`) on the free
plan.

## Verification (phase 1)

- `pnpm test`: codec wire bytes, packet reassembly, session handshake, keep-alive, timeouts,
  handler-throw safety, QoS 1 acks, publish guard (topic namespace, size, not connected).
- Live smoke test (2026-10-07) against `broker.hivemq.com` (public, WSS :8884 `/mqtt`):
  `wrangler dev` → `/cdn-cgi/handler/scheduled` → bridge `ready` → a scratch device client
  published 3 QoS 1 messages under `pettracker/backend/…` → the bridge received all 3 (no
  duplicates) and logged the ingest summary on the next tick. The first run surfaced the Blob
  `binaryType` issue described in §2.
- Still to verify against **HiveMQ Cloud** with real credentials: TLS/auth, and session resumption
  (`session_present: true` plus QoS 1 messages queued during a bridge outage).
