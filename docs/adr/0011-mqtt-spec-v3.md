# ADR 0011: MQTT spec V3 topics and payloads

- Status: Accepted
- Date: 2026-10-27
- Amends: [ADR 0002](0002-payload-contracts.md) (gap-filling rules), [ADR 0006](0006-telemetry-storage-and-history.md) (stored columns)

## Context

The firmware team replaced spec v1.2 with "Smart Dog Collar — MQTT Topics & Payloads" **V3.0**
(2026-10-22, `docs/spec/Smart_Dog_Collar_MQTT_Topics_Payloads_V3.pdf`). V3 changes the topic
layout, most payloads and the whole settings model. It also has gaps and copy errors. This ADR
records how the backend reads V3 and where it deliberately deviates. Each item marked
**open question** should be confirmed with the firmware team.

## Decisions

### 1. Topic layout

`pettracker/{device_id}/{publisher}/{category}/{topic}`. The device id now comes **before** the
publisher (v1.2: `pettracker/{publisher}/{device_id}/…`). `backend` = the collar publishes,
`device` = the backend publishes.

The bridge subscribes to `pettracker/+/backend/#` and `pettracker/+/device/settings/ack/+`
(QoS 1). It refuses to publish to anything but `pettracker/{id}/device/…`, and never to
`…/device/settings/ack/…`.

### 2. Catalogue

| Category | Topics |
| --- | --- |
| telemetry (QoS 0) | `gps`, `battery`, `imu`, `signal_strength`, **`bme_data`** (new) |
| status (QoS 0) | `system`, `network` (+ `connectivity`, see §5) |
| events (QoS 1) | `geofence` (TBD), `low_battery`. **`tamper` removed.** |
| commands (QoS 1) | **`config`** (new, TBD), `location`, `buzzer` (TBD), `reboot`, `peripheral`, `sleep` (TBD) |
| responses (QoS 1) | one per command: `response/{command}` |
| settings (QoS 1) | `set` / `ack` / `get` / `response` for six groups (see §4) |
| diagnostics (QoS 0) | `log`, `debug_log`. **`crash` and `sensor_health` removed.** |

TBD topics (pilot phase) are fully supported. The Topics page and the generated JSON Schema mark
them as TBD. OTA is still not implemented.

### 3. Payloads

The field tables are the source of truth: "required = yes" is required, "no" is optional.
Examples are fixtures (`packages/contracts/src/examples.ts`) after fixing their JSON errors
(trailing/missing commas, unterminated strings).

- Envelope: `timestamp` (integer epoch seconds). `protocol_version` is gone from V3 and is no
  longer sent.
- `request_id` (commands) is still a backend UUID. The spec's `REQ_1003` is just an example.
- Command `action` fields with a single allowed value (`get_current_location`, `enter_sleep`)
  and `reboot_enable` (default `true`) are filled in by the backend when the caller leaves them out.
- Command responses: `status` is `success | error`, except reboot: `accepted | rejected`. On
  `success` every field in the response table is required. An `error` response may leave them
  out, so a failure isn't rejected and left to time out.
- `status/system.firmware_version` must be SemVer (`1.0.0`, `1.1.0-sim`).
  `status/network.ip_address` must be IPv4 or IPv6.
- `telemetry/signal_strength`: `strength_lower_limit <= strength_upper_limit` is enforced. The
  unit isn't stated (**open question**).
- `telemetry/bme_data.pressure`: "hPa or kPa" (**open question**). Stored as sent.

### 4. Settings

The single-value `gps_interval` setting is replaced by six **groups**, each a topic family:

| Topic | Publisher | `action` |
| --- | --- | --- |
| `device/settings/set/{group}` | backend | `set` + the fields to change |
| `device/settings/ack/{group}` | **collar** | `ack` |
| `device/settings/get/{group}` | backend | `get` |
| `backend/settings/response/{group}` | collar | `get_response` + all fields |

