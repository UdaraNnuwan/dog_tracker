# Architecture Decision Records

One file per decision: `NNNN-short-title.md` with Status, Date, Context, Decision(s), Consequences.
Required for any architectural decision or deviation from the MQTT spec (see CLAUDE.md).

| ADR | Title | Status |
| --- | ----- | ------ |
| [0001](0001-mqtt-client-in-durable-object.md) | MQTT client inside the `MqttBridge` Durable Object | Accepted |
| [0002](0002-payload-contracts.md) | Payload contracts: Zod schemas, generated JSON Schema, gap-filling rules | Accepted |
| [0003](0003-public-broker-for-development.md) | Public HiveMQ broker for development | Accepted |
| [0004](0004-dev-live-view-before-auth.md) | Development live view before authentication (temporary) | Accepted |
| [0005](0005-leaflet-instead-of-maplibre.md) | Leaflet instead of MapLibre GL (no WebGL2 requirement) | Accepted |
| [0006](0006-telemetry-storage-and-history.md) | Telemetry storage, history API and clearing data | Accepted |
| [0007](0007-csv-replay-test-data.md) | CSV test data and replay | Accepted |
