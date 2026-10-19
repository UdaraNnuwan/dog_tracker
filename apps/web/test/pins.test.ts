import { describe, expect, it } from "vitest";
import { pinsFor } from "../src/device/pins.js";
import type { TopicEntry } from "../src/live/model.js";

let seq = 0;
const row = (deviceId: string, data: Record<string, unknown>, at = 100): TopicEntry => ({
  seq: ++seq,
  at,
  deviceId,
  retained: false,
  data,
});

const gps = [
  row("d1", { timestamp: 100, latitude: 6.1, longitude: 79.1 }),
  row("d1", { timestamp: 200, latitude: 6.2, longitude: 79.2 }),
  row("d2", { timestamp: 190, latitude: 7, longitude: 80 }),
];

describe("pinsFor", () => {
  it("uses the event's own position when it has one", () => {
    const rows = [
      row("d1", {
        timestamp: 150,
        geofence_id: "home",
        event: "exit",
        latitude: 6.5,
        longitude: 79.5,
      }),
    ];
    expect(pinsFor("event/geofence", rows, gps, "d1")).toMatchObject([
      { latitude: 6.5, longitude: 79.5 },
    ]);
  });

  it("places geofence events without a position at the nearest GPS fix of that device", () => {
    const rows = [row("d1", { timestamp: 190, geofence_id: "home", event: "enter" })];
    const [pin] = pinsFor("event/geofence", rows, gps, "d1");
    expect(pin).toMatchObject({ latitude: 6.2, longitude: 79.2 });
    expect(pin!.label).toMatch(/≈ nearest GPS fix/);
  });

  it("skips events with no fix nearby, other devices and GPS itself", () => {
    const far = [row("d1", { timestamp: 5_000, geofence_id: "home", event: "exit" })];
    expect(pinsFor("event/geofence", far, gps, "d1")).toEqual([]);
    const other = [row("d2", { timestamp: 190, latitude: 7, longitude: 80 })];
    expect(pinsFor("response/location", other, gps, "d1")).toEqual([]);
    expect(pinsFor("telemetry/gps", gps, gps, "d1")).toEqual([]);
  });
});
