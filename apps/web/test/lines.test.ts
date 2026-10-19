import { describe, expect, it } from "vitest";
import { fromLive, fromRow, matches } from "../src/logs/lines.js";

describe("log lines", () => {
  const live = fromLive({
    seq: 7,
    at: 100,
    level: "warn",
    source: "ingest",
    deviceId: "demo01",
    topic: "event/geofence",
    message: "exit home · saved to history",
    detail: null,
  });

  it("normalises live lines and saved rows alike", () => {
    expect(live).toMatchObject({ key: "live:100:7", at: 100, level: "warn" });
    expect(
      fromRow({
        id: 42,
        at: "1970-01-01T00:01:40Z",
        level: "error",
        source: "storage",
        device_id: null,
        topic: null,
        message: "storage flush failed, retrying",
        detail: { error: "x" },
      }),
    ).toMatchObject({ key: "db:42", at: 100, level: "error", deviceId: null });
  });

  it("filters by device, topic and minimum level", () => {
    const f = { deviceId: "demo01", topic: "event/geofence", minLevel: "info" as const };
    expect(matches(live, f)).toBe(true);
    expect(matches(live, { ...f, minLevel: "error" })).toBe(false);
    expect(matches(live, { ...f, deviceId: "demo02" })).toBe(false);
    expect(matches(live, { ...f, topic: "telemetry/gps" })).toBe(false);
    expect(matches(live, { deviceId: null, topic: null, minLevel: "debug" })).toBe(true);
  });
});

describe("log JSON", () => {
  it("takes the raw payload from the detail and pretty-prints it when valid", async () => {
    const { payloadOf, prettyJson } = await import("../src/logs/lines.js");
    expect(payloadOf({ payload: '{"a":1}', bytes: 7 })).toBe('{"a":1}');
    expect(payloadOf({ error: "x" })).toBeNull();
    expect(payloadOf(null)).toBeNull();
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("not json")).toBe("not json");
  });
});