Groups: `network_settings`, `gps_settings`, `profile_settings`, `power_settings`,
`sensor_settings`, `device_settings` (registry: `packages/contracts/src/settings.ts`).

- **The ACK is published by the collar** even though it sits under `device/`. The spec has no
  other way for the collar to confirm a SET. The bridge subscribes to it (§1).
- Correlation uses `setting_id` (the settings counterpart of `request_id`): a backend UUID, kept
  the same on retries. A **SET completes on its ACK**, a **GET on its response**. Neither carries a
  status. A collar that rejects a SET simply sends no ACK, so the request ends in `timeout`
  (**open question**: a negative ACK).
- **Value types:** the tables say integer/bool, but the examples send strings (`"60"`,
  `"true"`). The backend **publishes typed JSON** (numbers, booleans) and **accepts both forms**
  on inbound settings payloads. The API also accepts strings and converts them before publishing.
- **Key spelling:** the examples use `"gps_interval "` (trailing space), `"Vaccines"` and
  `"Display_inverted"`. Inbound settings keys are trimmed and lowercased. The backend publishes
  `gps_interval`, `vaccines` and `display_inverted` (**open question**: firmware must read
  these spellings).
- The sensor and device response examples use `"action": "set"` where the tables say
  `get_response`. Both are accepted.
- The network settings response table lists `gps_interval`/`gps_enabled`, which is a copy error.
  The backend uses the fields from the SET table and the example (`mqtt_hb_interval`,
  `mqtt_retry_interval`, `telemetry_interval`).
- `sensor_settings.imu_enable` is listed as "integer, >0 seconds", which looks like a copy error.
  The backend treats it as a boolean like the other `*_enable` fields (**open question**).
- `power_settings` example fields `display_timeout` and `display_brightness` aren't in the table.
  They are accepted with the device-settings rules.
- `display_rotation` only allows `0` or `2`, as the table says.
- Every field is optional except `profile_settings.pet_name`. A SET must contain at least one
  field of its group.
- `gps_interval` is now `> 0` s, as the spec says. The old 10..86400 limit is gone. GPS thinning
  (rule 10) still limits what gets stored.

### 5. Kept although V3 dropped it: `status/connectivity`

V3 has no online/offline topic and no Last Will. Without one, the backend could only detect a
dead collar through the "no telemetry for N min" watchdog. We keep
`pettracker/{id}/backend/status/connectivity` (`{"status":"online"|"offline"}`, retained, QoS 1,
LWT `offline`) as an **optional** topic: the bridge accepts it, and the simulator and demo
publish it. Firmware that never sends it loses nothing, and the watchdog still applies
(**open question**: adopt it in the spec).

### 6. Request states

`pending → success | error | accepted | rejected | timeout`, plus `failed` when the backend
couldn't publish (broker down). In v1.2 the publish failure was `error` and the device failure
`failed`. The names swap because V3 uses `error` as a device status.

### 7. Storage (migration `20261027100000_mqtt_spec_v3.sql`)

- `gps_points`: `accuracy` and `satellites` dropped.
- `battery_readings`: `temperature` dropped.
- `signal_readings`: `rssi/rsrp/rsrq/sinr` → `strength_lower_limit/strength_upper_limit`.
- New `environment_readings` (from `telemetry/bme_data`) with RLS and 30-day retention. The
  history API kind is `environment`.
- `devices.battery_temperature` → `devices.temperature` (+ `temperature_at`), from the BME
  sensor.
- Settings ACKs are stored in `device_messages` with category `settings`, like the responses.

## Consequences

- v1.2 firmware is rejected (`outside_namespace` / `unknown_topic`). There is no
  compatibility mode, because no collar in the field speaks v1.2.
- The CSV test data, the simulator, the demo run, the Postman docs and the committed JSON
  Schema follow V3. Topics published by the backend are documented with their typed output
  (`additionalProperties: false`). Topics published by the collar allow extra fields.
- The open questions above go to the firmware team. Each one only touches the schemas in
  `packages/contracts`.
