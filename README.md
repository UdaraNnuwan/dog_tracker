# Udara Smart Dog Collar Monitoring

Realtime monitoring web app for Smart Dog Collar devices, built against the
[MQTT Interface Specification v1.2](docs/spec/Smart_Dog_Collar_MQTT_Interface_Specification_v1.2.pdf).
Architecture, rules and build phases are in [CLAUDE.md](CLAUDE.md); decisions are in [docs/adr](docs/adr).

## Layout

| Path | What |
| ---- | ---- |
| `apps/worker` | Cloudflare Worker: Hono API under `/api/*`, `MqttBridge` Durable Object (the only MQTT client), cron watchdog |
| `apps/web` | React + Vite SPA, served as the Worker's static assets. Currently the dev live view (ADR 0004) |
| `packages/contracts` | Topic builders/parsers, Zod schema for every payload, settings registry, spec examples. Generated JSON Schema for firmware in `packages/contracts/json-schema` |
| `packages/db-types` | Generated Supabase types (from phase 4) |
| `tools/simulator` | Fake collars (mqtt.js): telemetry, events, LWT, command/settings responses |

## Setup

Requires Node 20+ and pnpm (`corepack enable` or `corepack install -g pnpm@10`).

```sh
pnpm i
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # fill in HiveMQ credentials; never commit
pnpm --filter @udara/web build                           # assets the Worker serves
pnpm dev                                                 # Vite on :5173 (proxies /api) + wrangler dev on :8787
```

The bridge is started by the cron watchdog. Locally, trigger it with
`curl http://localhost:8787/cdn-cgi/handler/scheduled`, then check `curl http://localhost:8787/api/health`
(`bridge.state` goes `idle` → `connecting` → `ready`).

### See live data

```sh
pnpm sim --devices 3 --prefix <yourname>   # fake collars; `pnpm sim --help` for options
```

Open http://localhost:5173. The live view lists devices, shows them on a map and shows the latest
reading per topic plus a message log. Without login it only opens on localhost with
`LIVE_VIEW_UNAUTHENTICATED=true` in `.dev.vars` (ADR 0004). On the public broker, pick a unique
`--prefix`: device ids are shared with everyone.

### Store data (Supabase)

Once per Supabase project (`supabase login` first):

```sh
supabase link --project-ref <project-ref>   # asks for the database password
supabase db push                            # applies supabase/migrations
```

Then set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (Project Settings → API Keys → secret key,
`sb_secret_…`) in `apps/worker/.dev.vars` and restart `pnpm dev`. `/api/health` shows
`storage.state: "ok"` and `lastFlushAt` once rows are written. The **History** tab shows stored
data per device and time range (location, battery & temperature, signal, events) and can clear
it (ADR 0006). After a schema change, run `pnpm db:types`.

### Replay CSV test data

```sh
pnpm replay --speed 10        # every topic, two collars, 10 minutes of data in 1 minute
pnpm replay --help            # --only, --device, --loop, --check, --skip-invalid …
```

Files: `tools/simulator/test-data/{backend,device}/<topic>.csv` (format in its README, ADR 0007).

Use your own `MQTT_CLIENT_ID` in `.dev.vars`. Sharing the deployed bridge's id makes the broker
disconnect one bridge for the other (ADR 0001 §4).

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test
```

## Deploy

Secrets (once per environment): `wrangler secret put HIVEMQ_HOST`, `HIVEMQ_USERNAME`, `HIVEMQ_PASSWORD`,
`SUPABASE_URL`, `SUPABASE_SECRET_KEY`
(add `--env staging` for staging). Then `pnpm --filter @udara/worker deploy`
(or `deploy:staging`) after building the web app.
