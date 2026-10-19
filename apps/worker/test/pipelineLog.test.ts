import { parseInbound } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import {
  MAX_LOGGED_PAYLOAD_CHARS,
  PipelineLogger,
  describeInbound,
  rawPayload,
} from "../src/bridge/pipelineLog.js";

const T = "pettracker/backend/dog001";
const parse = (path: string, body: object | string) =>
  parseInbound(`${T}/${path}`, typeof body === "string" ? body : JSON.stringify(body));

describe("describeInbound", () => {
  it("summarises accepted telemetry and keeps the exact JSON", () => {
    const gpsJson = '{"timestamp":1,"latitude":6.9271,"longitude":79.8612,"speed":1,"extra":"x"}';
    const r = parse("telemetry/gps", gpsJson);
    expect(describeInbound(`${T}/telemetry/gps`, r, "stored", gpsJson)).toMatchObject({
      level: "info",
      source: "ingest",
      deviceId: "dog001",
      topic: "telemetry/gps",
      message: "6.92710, 79.86120 · 3.6 km/h · saved to history",
      detail: {
        topic: `${T}/telemetry/gps`,
        bytes: gpsJson.length,
        payload: gpsJson,
        truncated: false,
        outcome: "stored",
      },
    });
    expect(describeInbound(`${T}/telemetry/gps`, r, "thinned", gpsJson).message).toMatch(/< 5 m/);
  });

  it("logs raw IMU at debug (live only)", () => {
    const r = parse("telemetry/imu", {
      timestamp: 1,
      accelerometer: { x: 0, y: 0, z: 9.8 },
      gyroscope: { x: 0, y: 0, z: 0 },
    });
    expect(describeInbound(`${T}/telemetry/imu`, r, "live_only", "{}").level).toBe("debug");
  });

  it("raises events to warn/error", () => {
    const exit = parse("event/geofence", { timestamp: 1, geofence_id: "home", event: "exit" });
    const tamper = parse("event/tamper", { timestamp: 1, detected: true });
    const offline = parse("status/connectivity", { status: "offline" });
    expect(describeInbound("t", exit, "stored", "{}")).toMatchObject({
      level: "warn",
      message: "exit home · saved to history",
    });
    expect(describeInbound("t", tamper, "stored", "{}").level).toBe("error");
    expect(describeInbound("t", offline, "retained", "{}")).toMatchObject({
      level: "warn",
      message: "offline · retained replay: state only",
    });
  });

  it("logs rejections with their issues and the payload that failed", () => {
    const bad = '{"timestamp":1,"percentage":150,"charging":false}';
    const r = parse("telemetry/battery", bad);
    const line = describeInbound(`${T}/telemetry/battery`, r, "rejected", bad);
    expect(line).toMatchObject({
      level: "warn",
      deviceId: "dog001",
      topic: "telemetry/battery",
      message: "rejected: invalid_payload",
      detail: { payload: bad },
    });
    expect(line.detail?.issues).toEqual(expect.arrayContaining([expect.stringMatching(/voltage/)]));
  });
});

describe("rawPayload", () => {
  it("decodes bytes, keeps invalid UTF-8 readable and truncates long payloads", () => {
    expect(rawPayload(new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual({
      bytes: 3,
      payload: "{\uFFFD}",
      truncated: false,
    });
    const long = rawPayload("x".repeat(MAX_LOGGED_PAYLOAD_CHARS + 10));
    expect(long).toMatchObject({ truncated: true, bytes: MAX_LOGGED_PAYLOAD_CHARS + 10 });
    expect(long.payload).toHaveLength(MAX_LOGGED_PAYLOAD_CHARS);
  });
});

describe("PipelineLogger", () => {
  it("numbers lines, stamps them and keeps the most recent", () => {
    let now = 100;
    const logger = new PipelineLogger(() => now, 2);
    logger.system("info", "bridge", "a");
    now = 101;
    logger.system("warn", "demo", "b", { deviceId: "d1" });
    logger.system("info", "bridge", "c");
    expect(logger.recent().map((l) => [l.seq, l.at, l.message])).toEqual([
      [2, 101, "b"],
      [3, 101, "c"],
    ]);
    logger.clear("d1");
    expect(logger.recent().map((l) => l.message)).toEqual(["c"]);
  });
});
