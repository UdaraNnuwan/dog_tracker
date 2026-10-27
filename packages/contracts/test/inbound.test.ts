import { describe, expect, it } from "vitest";
import {
  INBOUND_TOPICS,
  MAX_INBOUND_PAYLOAD_BYTES,
  SETTING_NAMES,
  SPEC_EXAMPLES,
  parseBackendTopic,
  parseInbound,
} from "../src/index.js";

const T = "pettracker/dog001/backend";
const parse = (path: string, payload: unknown) =>
  parseInbound(`${T}/${path}`, JSON.stringify(payload));

describe("parseBackendTopic", () => {
  it.each(Object.keys(INBOUND_TOPICS))("knows %s", (path) => {
    expect(parseBackendTopic(`${T}/${path}`)).toEqual({
      ok: true,
      value: { deviceId: "dog001", path },
    });
  });

  it.each(SETTING_NAMES)("parses settings response and ACK topics of %s", (setting) => {
    expect(parseBackendTopic(`${T}/settings/response/${setting}`)).toEqual({
      ok: true,
      value: { deviceId: "dog001", path: "settings/response", setting },
    });
    expect(parseBackendTopic(`pettracker/dog001/device/settings/ack/${setting}`)).toEqual({
      ok: true,
      value: { deviceId: "dog001", path: "settings/ack", setting },
    });
  });

  it.each([
    ["pettracker/dog001/device/command/reboot", "outside_namespace"],
    ["pettracker/dog001/device/settings/set/gps_settings", "outside_namespace"],
    ["pettracker/backend/dog001/telemetry/gps", "outside_namespace"],
    ["other/dog001/backend/telemetry/gps", "outside_namespace"],
    ["pettracker/Dog001/backend/telemetry/gps", "invalid_device_id"],
    ["pettracker/dog001/backend", "unknown_topic"],
    ["pettracker/dog001/backend/telemetry", "unknown_topic"],
    ["pettracker/dog001/backend/telemetry/gps/extra", "unknown_topic"],
    ["pettracker/dog001/backend/event/tamper", "unknown_topic"],
    ["pettracker/dog001/backend/diagnostic/crash", "unknown_topic"],
    ["pettracker/dog001/backend/settings/response/gps_interval", "unknown_setting"],
    ["pettracker/dog001/device/settings/ack/led_colour", "unknown_setting"],
    // ACKs come on the device publisher only.
    ["pettracker/dog001/backend/settings/ack/gps_settings", "unknown_topic"],
  ])("rejects %s as %s", (topic, reason) => {
    expect(parseBackendTopic(topic)).toMatchObject({ ok: false, reason });
  });
});

