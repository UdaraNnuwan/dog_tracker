import { parseInbound } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { IngestBuffer } from "../src/storage/IngestBuffer.js";
import { GpsThinner, toStoredMessage } from "../src/storage/rows.js";

const T = "pettracker/backend/dog001";
const parse = (path: string, body: object | string) =>
  parseInbound(`${T}/${path}`, typeof body === "string" ? body : JSON.stringify(body));
const gps = (ts: number, lat: number) => ({ timestamp: ts, latitude: lat, longitude: 79.8 });

describe("toStoredMessage", () => {
  it("keeps device time and receive time", () => {
    const r = parse("telemetry/battery", {
      timestamp: 100,
      voltage: 3.9,
      percentage: 80,
      charging: false,
    });
    if (!r.ok) throw new Error("fixture");
    expect(toStoredMessage(r.value, 105, false)).toEqual({
      device_id: "dog001",
      topic: "telemetry/battery",
      ts: 100,
      received_at: 105,
      retained: false,
      data: { timestamp: 100, voltage: 3.9, percentage: 80, charging: false },
    });
  });

  it("uses receive time when the payload has no timestamp (Last Will)", () => {
    const r = parse("status/connectivity", { status: "offline" });
    if (!r.ok) throw new Error("fixture");
    expect(toStoredMessage(r.value, 200, true)).toMatchObject({ ts: 200, retained: true });
  });

  it("names settings responses by setting and drops raw IMU (rule 10)", () => {
    const s = parse("settings/response/gps_interval", {
      timestamp: 1,
      request_id: "r",
      status: "success",
      value: 45,
    });
    const imu = parse("telemetry/imu", {
      timestamp: 1,
      accelerometer: { x: 0, y: 0, z: 9.8 },
      gyroscope: { x: 0, y: 0, z: 0 },
    });
    if (!s.ok || !imu.ok) throw new Error("fixture");
    expect(toStoredMessage(s.value, 2, false)?.topic).toBe("settings/response/gps_interval");
    expect(toStoredMessage(imu.value, 2, false)).toBeNull();
  });
});

describe("GpsThinner", () => {
  it("skips points within 5 m unless 5 minutes passed", () => {
    const t = new GpsThinner();
    expect(t.keep("d", 6.9, 79.8, 0)).toBe(true);
    expect(t.keep("d", 6.90001, 79.8, 30)).toBe(false); // ~1 m
    expect(t.keep("d", 6.9001, 79.8, 60)).toBe(true); // ~11 m
    expect(t.keep("d", 6.9001, 79.8, 200)).toBe(false);
    expect(t.keep("d", 6.9001, 79.8, 360)).toBe(true); // 300 s since last stored
    expect(t.keep("other", 6.9001, 79.8, 361)).toBe(true);
  });
});

describe("IngestBuffer", () => {
  it("buffers accepted and rejected messages and thins GPS", () => {
    const b = new IngestBuffer();
    b.add(`${T}/telemetry/gps`, parse("telemetry/gps", gps(1, 6.9)), false, 10);
    b.add(`${T}/telemetry/gps`, parse("telemetry/gps", gps(2, 6.9)), false, 11);
    b.add(`${T}/telemetry/gps`, parse("telemetry/gps", "nope"), false, 12);
    const batch = b.drain();
    expect(batch.messages).toHaveLength(1);
    expect(batch.rejected).toEqual([
      {
        received_at: 12,
        topic: `${T}/telemetry/gps`,
        device_id: "dog001",
        reason: "invalid_json",
        issues: [expect.any(String)],
      },
    ]);
    expect(b.size).toBe(0);
  });

  it("puts a failed batch back in front", () => {
    const b = new IngestBuffer();
    b.add(`${T}/telemetry/gps`, parse("telemetry/gps", gps(1, 6.9)), false, 10);
    const failed = b.drain();
    b.add(`${T}/telemetry/gps`, parse("telemetry/gps", gps(400, 7)), false, 20);
    b.restore(failed);
    expect(b.drain().messages.map((m) => m.ts)).toEqual([1, 400]);
  });

  it("clears one device including its GPS thinning state", () => {
    const b = new IngestBuffer();
    b.add(`${T}/telemetry/gps`, parse("telemetry/gps", gps(1, 6.9)), false, 10);
    b.clear("dog001");
    expect(b.size).toBe(0);
    b.add(`${T}/telemetry/gps`, parse("telemetry/gps", gps(2, 6.9)), false, 11);
    expect(b.size).toBe(1);
  });
});
