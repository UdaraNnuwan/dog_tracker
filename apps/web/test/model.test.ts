import type { LiveEvent } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { REJECTED_KEY, connectivity, emptyModel, reduce, sortDevices } from "../src/live/model.js";

const msg = (deviceId: string, key: string, data: object, receivedAt = 100): LiveEvent => ({
  type: "message",
  deviceId,
  key,
  data: data as never,
  receivedAt,
  retained: false,
});

describe("live model", () => {
  it("tracks latest readings, last seen and the GPS trail", () => {
    let m = reduce(
      emptyModel,
      msg("dog1", "telemetry/gps", { timestamp: 1, latitude: 6, longitude: 79 }, 100),
    );
    m = reduce(m, msg("dog1", "telemetry/battery", { timestamp: 2, percentage: 50 }, 105));
    m = reduce(
      m,
      msg("dog1", "telemetry/gps", { timestamp: 3, latitude: 6.1, longitude: 79.1 }, 110),
    );
    const d = m.devices.dog1!;
    expect(d.lastSeen).toBe(110);
    expect(d.trail).toEqual([
      [79, 6],
      [79.1, 6.1],
    ]);
    expect(Object.keys(d.latest)).toEqual(["telemetry/gps", "telemetry/battery"]);
    expect(m.log.map((e) => e.seq)).toEqual([3, 2, 1]);
  });

  it("counts rejections in the log", () => {
    const m = reduce(emptyModel, {
      type: "rejected",
      topic: "pettracker/backend/x/telemetry/gps",
      reason: "invalid_json",
      issues: ["bad"],
      receivedAt: 1,
    });
    expect(m.rejected).toBe(1);
    expect(m.log[0]).toMatchObject({ ok: false, body: "bad" });
  });

  it("keeps trails across a reconnect snapshot", () => {
    let m = reduce(
      emptyModel,
      msg("dog1", "telemetry/gps", { timestamp: 1, latitude: 6, longitude: 79 }),
    );
    m = reduce(m, msg("dog1", "telemetry/gps", { timestamp: 2, latitude: 6.1, longitude: 79 }));
    m = reduce(m, {
      type: "snapshot",
      devices: [
        {
          deviceId: "dog1",
          latest: {
            "telemetry/gps": {
              data: { timestamp: 2, latitude: 6.1, longitude: 79 },
              receivedAt: 200,
            },
          },
        },
      ],
    });
    expect(m.devices.dog1!.trail).toHaveLength(2);
    expect(m.devices.dog1!.lastSeen).toBe(200);
  });

  it("sorts online devices first, then by last seen", () => {
    let m = reduce(emptyModel, msg("a", "status/connectivity", { status: "offline" }, 300));
    m = reduce(m, msg("b", "status/connectivity", { status: "online" }, 100));
    m = reduce(m, msg("c", "telemetry/gps", { timestamp: 1, latitude: 0, longitude: 0 }, 200));
    expect(sortDevices(Object.values(m.devices)).map((d) => d.deviceId)).toEqual(["b", "a", "c"]);
    expect(connectivity(m.devices.c!)).toBe("unknown");
  });
});

describe("topic log", () => {
  it("keeps entries per topic, newest first, and rejections separately", () => {
    let m = reduce(
      emptyModel,
      msg("dog1", "telemetry/gps", { timestamp: 1, latitude: 6, longitude: 79 }, 100),
    );
    m = reduce(m, msg("dog2", "telemetry/gps", { timestamp: 2, latitude: 6, longitude: 79 }, 101));
    m = reduce(
      m,
      msg("dog1", "event/geofence", { timestamp: 3, geofence_id: "home", event: "exit" }, 102),
    );
    m = reduce(m, {
      type: "rejected",
      topic: "pettracker/backend/x/telemetry/gps",
      reason: "invalid_json",
      issues: ["bad"],
      receivedAt: 103,
    });
    expect(m.byTopic["telemetry/gps"]!.map((e) => e.deviceId)).toEqual(["dog2", "dog1"]);
    expect(m.byTopic["event/geofence"]).toHaveLength(1);
    expect(m.byTopic[REJECTED_KEY]![0]!.data).toEqual({
      topic: "pettracker/backend/x/telemetry/gps",
      reason: "invalid_json",
      issues: "bad",
    });
  });

  it("caps each topic at 100 entries", () => {
    let m = emptyModel;
    for (let i = 0; i < 150; i++)
      m = reduce(m, msg("dog1", "telemetry/battery", { timestamp: i, percentage: 50 }, i));
    expect(m.byTopic["telemetry/battery"]).toHaveLength(100);
    expect(m.byTopic["telemetry/battery"]![0]!.data.timestamp).toBe(149);
  });
});
