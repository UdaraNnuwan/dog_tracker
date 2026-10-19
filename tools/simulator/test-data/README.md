# CSV test data for `pnpm replay`

One file per MQTT topic. The path is the topic after `pettracker/{direction}/{device_id}/`:

```
backend/telemetry/gps.csv      → pettracker/backend/<device_id>/telemetry/gps
device/command/buzzer.csv      → pettracker/device/<device_id>/command/buzzer
```

Columns: `offset_s` (seconds after start), `device_id`, then payload fields. Dots nest
(`accelerometer.x`). Types are inferred (`true`/`false`, numbers, text). Force one with a suffix:
`error_code:string`, `value:number`, `detected:boolean`, `extra:json`. Empty cells are left out.
Without a `timestamp` column each message gets the current time. Device-bound rows without a
`request_id` get a fresh UUID.

This set covers every topic in the spec catalogue: two collars (`csvdog01`, `csvdog02`) over
10 minutes. `../test-data-invalid` holds rows that must be rejected.

```sh
pnpm replay --speed 10                    # whole set, 10× faster
pnpm replay --only telemetry/gps --loop   # just GPS, forever
pnpm replay --device mydog                # everything as one device
pnpm replay --dir tools/simulator/test-data-invalid
pnpm replay --check                       # validate files only
```
