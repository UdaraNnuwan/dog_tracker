import { SELF, env } from "cloudflare:test";
import type { LiveEvent } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { BRIDGE_ID } from "../src/bridge/MqttBridge.js";

const upgrade = { headers: { Upgrade: "websocket" } };

describe("/api/live", () => {
  it("is closed unless the dev flag is set", async () => {
    const res = await SELF.fetch("http://localhost/api/live", upgrade);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
  });

  it("is closed on non-local hosts even with the dev flag", async () => {
    const { app } = await import("../src/index.js");
    const flagged = { ...env, LIVE_VIEW_UNAUTHENTICATED: "true" };
    const remote = await app.request("https://dog.example.com/api/live", upgrade, flagged);
    expect(remote.status).toBe(401);
    const probe = await app.request("http://localhost/api/live", {}, flagged);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ live: "available" });
  });
});

describe("MqttBridge live socket", () => {
  const stub = () => env.MQTT_BRIDGE.get(env.MQTT_BRIDGE.idFromName(BRIDGE_ID));

  it("rejects plain requests", async () => {
    const res = await stub().fetch("http://bridge/live");
    expect(res.status).toBe(426);
  });

  it("sends a snapshot to each new browser", async () => {
    const res = await stub().fetch("http://bridge/live", upgrade);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const first = new Promise<LiveEvent>((resolve) =>
      ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data)) as LiveEvent)),
    );
    ws.accept();
    expect(await first).toMatchObject({
      type: "snapshot",
      devices: [],
      demo: { running: false, devices: [] },
    });
    ws.close();
  });
});
