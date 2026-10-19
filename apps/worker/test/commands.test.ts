import { SELF, env } from "cloudflare:test";
import type { RequestStatus } from "@udara/contracts";
import { describe, expect, it } from "vitest";

const flagged = { ...env, LIVE_VIEW_UNAUTHENTICATED: "true" };
const post = async (path: string, body: unknown) => {
  const { app } = await import("../src/index.js");
  return app.request(
    `http://localhost/api${path}`,
    { method: "POST", body: JSON.stringify(body) },
    flagged,
  );
};

describe("commands & settings API", () => {
  it("is development only", async () => {
    const res = await SELF.fetch("http://localhost/api/devices/demo01/commands/reboot", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("validates before publishing (rule 8)", async () => {
    const tooShort = await post("/devices/demo01/settings/gps_interval/set", { value: 5 });
    expect(tooShort.status).toBe(400);
    expect(await tooShort.json()).toMatchObject({ reason: "invalid_payload" });
    expect((await post("/devices/demo01/commands/firmware_update", {})).status).toBe(400);
    expect((await post("/devices/demo01/commands/buzzer", { enabled: "yes" })).status).toBe(400);
    expect((await post("/devices/Bad/commands/reboot", {})).status).toBe(400);
  });

  it("reports a send failure when neither MQTT nor a demo collar can take it", async () => {
    const res = await post("/devices/nobody/commands/reboot", {});
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: "error", error: "mqtt not connected" });
  });

  it("round-trips a command and a setting with a demo collar", async () => {
    await post("/demo", { devices: 1, seconds: 30 });
    const cmd = await post("/devices/demo01/commands/buzzer", { enabled: true, duration: 2 });
    expect(cmd.status).toBe(202);
    const sent = await cmd.json<RequestStatus>();
    expect(sent).toMatchObject({
      state: "pending",
      path: "command/buzzer",
      responsePath: "response/buzzer",
    });
    expect(JSON.parse(sent.payload)).toMatchObject({
      enabled: true,
      duration: 2,
      request_id: sent.requestId,
      protocol_version: "1.2",
    });
    expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const set = await (
      await post("/devices/demo01/settings/gps_interval/set", { value: 45 })
    ).json<RequestStatus>();

    // The simulator answers after 300–1000 ms.
    const { app } = await import("../src/index.js");
    let list: RequestStatus[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await app.request("http://localhost/api/requests", {}, flagged);
      list = (await res.json<{ requests: RequestStatus[] }>()).requests;
      const mine = list.filter(
        (r) => r.requestId === sent.requestId || r.requestId === set.requestId,
      );
      if (mine.length === 2 && mine.every((r) => r.state !== "pending")) break;
    }
    const cmdDone = list.find((r) => r.requestId === sent.requestId)!;
    const setDone = list.find((r) => r.requestId === set.requestId)!;
    expect(cmdDone.state).toBe("success");
    expect(JSON.parse(cmdDone.response!)).toMatchObject({
      request_id: sent.requestId,
      status: "success",
    });
    expect(setDone.state).toBe("success");
    expect(JSON.parse(setDone.response!)).toMatchObject({ value: 45 });
    await app.request("http://localhost/api/demo", { method: "DELETE" }, flagged);
  });
});
