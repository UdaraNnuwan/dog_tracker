import { describe, expect, it } from "vitest";
import {
  INBOUND_TOPICS,
  MAX_INBOUND_PAYLOAD_BYTES,
  SPEC_EXAMPLES,
  parseBackendTopic,
  parseInbound,
} from "../src/index.js";

const T = "pettracker/backend/dog001";
const parse = (path: string, payload: unknown) =>
  parseInbound(`${T}/${path}`, JSON.stringify(payload));

describe("parseBackendTopic", () => {
  it.each(Object.keys(INBOUND_TOPICS))("knows %s", (path) => {
    expect(parseBackendTopic(`${T}/${path}`)).toEqual({
      ok: true,
      value: { deviceId: "dog001", path },
    });
  });

  it("parses settings responses with the setting name", () => {
    expect(parseBackendTopic(`${T}/settings/response/gps_interval`)).toEqual({
      ok: true,
      value: { deviceId: "dog001", path: "settings/response", setting: "gps_interval" },
    });
  });

  it.each([
    ["pettracker/device/dog001/command/reboot", "outside_namespace"],
    ["other/backend/dog001/telemetry/gps", "outside_namespace"],
    ["pettracker/backend/Dog001/telemetry/gps", "invalid_device_id"],
    ["pettracker/backend/dog001", "unknown_topic"],
    ["pettracker/backend/dog001/telemetry", "unknown_topic"],
    ["pettracker/backend/dog001/telemetry/gps/extra", "unknown_topic"],
    ["pettracker/backend/dog001/telemetry/temperature", "unknown_topic"],
    ["pettracker/backend/dog001/status/firmware_update", "unknown_topic"],
    ["pettracker/backend/dog001/settings/response/led_colour", "unknown_setting"],
  ])("rejects %s as %s", (topic, reason) => {
    expect(parseBackendTopic(topic)).toMatchObject({ ok: false, reason });
  });
});

describe("parseInbound: spec examples", () => {
  const backend = SPEC_EXAMPLES.filter((e) => e.direction === "backend");

  it.each(backend.map((e) => [`§${e.section} ${e.path}`, e] as const))("accepts %s", (_, e) => {
    const r = parse(e.path, e.payload);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value.data).toEqual(e.payload);
  });

  it("has an example for every topic whose payload the spec defines", () => {
    // The spec gives no payload for these; their schemas are the shared envelope only.
    const undefinedInSpec = new Set([
      "response/buzzer",
      "response/peripheral",
      "response/sleep",
      "diagnostic/crash",
      "diagnostic/debug_log",
      "diagnostic/sensor_health",
    ]);
    const covered = new Set(backend.map((e) => e.path));
    const missing = Object.keys(INBOUND_TOPICS).filter(
      (p) => !covered.has(p) && !undefinedInSpec.has(p),
    );
    expect(missing).toEqual([]);
  });
});

