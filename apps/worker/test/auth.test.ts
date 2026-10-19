import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bearerToken,
  clearVerifiedCache,
  emailToUsername,
  usernameToEmail,
  verifyAccessToken,
} from "../src/auth/session.js";
import type { Db } from "../src/storage/supabase.js";

describe("usernames", () => {
  it.each([
    ["udara", "udara@users.dogtracker.local"],
    ["  Udara.N ", "udara.n@users.dogtracker.local"],
    ["dog_admin-1", "dog_admin-1@users.dogtracker.local"],
  ])("%j → %s", (u, email) => {
    expect(usernameToEmail(u)).toBe(email);
    expect(emailToUsername(email)).toBe(u.trim().toLowerCase());
  });

  it.each(["ab", "-udara", "udara@x.com", "u da", "x".repeat(33), ""])("rejects %j", (u) => {
    expect(usernameToEmail(u)).toBeNull();
  });
});

describe("bearerToken", () => {
  const req = (headers: Record<string, string>) => new Request("https://x", { headers });
  it("reads Authorization or the WebSocket subprotocol", () => {
    expect(bearerToken(req({ Authorization: "Bearer abc.def.ghi" }))).toBe("abc.def.ghi");
    expect(bearerToken(req({ "Sec-WebSocket-Protocol": "dogtracker.bearer, abc.def.ghi" }))).toBe(
      "abc.def.ghi",
    );
    expect(bearerToken(req({ Authorization: "Basic xyz" }))).toBeNull();
    expect(bearerToken(req({}))).toBeNull();
  });
});

describe("verifyAccessToken", () => {
  beforeEach(clearVerifiedCache);

  const fakeDb = (claims: Record<string, unknown> | null) => {
    let calls = 0;
    const db = {
      auth: {
        getClaims: () => {
          calls++;
          return Promise.resolve(
            claims ? { data: { claims }, error: null } : { data: null, error: new Error("bad") },
          );
        },
      },
    } as unknown as Db;
    return { db, calls: () => calls };
  };

  it("returns the user and caches the result", async () => {
    const exp = Date.now() / 1000 + 600;
    const f = fakeDb({ sub: "u1", email: "udara@users.dogtracker.local", exp });
    expect(await verifyAccessToken(f.db, "t1")).toEqual({ id: "u1", username: "udara" });
    await verifyAccessToken(f.db, "t1");
    expect(f.calls()).toBe(1);
  });

  it("rejects invalid tokens", async () => {
    expect(await verifyAccessToken(fakeDb(null).db, "t2")).toBeNull();
    expect(await verifyAccessToken(fakeDb({ exp: 1 }).db, "t3")).toBeNull();
  });
});

describe("auth API", () => {
  const remote = "https://dogtracker.example.workers.dev";

  it("protected routes need a session on a deployed hostname", async () => {
    const { app } = await import("../src/index.js");
    for (const path of ["/api/auth/me", "/api/live", "/api/devices", "/api/logs"]) {
      expect((await app.request(`${remote}${path}`, {}, env)).status, path).toBe(401);
    }
  });

  it("local development signs in as the dev user", async () => {
    const { app } = await import("../src/index.js");
    const res = await app.request(
      "http://localhost/api/auth/me",
      {},
      { ...env, LIVE_VIEW_UNAUTHENTICATED: "true" },
    );
    expect(await res.json()).toEqual({
      user: { id: "dev", username: "dev (localhost)" },
      dev: true,
    });
  });

  it("login validates input and needs Supabase configured", async () => {
    const { app } = await import("../src/index.js");
    const post = (body: unknown, e = env) =>
      app.request(`${remote}/api/auth/login`, { method: "POST", body: JSON.stringify(body) }, e);
    expect((await post({ username: "udara", password: "x" })).status).toBe(503);
    const configured = {
      ...env,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "k",
    };
    expect((await post({ username: 1 }, configured)).status).toBe(400);
  });
});
