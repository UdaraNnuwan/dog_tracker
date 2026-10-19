import { SELF, env } from "cloudflare:test";
import { parseInbound } from "@udara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoRun, demoOptions } from "../src/bridge/demo.js";

describe("DemoRun", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("feeds simulated and scripted messages, then goes offline", () => {
    const seen: { topic: string; payload: string }[] = [];
    let ended = 0;
    const run = new DemoRun(
      { devices: 2, seconds: 40 },
      (topic, payload) => seen.push({ topic, payload }),
      () => ended++,
    );
    run.start();
    expect(run.devices).toEqual(["demo01", "demo02"]);
    vi.advanceTimersByTime(40_000);

    const results = seen.map((m) => parseInbound(m.topic, m.payload));
    const accepted = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    // Exactly the scripted invalid battery payload is rejected.
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: "invalid_payload", path: "telemetry/battery" });
    const paths = new Set(accepted.map((r) => (r.ok ? r.value.path : "")));
    for (const p of ["telemetry/gps", "event/geofence", "event/tamper", "diagnostic/log"]) {
      expect(paths).toContain(p);
    }
    const geofence = accepted.find((r) => r.ok && r.value.path === "event/geofence");
    expect(geofence?.ok && geofence.value.data).toMatchObject({
      latitude: expect.any(Number) as number,
      longitude: expect.any(Number) as number,
    });
    expect(seen.at(-1)?.topic).toBe("pettracker/backend/demo02/status/connectivity");
    expect(JSON.parse(seen.at(-1)!.payload)).toEqual({ status: "offline" });
    expect(ended).toBe(1);
    expect(run.status().running).toBe(false);

    // Nothing more after the end; stop() is idempotent.
    const count = seen.length;
    vi.advanceTimersByTime(10_000);
    run.stop();
    expect(seen).toHaveLength(count);
    expect(ended).toBe(1);
  });

  it("clamps request options", () => {
    expect(demoOptions({})).toEqual({ devices: 2, seconds: 60 });
    expect(demoOptions({ devices: 99, seconds: 99_999 })).toEqual({ devices: 5, seconds: 600 });
    expect(demoOptions({ devices: "3", seconds: -1 })).toEqual({ devices: 2, seconds: 60 });
  });
});

describe("/api/demo", () => {
  it("is development only", async () => {
    const res = await SELF.fetch("http://localhost/api/demo", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("starts, reports and stops a run", async () => {
    const { app } = await import("../src/index.js");
    const flagged = { ...env, LIVE_VIEW_UNAUTHENTICATED: "true" };
    const start = await app.request(
      "http://localhost/api/demo",
      { method: "POST", body: JSON.stringify({ devices: 1, seconds: 30 }) },
      flagged,
    );
    expect(await start.json()).toMatchObject({ running: true, devices: ["demo01"] });
    const status = await app.request("http://localhost/api/demo", {}, flagged);
    expect(await status.json()).toMatchObject({ running: true });
    const stop = await app.request("http://localhost/api/demo", { method: "DELETE" }, flagged);
    expect(await stop.json()).toMatchObject({ running: false, devices: ["demo01"] });
  });
});