describe("parseInbound: spec examples", () => {
  const inbound = SPEC_EXAMPLES.filter(
    (e) => e.direction === "backend" || e.path.startsWith("settings/ack/"),
  );

  it.each(inbound.map((e) => [`§${e.section} ${e.path}`, e] as const))("accepts %s", (_, e) => {
    const r = parseInbound(`pettracker/dog001/${e.direction}/${e.path}`, JSON.stringify(e.payload));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("has an example for every topic", () => {
    const covered = new Set(inbound.map((e) => e.path));
    const all = [
      ...Object.keys(INBOUND_TOPICS),
      ...SETTING_NAMES.flatMap((s) => [`settings/response/${s}`, `settings/ack/${s}`]),
    ];
    expect(all.filter((p) => !covered.has(p))).toEqual([]);
  });

  it("reads the spec's settings quirks: padded/capitalised keys, string values", () => {
    const r = parse("settings/response/gps_settings", {
      timestamp: 1717330000,
      action: "get_response",
      setting_id: "set_1003",
      setting_type: "gps",
      "gps_interval ": "60",
      "gps_enabled ": "true",
    });
    expect(r).toMatchObject({ ok: true, value: { data: { gps_interval: 60, gps_enabled: true } } });

    const device = parse("settings/response/device_settings", {
      timestamp: 1717330000,
      action: "set",
      setting_id: "set_1004",
      setting_type: "device",
      Display_inverted: "false",
    });
    expect(device).toMatchObject({ ok: true, value: { data: { display_inverted: false } } });
  });
});

describe("parseInbound: payload rules", () => {
  const gps = { timestamp: 1717330000, latitude: 6.9271, longitude: 79.8612, speed: 1.2 };

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

  it("ignores unknown fields", () => {
    const r = parse("telemetry/gps", { ...gps, altitude: 12, future: { x: 1 } });
    expect(r).toMatchObject({ ok: true, value: { data: gps } });
  });

  it("accepts the Last Will offline message without a timestamp (ADR 0011)", () => {
    expect(parse("status/connectivity", { status: "offline" }).ok).toBe(true);
  });

  it("accepts an error response without the success fields", () => {
    expect(parse("response/location", { timestamp: 1, request_id: "r", status: "error" }).ok).toBe(
      true,
    );
    expect(parse("response/buzzer", { timestamp: 1, request_id: "r", status: "error" }).ok).toBe(
      true,
    );
  });

  it.each([
    ["epoch milliseconds", "telemetry/gps", { ...gps, timestamp: 1717330000000 }, "timestamp"],
    ["fractional timestamp", "telemetry/gps", { ...gps, timestamp: 1717330000.5 }, "timestamp"],
    ["timestamp as string", "telemetry/gps", { ...gps, timestamp: "1717330000" }, "timestamp"],
    ["missing timestamp", "telemetry/gps", { latitude: 1, longitude: 1, speed: 0 }, "timestamp"],
    ["missing speed", "telemetry/gps", { timestamp: 1, latitude: 1, longitude: 1 }, "speed"],
    ["latitude out of range", "telemetry/gps", { ...gps, latitude: 91 }, "latitude"],
    ["longitude out of range", "telemetry/gps", { ...gps, longitude: -181 }, "longitude"],
    ["negative speed", "telemetry/gps", { ...gps, speed: -1 }, "speed"],
    [
      "numeric string in telemetry",
      "telemetry/battery",
      { timestamp: 1, voltage: 3.9, percentage: "82", charging: false },
      "percentage",
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
      { timestamp: 1, acceleration: { x: 0, y: 0 }, gyroscope: { x: 0, y: 0, z: 0 } },
      "acceleration.z",
    ],
    [
      "signal limits reversed",
      "telemetry/signal_strength",
      { timestamp: 1, strength_lower_limit: 80, strength_upper_limit: 50 },
      "strength_lower_limit",
    ],
    [
      "humidity > 100",
      "telemetry/bme_data",
      { timestamp: 1, temperature: 30, pressure: 1000, humidity: 101 },
      "humidity",
    ],
    [
      "firmware version not SemVer",
      "status/system",
      { timestamp: 1, firmware_version: "v1", uptime_seconds: 1, device_state: "active" },
      "firmware_version",
    ],
    [
      "unknown device state",
      "status/system",
      { timestamp: 1, firmware_version: "1.0.0", uptime_seconds: 1, device_state: "off" },
      "device_state",
    ],
    [
      "bad ip address",
      "status/network",
      { timestamp: 1, connection: "lte", registration: "registered", ip_address: "10.0.0" },
      "ip_address",
    ],
    [
      "unknown connection",
      "status/network",
      { timestamp: 1, connection: "5g", registration: "registered", ip_address: "10.0.0.1" },
      "connection",
    ],
    [
      "unknown connectivity state",
      "status/connectivity",
      { timestamp: 1, status: "sleeping" },
      "status",
    ],
    ["geofence flag missing", "event/geofence", { timestamp: 1, in_status: true }, "out_status"],
    [
      "low battery without threshold",
      "event/low_battery",
      { timestamp: 1, percentage: 14, voltage: 3.5 },
      "threshold_percentage",
    ],
    [
      "response without request_id",
      "response/peripheral",
      { timestamp: 1, status: "error" },
      "request_id",
    ],
    [
      "reboot status from the other enum",
      "response/reboot",
      { timestamp: 1, request_id: "r", status: "success" },
      "status",
    ],
    [
      "location success without fix",
      "response/location",
      { timestamp: 1, request_id: "r", status: "success" },
      "location",
    ],
    [
      "settings value out of range",
      "settings/response/device_settings",
      {
        timestamp: 1,
        action: "get_response",
        setting_id: "s",
        setting_type: "device",
        audio_volume: 0,
      },
      "audio_volume",
    ],
    [
      "settings response of another group",
      "settings/response/gps_settings",
      { timestamp: 1, action: "get_response", setting_id: "s", setting_type: "power" },
      "setting_type",
    ],
    [
      "profile without pet_name",
      "settings/response/profile_settings",
      { timestamp: 1, action: "get_response", setting_id: "s", setting_type: "profile" },
      "pet_name",
    ],
    [
      "debug level",
      "diagnostic/debug_log",
      { timestamp: 1, level: "trace", module: "gps", message: "x" },
      "level",
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
    expect(parseInbound(`${T}/nope`, "not json")).toMatchObject({
      ok: false,
      reason: "unknown_topic",
      path: "nope",
    });
  });
});
