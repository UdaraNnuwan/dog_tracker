import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseHistoryQuery } from "../src/storage/history.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");

describe("parseHistoryQuery", () => {
  it("defaults to the last 24 hours", () => {
    expect(parseHistoryQuery("dog001", "gps", {}, NOW)).toEqual({
      deviceId: "dog001",
      kind: "gps",
      from: "2026-10-18T12:00:00.000Z",
      to: "2026-10-19T12:00:00.000Z",
      limit: 2000,
      category: null,
    });
  });

  it.each([
    ["Dog001", "gps", {}],
    ["dog001", "imu", {}],
    ["dog001", "gps", { from: "yesterday" }],
    ["dog001", "gps", { from: "2026-10-20T00:00:00Z", to: "2026-10-19T00:00:00Z" }],
    ["dog001", "gps", { limit: "0" }],
    ["dog001", "messages", { category: "telemetry" }],
  ])("rejects %s/%s %j", (id, kind, params) => {
    expect(typeof parseHistoryQuery(id, kind, params, NOW)).toBe("string");
  });
});

describe("history API access", () => {
  it.each(["/api/devices", "/api/devices/dog001/history/gps"])(
    "%s is closed without the dev flag",
    async (path) => {
      expect((await SELF.fetch(`http://localhost${path}`)).status).toBe(401);
    },
  );

  it("clearing is closed on non-local hosts even with the flag", async () => {
    const { app } = await import("../src/index.js");
    const flagged = { ...env, LIVE_VIEW_UNAUTHENTICATED: "true" };
    const res = await app.request(
      "https://dog.example.com/api/history",
      { method: "DELETE" },
      flagged,
    );
    expect(res.status).toBe(401);
  });

  it("reports missing storage configuration", async () => {
    const { app } = await import("../src/index.js");
    const flagged = { ...env, LIVE_VIEW_UNAUTHENTICATED: "true" };
    const res = await app.request("http://localhost/api/devices", {}, flagged);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "storage_not_configured" });
  });
});
