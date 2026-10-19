import { Hono, type MiddlewareHandler } from "hono";
import { isValidDeviceId } from "@udara/contracts";
import { BRIDGE_ID } from "./bridge/MqttBridge.js";
import type { Env } from "./env.js";
import { log } from "./log.js";
import { listDevices, parseHistoryQuery, queryHistory } from "./storage/history.js";
import { serviceClient } from "./storage/supabase.js";

export { MqttBridge } from "./bridge/MqttBridge.js";

function bridge(env: Env) {
  return env.MQTT_BRIDGE.get(env.MQTT_BRIDGE.idFromName(BRIDGE_ID));
}

// Static assets (the SPA) are served by the platform; only /api/* reaches this app
// (`assets.run_worker_first` in wrangler.jsonc).
export const app = new Hono<{ Bindings: Env }>().basePath("/api");

// Public on purpose: exposes coarse state only, no error text (could leak hostnames).
app.get("/health", async (c) => {
  const status = await bridge(c.env).status();
  return c.json({
    ok: true,
    bridge: {
      state: status.state,
      connectedSince: status.connectedSince,
      lastMessageAt: status.lastMessageAt,
    },
    storage: {
      state: status.storage.state,
      pending: status.storage.pending,
      lastFlushAt: status.storage.lastFlushAt,
    },
  });
});

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Until Supabase Auth exists (phase 5), live data, history and clearing are development-only:
 * they need LIVE_VIEW_UNAUTHENTICATED=true (set only in `.dev.vars`) AND a local hostname, so a
 * deployed Worker never serves them without login (ADR 0004, ADR 0006).
 */
const devOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const local = LOCAL_HOSTS.has(new URL(c.req.url).hostname);
  if (c.env.LIVE_VIEW_UNAUTHENTICATED !== "true" || !local) {
    return c.json({ error: "auth_required" }, 401);
  }
  await next();
};

app.use("/live", devOnly);
app.use("/devices", devOnly);
app.use("/devices/*", devOnly);
app.use("/history", devOnly);

app.get("/live", (c) => {
  // A plain GET is the browser's availability probe (it can't read a failed upgrade's status).
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ live: "available" });
  }
  return bridge(c.env).fetch(c.req.raw);
});

const storageMissing = { error: "storage_not_configured" } as const;

/** Devices with their latest stored state. */
app.get("/devices", async (c) => {
  const db = serviceClient(c.env);
  if (!db) return c.json(storageMissing, 503);
  const { data, error } = await listDevices(db);
  if (error) throw new Error(error.message);
  return c.json({ devices: data });
});

/** `GET /api/devices/:id/history/:kind?from=ISO&to=ISO&limit=&category=` */
app.get("/devices/:id/history/:kind", async (c) => {
  const db = serviceClient(c.env);
  if (!db) return c.json(storageMissing, 503);
  const q = parseHistoryQuery(c.req.param("id"), c.req.param("kind"), c.req.query());
  if (typeof q === "string") return c.json({ error: "bad_request", message: q }, 400);
  const { data, error } = await queryHistory(db, q);
  if (error) throw new Error(error.message);
  return c.json({ query: q, rows: data });
});

/** Clears stored history (and the bridge's buffered/live state) for one device. */
app.delete("/devices/:id/history", async (c) => {
  const deviceId = c.req.param("id");
  if (!isValidDeviceId(deviceId)) return c.json({ error: "bad_request" }, 400);
  return clearHistory(c.env, deviceId).then((deleted) => c.json({ deleted }));
});

/** Clears stored history for every device. */
app.delete("/history", async (c) => {
  return clearHistory(c.env).then((deleted) => c.json({ deleted }));
});

async function clearHistory(env: Env, deviceId?: string): Promise<number> {
  const db = serviceClient(env);
  await bridge(env).clearLocal(deviceId);
  if (!db) return 0;
  const { data, error } = await db.rpc(
    "clear_history",
    deviceId === undefined ? {} : { p_device_id: deviceId },
  );
  if (error) throw new Error(error.message);
  log("warn", "history cleared", { ...(deviceId ? { device_id: deviceId } : {}), deleted: data });
  return data;
}

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  log("error", "unhandled api error", { path: c.req.path, error: String(err) });
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,

  // Watchdog: (re)starts the bridge. The bridge's own alarm loop keeps it alive in between.
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      bridge(env)
        .ensureConnected()
        .then((status) => log("info", "bridge watchdog", { state: status.state }))
        .catch((err: unknown) => log("error", "bridge watchdog failed", { error: String(err) })),
    );
  },
} satisfies ExportedHandler<Env>;
