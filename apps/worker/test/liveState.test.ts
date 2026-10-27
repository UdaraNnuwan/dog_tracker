import { parseInbound } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { LiveState } from "../src/bridge/liveState.js";

const gps = (lat: number) =>
  JSON.stringify({ timestamp: 1, latitude: lat, longitude: 79.8, speed: 0 });
const apply = (s: LiveState, topic: string, body: string, at = 100) =>
  s.apply(topic, parseInbound(topic, body), false, at);

describe("LiveState", () => {
  it("turns accepted messages into events and keeps the latest per topic", () => {
    const s = new LiveState();
    apply(s, "pettracker/dog001/backend/telemetry/gps", gps(6.1), 100);
    const event = apply(s, "pettracker/dog001/backend/telemetry/gps", gps(6.2), 105);
    expect(event).toEqual({
      type: "message",
      deviceId: "dog001",
      key: "telemetry/gps",
      data: { timestamp: 1, latitude: 6.2, longitude: 79.8, speed: 0 },
      receivedAt: 105,
      retained: false,
    });
    expect(s.deviceList()).toEqual([
      {
        deviceId: "dog001",
        latest: {
          "telemetry/gps": {
            data: { timestamp: 1, latitude: 6.2, longitude: 79.8, speed: 0 },
            receivedAt: 105,
          },
        },
      },
    ]);
  });

  it("keys settings responses and ACKs by setting group", () => {
    const s = new LiveState();
    const response = apply(
      s,
      "pettracker/dog001/backend/settings/response/gps_settings",
      '{"timestamp":1,"action":"get_response","setting_id":"s","setting_type":"gps","gps_interval":45}',
    );
    expect(response).toMatchObject({ key: "settings/response/gps_settings" });
    const ack = apply(
      s,
      "pettracker/dog001/device/settings/ack/gps_settings",
      '{"timestamp":1,"action":"ack","setting_id":"s","setting_type":"gps"}',
    );
    expect(ack).toMatchObject({ deviceId: "dog001", key: "settings/ack/gps_settings" });
  });

  it("reports rejections without storing them", () => {
    const s = new LiveState();
    expect(apply(s, "pettracker/dog001/backend/telemetry/gps", "nope")).toMatchObject({
      type: "rejected",
      reason: "invalid_json",
      topic: "pettracker/dog001/backend/telemetry/gps",
    });
    expect(s.deviceList()).toEqual([]);
  });

  it("evicts the least recently updated device beyond the cap", () => {
    const s = new LiveState(2);
    apply(s, "pettracker/a/backend/telemetry/gps", gps(1));
    apply(s, "pettracker/b/backend/telemetry/gps", gps(1));
    apply(s, "pettracker/a/backend/telemetry/gps", gps(2));
    apply(s, "pettracker/c/backend/telemetry/gps", gps(1));
    expect(s.deviceList().map((d) => d.deviceId)).toEqual(["a", "c"]);
  });
});
