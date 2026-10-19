# 0003 – Public HiveMQ broker for development

- Status: Accepted
- Date: 2026-10-19

## Context

Until the HiveMQ Cloud cluster and its credentials are set up, we want to develop and test the
bridge end to end. HiveMQ runs a free public broker, `broker.hivemq.com`, which accepts anonymous
MQTT 3.1.1 over TLS WebSocket on port 8884, path `/mqtt`. This is the same transport the bridge
uses for HiveMQ Cloud.

## Decision

- `HIVEMQ_USERNAME` and `HIVEMQ_PASSWORD` are optional. If both are empty, the bridge sends
  CONNECT without credentials. If only one is set, the configuration is invalid and the bridge
  stays `unconfigured`.
- The public broker is only for local development (`.dev.vars`). Staging and production must
  use HiveMQ Cloud with credentials.

## Consequences

- Anyone on the internet can subscribe to or publish on `pettracker/#` on the public broker. Use
  only simulator data. Commands and ingested messages there are untrusted (inbound validation per
  CLAUDE.md rule 4 still applies).
- Client ids on the public broker are shared with everyone, so `MQTT_CLIENT_ID` must be unique
  (e.g. `udara-dog-collar-bridge-dev-<name>`). Otherwise someone else's client can kick ours off.
- The public broker gives no guarantees for persistent sessions (`cleanSession=false`) or uptime.