describe("parseInbound: payload rules", () => {
  const gps = { timestamp: 1717330000, latitude: 6.9271, longitude: 79.8612 };

  it("returns the typed message", () => {
    const r = parse("telemetry/battery", {
      timestamp: 1,
      voltage: 3.9,
      percentage: 80,
      charging: true,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        deviceId: "dog001",
        path: "telemetry/battery",
        data: { timestamp: 1, voltage: 3.9, percentage: 80, charging: true },
      },
    });
  });

  it("accepts bytes as well as strings", () => {
    const r = parseInbound(`${T}/telemetry/gps`, new TextEncoder().encode(JSON.stringify(gps)));
    expect(r.ok).toBe(true);
  });

  it("ignores unknown fields (spec §15)", () => {
    const r = parse("telemetry/gps", { ...gps, altitude: 12, future: { x: 1 } });
    expect(r).toMatchObject({ ok: true, value: { data: gps } });
  });

  it("keeps every field of payloads the spec does not define", () => {
    const crash = { timestamp: 1, reset_reason: "watchdog", pc: "0x0800abcd" };
    expect(parse("diagnostic/crash", crash)).toMatchObject({ ok: true, value: { data: crash } });
  });

  it("accepts the Last Will offline message without a timestamp (spec §11)", () => {
    expect(parse("status/connectivity", { status: "offline" }).ok).toBe(true);
  });

  it.each([
    ["epoch milliseconds", "telemetry/gps", { ...gps, timestamp: 1717330000000 }, "timestamp"],
    ["fractional timestamp", "telemetry/gps", { ...gps, timestamp: 1717330000.5 }, "timestamp"],
    ["timestamp as string", "telemetry/gps", { ...gps, timestamp: "1717330000" }, "timestamp"],
    ["missing timestamp", "telemetry/gps", { latitude: 1, longitude: 1 }, "timestamp"],
    ["latitude out of range", "telemetry/gps", { ...gps, latitude: 91 }, "latitude"],
    ["longitude out of range", "telemetry/gps", { ...gps, longitude: -181 }, "longitude"],
    ["negative speed", "telemetry/gps", { ...gps, speed: -1 }, "speed"],
    [
      "numeric string (spec §3)",
      "telemetry/battery",
      { timestamp: 1, voltage: 3.9, percentage: "82", charging: false },
      "percentage",
    ],
    [
      "boolean as string",
      "telemetry/battery",
      { timestamp: 1, voltage: 3.9, percentage: 82, charging: "false" },
      "charging",
    ],
    [
      "percentage > 100",
      "telemetry/battery",
      { timestamp: 1, voltage: 3.9, percentage: 101, charging: false },
      "percentage",
    ],
    [
      "imu axis missing",
      "telemetry/imu",
      { timestamp: 1, accelerometer: { x: 0, y: 0 }, gyroscope: { x: 0, y: 0, z: 0 } },
      "accelerometer.z",
    ],
    [
      "unknown connectivity state",
      "status/connectivity",
      { timestamp: 1, status: "sleeping" },
      "status",
    ],
    [
      "geofence event value",
      "event/geofence",
      { timestamp: 1, geofence_id: "home", event: "left" },
      "event",
    ],
    [
      "response without request_id",
      "response/reboot",
      { timestamp: 1, status: "success" },
      "request_id",
    ],
    [
      "unknown response status",
      "response/reboot",
      { timestamp: 1, request_id: "r", status: "ok" },
      "status",
    ],
    [
      "location success without fix",
      "response/location",
      { timestamp: 1, request_id: "r", status: "success" },
      "latitude",
    ],
    [
      "settings value out of range",
      "settings/response/gps_interval",
      { timestamp: 1, request_id: "r", status: "success", value: 5 },
      "value",
    ],
    [
      "settings success without value",
      "settings/response/gps_interval",
      { timestamp: 1, request_id: "r", status: "success" },
      "value",
    ],
  ])("rejects %s", (_, path, payload, field) => {
    const r = parse(path, payload);
    expect(r).toMatchObject({ ok: false, reason: "invalid_payload", deviceId: "dog001" });
    if (!r.ok)
      expect(
        r.issues.some((i) => i.startsWith(`${field}:`)),
        r.issues.join("\n"),
      ).toBe(true);
  });

  it("accepts a failed location response without a fix", () => {
    const r = parse("response/location", {
      timestamp: 1,
      request_id: "r",
      status: "failed",
      error_code: "no_fix",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a failed settings response echoing the rejected value", () => {
    const r = parse("settings/response/gps_interval", {
      timestamp: 1,
      request_id: "r",
      status: "failed",
      error_code: "invalid_range",
      value: 5,
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ["not json", "invalid_json"],
    ["", "invalid_json"],
    ["[1,2]", "invalid_payload"],
    ["null", "invalid_payload"],
  ])("rejects body %j as %s", (body, reason) => {
    expect(parseInbound(`${T}/telemetry/gps`, body)).toMatchObject({
      ok: false,
      reason,
      path: "telemetry/gps",
    });
  });

  it("rejects invalid UTF-8", () => {
    const r = parseInbound(`${T}/telemetry/gps`, new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(r).toMatchObject({ ok: false, reason: "invalid_json" });
  });

  it("rejects oversized payloads before parsing", () => {
    const body = JSON.stringify({ ...gps, pad: "x".repeat(MAX_INBOUND_PAYLOAD_BYTES) });
    expect(parseInbound(`${T}/telemetry/gps`, body)).toMatchObject({
      ok: false,
      reason: "payload_too_large",
    });
  });

  it("reports topic problems before payload problems", () => {
    expect(parseInbound("pettracker/backend/dog001/nope", "not json")).toMatchObject({
      ok: false,
      reason: "unknown_topic",
      path: "nope",
    });
  });
});
