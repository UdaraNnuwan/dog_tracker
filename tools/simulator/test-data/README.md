# CSV test data for `pnpm replay`

One file per MQTT topic. The path is the topic after `pettracker/{device_id}/`:

```
backend/telemetry/gps.csv               → pettracker/<device_id>/backend/telemetry/gps
device/command/buzzer.csv               → pettracker/<device_id>/device/command/buzzer
device/settings/ack/gps_settings.csv    → pettracker/<device_id>/device/settings/ack/gps_settings
```

Columns: `offset_s` (seconds after start), `device_id`, then payload fields. Dots nest
(`acceleration.x`). Types are inferred (`true`/`false`, numbers, text). Force one with a suffix:
`error_code:string`, `gps_interval:number`, `enabled:boolean`, `vaccines:json`. Empty cells are left out.
Without a `timestamp` column each message gets the current time. Rows the backend would publish
get a fresh UUID when they have none: `request_id` for commands, `setting_id` for settings SET/GET.

This set covers every topic in the spec V3 catalogue: two collars (`csvdog01`, `csvdog02`) over
10 minutes. `../test-data-invalid` holds rows that must be rejected.

```sh
pnpm replay --speed 10                    # whole set, 10× faster
pnpm replay --only telemetry/gps --loop   # just GPS, forever
pnpm replay --device mydog                # everything as one device
pnpm replay --dir tools/simulator/test-data-invalid
pnpm replay --check                       # validate files only
```
