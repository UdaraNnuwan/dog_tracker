# Postman setup

Two ways to drive the system from Postman:

| What | How |
| --- | --- |
| **Act as a collar**: publish telemetry/events straight to MQTT | Postman **MQTT request** (below) |
| **Act as the backend**: send commands/settings to a collar through the API | Import `dog-collar-api.postman_collection.json` |

## 1. MQTT request (publish like a collar)

Postman v10+: **New → MQTT**.

**Server URL**, the same broker as `HIVEMQ_HOST` in `apps/worker/.dev.vars`:

| Broker | URL | Auth |
| --- | --- | --- |
| Public HiveMQ (dev, ADR 0003) | `mqtt://broker.hivemq.com:1883` | none |
| HiveMQ Cloud | `mqtts://<cluster>.s1.eu.hivemq.cloud:8883` | username + password from Access Management |

**Settings** tab: MQTT version **3.1.1**, a unique **Client ID** (e.g. `postman-<yourname>`).
Username/password only for HiveMQ Cloud. Then **Connect**.

**Topics** tab (optional, to see what you and the bridge send): subscribe to `pettracker/#`.

**Message** tab: set **Topic**, **QoS** and **Retain** as in the table below, choose **JSON**,
paste the payload, then **Send**. `{{$timestamp}}` is Postman's current Unix time in **seconds**,
which is exactly what the spec wants (§3). If your Postman version doesn't replace variables in
MQTT messages, type a number such as `1792390000` instead.

Use your own device id instead of `dog001` (on the public broker everyone shares ids).

### Payloads (device → backend)

| Topic | QoS | Retain | Payload |
| --- | --- | --- | --- |
| `pettracker/backend/dog001/telemetry/gps` | 0 | no | `{"timestamp": {{$timestamp}}, "latitude": 6.9271, "longitude": 79.8612, "speed": 1.2, "accuracy": 4.5, "satellites": 10}` |
| `pettracker/backend/dog001/telemetry/battery` | 0 | no | `{"timestamp": {{$timestamp}}, "voltage": 3.95, "percentage": 82, "charging": false, "temperature": 31.5}` |
| `pettracker/backend/dog001/telemetry/imu` | 0 | no | `{"timestamp": {{$timestamp}}, "accelerometer": {"x": 0.12, "y": -0.03, "z": 9.78}, "gyroscope": {"x": 0.4, "y": -0.2, "z": 0.1}}` |
| `pettracker/backend/dog001/telemetry/signal_strength` | 0 | no | `{"timestamp": {{$timestamp}}, "rssi": -79, "rsrp": -101, "rsrq": -11, "sinr": 14}` |
| `pettracker/backend/dog001/status/connectivity` | 1 | **yes** | `{"timestamp": {{$timestamp}}, "status": "online"}` |
| `pettracker/backend/dog001/status/system` | 0 | no | `{"timestamp": {{$timestamp}}, "firmware_version": "1.1.0", "uptime": 86400, "free_memory": 152320, "reset_reason": "power_on"}` |
| `pettracker/backend/dog001/status/network` | 0 | no | `{"timestamp": {{$timestamp}}, "connected": true, "network_type": "lte", "operator": "example_operator", "ip_address": "10.20.30.40"}` |
| `pettracker/backend/dog001/event/geofence` | 1 | no | `{"timestamp": {{$timestamp}}, "geofence_id": "home", "event": "exit", "latitude": 6.928, "longitude": 79.862}` |
| `pettracker/backend/dog001/event/low_battery` | 1 | no | `{"timestamp": {{$timestamp}}, "percentage": 15, "voltage": 3.55}` |
| `pettracker/backend/dog001/event/tamper` | 1 | no | `{"timestamp": {{$timestamp}}, "detected": true}` |
| `pettracker/backend/dog001/diagnostic/log` | 0 | no | `{"timestamp": {{$timestamp}}, "level": "error", "module": "storage", "error_type": "eeprom", "error_code": "400004"}` |

Command responses (`response/<command>`, QoS 1) must echo the `request_id` of a command the
backend sent. Take it from `GET /api/requests` or from the `pettracker/device/#` subscription:

```json
{"timestamp": {{$timestamp}}, "request_id": "<from the command>", "status": "success"}
```

### Check that it arrived

- App **Live** tab: the device appears, and the message shows in its topic section.
- `pnpm dev` terminal: the `mqtt ingest` line (every 15 s) counts it under `accepted`, or under
  `rejected` with the reason.
- To see a rejection, send something invalid: `"latitude": 91`, `"percentage": "82"` (string),
  or a millisecond timestamp.

### Rules the bridge enforces (from the spec)

- `timestamp`: integer epoch **seconds** (not ms, not a string).
- Numbers and booleans must be JSON numbers/booleans: `82`, not `"82"`; `false`, not `"false"`.
- Topic: lowercase device id, exact topic names; anything else is rejected as `unknown_topic`.
- Only `status/connectivity` is retained. **Never** retain commands.

## 2. HTTP API collection (send commands like the backend)

**Import → File** → `docs/postman/dog-collar-api.postman_collection.json`.

Collection variables: `baseUrl` (default `http://localhost:8787`) and `deviceId`. The bridge
must be `ready` (`Status → Health`). Commands return the backend-generated `request_id`;
`Status → Requests` shows whether the collar answered (10 s timeout, spec §7.5). For a collar
that answers, run `pnpm sim --prefix <id>` and set `deviceId` to `<id>01`.

Everything except `/api/health` needs `LIVE_VIEW_UNAUTHENTICATED=true` in `.dev.vars` and a
`localhost` URL (ADR 0004, ADR 0009). Otherwise you get `401 auth_required`.
