import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("api", () => {
  it("GET /api/health reports the bridge state without connecting", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      bridge: { state: "idle", connectedSince: null, lastMessageAt: null },
      storage: { state: "disabled", pending: 0, lastFlushAt: null },
    });
  });

  it("unknown API routes return JSON 404", async () => {
    const res = await SELF.fetch("https://example.com/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
