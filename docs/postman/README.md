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
which is exactly what the spec wants. If your Postman version doesn't replace variables in
MQTT messages, type a number such as `1792390000` instead.

Use your own device id instead of `dog001` (on the public broker everyone shares ids).

### Payloads (collar → backend)

Topics follow spec V3: `pettracker/{device_id}/backend/…`. `status/connectivity` is not in V3;
the bridge keeps it for the Last Will (ADR 0011).

| Topic | QoS | Retain | Payload |
| --- | --- | --- | --- |
| `pettracker/dog001/backend/telemetry/gps` | 0 | no | `{"timestamp": {{$timestamp}}, "latitude": 6.9271, "longitude": 79.8612, "speed": 1.2}` |
| `pettracker/dog001/backend/telemetry/battery` | 0 | no | `{"timestamp": {{$timestamp}}, "voltage": 3.95, "percentage": 82, "charging": false}` |
| `pettracker/dog001/backend/telemetry/imu` | 0 | no | `{"timestamp": {{$timestamp}}, "acceleration": {"x": 0.02, "y": -0.1, "z": 9.79}, "gyroscope": {"x": 0.3, "y": -0.1, "z": 0.0}}` |
| `pettracker/dog001/backend/telemetry/signal_strength` | 0 | no | `{"timestamp": {{$timestamp}}, "strength_lower_limit": 50.0, "strength_upper_limit": 79.0}` |
| `pettracker/dog001/backend/telemetry/bme_data` | 0 | no | `{"timestamp": {{$timestamp}}, "temperature": 31.5, "pressure": 1012.0, "humidity": 70.0}` |
| `pettracker/dog001/backend/status/connectivity` | 1 | **yes** | `{"timestamp": {{$timestamp}}, "status": "online"}` |
| `pettracker/dog001/backend/status/system` | 0 | no | `{"timestamp": {{$timestamp}}, "firmware_version": "1.0.0", "uptime_seconds": 86400, "free_heap_bytes": 185600, "reset_reason": "power_on", "device_state": "active"}` |
| `pettracker/dog001/backend/status/network` | 0 | no | `{"timestamp": {{$timestamp}}, "connection": "lte", "registration": "registered", "operator": "Example Operator", "apn": "internet", "ip_address": "10.24.13.8"}` |
| `pettracker/dog001/backend/event/geofence` | 1 | no | `{"timestamp": {{$timestamp}}, "in_status": false, "out_status": true}` |
| `pettracker/dog001/backend/event/low_battery` | 1 | no | `{"timestamp": {{$timestamp}}, "percentage": 14, "voltage": 3.55, "threshold_percentage": 15, "charging": false}` |
| `pettracker/dog001/backend/diagnostic/log` | 0 | no | `{"timestamp": {{$timestamp}}, "error_type": "eeprom", "error_code": "400004"}` |
| `pettracker/dog001/backend/diagnostic/debug_log` | 0 | no | `{"timestamp": {{$timestamp}}, "level": "info", "module": "gps", "message": "GNSS fix acquired"}` |

Command responses (`backend/response/<command>`, QoS 1) must echo the `request_id` of a command
the backend sent. Take it from `GET /api/requests` or from the `pettracker/dog001/device/#`
subscription:

```json
{"timestamp": {{$timestamp}}, "request_id": "<from the command>", "status": "success"}
```

(`response/reboot` uses `"status": "accepted"` or `"rejected"`; the other responses also carry
the fields listed in the Topics tab.)

Settings: a SET is answered with an ACK, which the collar publishes on
`pettracker/dog001/device/settings/ack/<group>` (QoS 1) with the SET's `setting_id`:

```json
{"timestamp": {{$timestamp}}, "action": "ack", "setting_id": "<from the SET>", "setting_type": "gps"}
```

A GET is answered on `pettracker/dog001/backend/settings/response/<group>` with
`"action": "get_response"`, the same `setting_id` and the group's values.

### Check that it arrived

- App **Live** tab: the device appears, and the message shows in its topic section.
- `pnpm dev` terminal: the `mqtt ingest` line (every 15 s) counts it under `accepted`, or under
  `rejected` with the reason.
- To see a rejection, send something invalid: `"latitude": 91`, `"percentage": "82"` (string),
  a GPS message without `speed`, or a millisecond timestamp.

### Rules the bridge enforces (from the spec)

- `timestamp`: integer epoch **seconds** (not ms, not a string).
- Numbers and booleans must be JSON numbers/booleans: `82`, not `"82"`; `false`, not `"false"`.
  Exception: settings values (`settings/response/…`) may be strings like `"60"` or `"true"`,
  as in the spec's examples (ADR 0011).
- Topic: lowercase device id, exact topic names; anything else is rejected as `unknown_topic`.
- Only `status/connectivity` is retained. **Never** retain commands.

## 2. HTTP API collection (send commands like the backend)

**Import → File** → `docs/postman/dog-collar-api.postman_collection.json`.

Collection variables: `baseUrl` (default `http://localhost:8787`) and `deviceId`. The bridge
must be `ready` (`Status → Health`). Commands return the backend-generated `request_id` (`setting_id` for settings);
`Status → Requests` shows whether the collar answered (10 s timeout, 2 retries, rule 3). For a collar
that answers, run `pnpm sim --prefix <id>` and set `deviceId` to `<id>01`.

Everything except `/api/health` needs `LIVE_VIEW_UNAUTHENTICATED=true` in `.dev.vars` and a
`localhost` URL (ADR 0004, ADR 0009). Otherwise you get `401 auth_required`.
