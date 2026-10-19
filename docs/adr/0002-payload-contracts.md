# ADR 0002: Payload contracts (`@udara/contracts`)

- Status: Accepted (phase 2)
- Date: 2026-10-19

## Context

Rule 4 requires every inbound message to be validated before use, and the spec (§20) asks for
machine-readable schemas. The spec is precise for some payloads (field tables with Req./Unit/Range)
and only gives an example for others. This ADR records how those gaps are filled. Every choice here
can be revisited when spec v1.3 freezes the open items in §18.

## Decisions

### 1. Zod 4 is the source of truth; JSON Schema is generated from it

- One Zod schema per topic in `packages/contracts/src/schemas/`, wired to topics in `catalogue.ts`.
- `pnpm --filter @udara/contracts gen:schema` writes draft 2020-12 JSON Schema to
  `packages/contracts/json-schema/{backend,device}/<topic path>.schema.json`, with the spec
  examples embedded. The files are committed for the firmware team. `test/jsonSchema.test.ts` fails
  when they drift from the Zod schemas.
- Schemas are exported with `io: "input"`, so they never say `additionalProperties: false`.

### 2. Unknown fields are ignored (spec §15)

- `z.object` strips unknown keys: newer firmware can add fields without being rejected, and the
  backend only sees the fields it knows.
- Exception: `diagnostic/crash`, `diagnostic/debug_log` and `diagnostic/sensor_health` have no
  payload definition in the spec. They use `z.looseObject`, which keeps every field, so nothing is
  lost until the spec defines them.

### 3. Which fields are required

| Source in spec | Rule |
| --- | --- |
| Field table (§5.1–§5.4, §6.3) | `Req. = Y` is required, `N` is optional. Ranges and units come from the table. |
| Example only (§6.1, §6.2, §6.4, §6.5, §9.1) | Only `timestamp` is required; every other field is optional. |
| `status/connectivity` | `status` is required. `timestamp` is optional, because the broker's Last Will message (§11) has none. |
| Command responses (§3, §7) | `request_id` and `status` are required. `error_code` is **not** enforced on failures: rejecting a failed response would leave the command waiting until timeout, which is worse than a missing code. |
| `response/location` | When `status = success`, `latitude`/`longitude` are required (§7: "status + location fields"). Otherwise they are optional. |
| `settings/response/{setting}` | When `status = success`, `value` is required and must pass the settings registry. A failed response may echo any value. |

### 4. Timestamps

`timestamp` is an integer of epoch seconds between 0 and 99,999,999,999. The upper bound rejects
epoch **milliseconds** sent by mistake (rule 5) while allowing any realistic seconds value.

### 5. Settings registry

`packages/contracts/src/settings.ts` lists the only valid settings (currently `gps_interval`,
integer 10–86400 s). A `settings/response/{setting}` topic for an unregistered setting is rejected
as `unknown_setting`. Publishing a value outside its range is refused before anything reaches the
broker (rule 8).

### 6. Command parameters the spec leaves open

- `command/buzzer`: `enabled` (boolean) and `duration` (number ≥ 0) are required. The unit is
  **assumed to be seconds** until the spec fixes it.
- `command/peripheral`: `peripheral` is a non-empty string; `command/sleep`: `mode` is a non-empty
  string. Both become enums once the firmware team publishes the lists.
- `request_id`: a string of 1–64 characters. The spec's examples (`req_1003`) aren't UUIDs; the
  backend generates UUIDs (rule 3).
- OTA (`command/firmware_update`, §14) has no schema, on purpose.

### 7. Pure builders and parsers

- `parseInbound(topic, payload)` never throws. It returns `{ ok: true, value }` with `data` typed
  by topic, or `{ ok: false, reason, issues, deviceId?, path? }`. The reason is one of
  `outside_namespace`, `invalid_device_id`, `unknown_topic`, `unknown_setting`, `payload_too_large`
  (> 16 KiB), `invalid_json` (including invalid UTF-8) or `invalid_payload`.
- `buildCommand` / `buildSettingsSet` / `buildSettingsGet` take the `request_id` and timestamp
  from the caller, which keeps them deterministic in tests. They add `protocol_version: "1.2"`, and
  the envelope is applied last, so caller params can't override `request_id` or `timestamp`.

## Consequences

- The bridge now validates every message. The per-tick `mqtt ingest` log line counts accepted
  messages by topic path and rejections by reason, with up to 3 samples per tick. It is logged at
  `warn` when anything was rejected. Persisting rejections to `rejected_messages` is phase 4.
- Zod adds weight to the Worker bundle: `wrangler deploy --dry-run` reports about 861 KiB raw /
  143 KiB gzip in total. That is well below the 3 MiB free-plan limit. `zod/mini` would be smaller
  but less readable, so we don't use it unless startup time becomes a problem.
- New topic or field: change the Zod schema, add the spec example to `examples.ts`, run
  `gen:schema` and commit the regenerated JSON Schema in the same PR.
