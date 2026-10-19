import { parseInbound } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { LiveState } from "../src/bridge/liveState.js";

const gps = (lat: number) => JSON.stringify({ timestamp: 1, latitude: lat, longitude: 79.8 });
const apply = (s: LiveState, topic: string, body: string, at = 100) =>
  s.apply(topic, parseInbound(topic, body), false, at);

describe("LiveState", () => {
  it("turns accepted messages into events and keeps the latest per topic", () => {
    const s = new LiveState();
    apply(s, "pettracker/backend/dog001/telemetry/gps", gps(6.1), 100);
    const event = apply(s, "pettracker/backend/dog001/telemetry/gps", gps(6.2), 105);
    expect(event).toEqual({
      type: "message",
      deviceId: "dog001",
      key: "telemetry/gps",
      data: { timestamp: 1, latitude: 6.2, longitude: 79.8 },
      receivedAt: 105,
      retained: false,
    });
    expect(s.deviceList()).toEqual([
      {
        deviceId: "dog001",
        latest: {
          "telemetry/gps": {
            data: { timestamp: 1, latitude: 6.2, longitude: 79.8 },
            receivedAt: 105,
          },
        },
      },
    ]);
  });

  it("keys settings responses by setting name", () => {
    const s = new LiveState();
    const event = apply(
      s,
      "pettracker/backend/dog001/settings/response/gps_interval",
      '{"timestamp":1,"request_id":"r","status":"success","value":45}',
    );
    expect(event).toMatchObject({ key: "settings/response/gps_interval" });
  });

  it("reports rejections without storing them", () => {
    const s = new LiveState();
    expect(apply(s, "pettracker/backend/dog001/telemetry/gps", "nope")).toMatchObject({
      type: "rejected",
      reason: "invalid_json",
      topic: "pettracker/backend/dog001/telemetry/gps",
    });
    expect(s.deviceList()).toEqual([]);
  });

  it("evicts the least recently updated device beyond the cap", () => {
    const s = new LiveState(2);
    apply(s, "pettracker/backend/a/telemetry/gps", gps(1));
    apply(s, "pettracker/backend/b/telemetry/gps", gps(1));
    apply(s, "pettracker/backend/a/telemetry/gps", gps(2));
    apply(s, "pettracker/backend/c/telemetry/gps", gps(1));
    expect(s.deviceList().map((d) => d.deviceId)).toEqual(["a", "c"]);
  });
});
