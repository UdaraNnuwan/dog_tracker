# ADR 0007: CSV test data and replay

- Status: Accepted
- Date: 2026-10-19

## Context

Every MQTT topic needs a repeatable test data set, editable without code and replayable to
the broker. The random simulator (`pnpm sim`) is good for continuous traffic, but its output is
neither repeatable nor easy to tweak.

## Decision

- `tools/simulator/test-data/{backend|device}/<topic path>.csv`: one file per topic, and the
  path is the topic, e.g. `backend/telemetry/gps.csv` → `pettracker/backend/<device_id>/telemetry/gps`.
  The bundled set covers all 27 catalogue topics for two collars over 10 minutes, including
  command → response pairs. `test-data-invalid/` holds rows that must be rejected.
- Columns: `offset_s`, `device_id`, then payload fields, with dots for nesting. Types are
  inferred; force one with a `name:string|number|boolean|json` header suffix.
- `pnpm replay` validates every row against `@udara/contracts` before connecting. Invalid rows
  are reported and, unless `--skip-invalid` is given, still published, so the backend's rejection
  path can be exercised. Options: `--speed`, `--loop`, `--only`, `--device`, `--check`.
- Timestamps follow the CSV timeline, not the wall clock. `base + offset_s` is chosen so that
  no timestamp is in the future and a sped-up replay doesn't collapse rows onto the same second
  (which the `(device_id, ts)` keys would deduplicate).
- QoS and retain come from the topic catalogue (spec §4), as a real collar would use them.
- Tests check that `test-data` is fully valid, that every row in `test-data-invalid` is
  rejected, and that the CSV parser handles quoting and types.

## Consequences

- Adding a topic means adding its CSV, and the test that counts 27 files has to be updated.
- The replayer publishes all devices through one MQTT client. It doesn't exercise per-device
  Last Will; `pnpm sim` covers that.
