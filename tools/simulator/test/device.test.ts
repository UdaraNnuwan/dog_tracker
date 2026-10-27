import { parseInbound } from "@udara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimDevice, type DeviceOptions, type PublishOptions } from "../src/device.js";

interface Sent {
  /** Topic after `pettracker/{id}/`, e.g. `backend/telemetry/gps`. */
  path: string;
  payload: Record<string, unknown>;
  opts: PublishOptions;
}

const ID = "sim01";
const PREFIX = `pettracker/${ID}/`;
const base: DeviceOptions = {
  deviceId: ID,
  home: { latitude: 6.9271, longitude: 79.8612 },
  intervalS: 5,
  failRate: 0,
  duplicateRate: 0,
  responseDelayMs: { min: 0, max: 0 },
};

function setup(opts: Partial<DeviceOptions> = {}, random = () => 0.5) {
  const sent: Sent[] = [];
  const device = new SimDevice(
    { ...base, ...opts },
    {
      publish: (topic, payload, o) => {
        expect(topic.startsWith(PREFIX)).toBe(true);
        sent.push({ path: topic.slice(PREFIX.length), payload, opts: o });
      },
      log: () => {},
      random,
    },
  );
  const send = (path: string, body: Record<string, unknown>) => {
    device.handleMessage(`${PREFIX}device/${path}`, JSON.stringify({ timestamp: 1, ...body }));
    vi.advanceTimersByTime(1);
  };
  const last = (path: string) => sent.filter((s) => s.path === path).at(-1)?.payload;
  return { device, sent, send, last };
}

/** Every published payload must pass the same contract validation as the bridge. */
function expectValid(sent: Sent[]) {
  for (const s of sent) {
    const r = parseInbound(`${PREFIX}${s.path}`, JSON.stringify(s.payload));
    expect(r.ok, `${s.path}: ${JSON.stringify(r)}`).toBe(true);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SimDevice", () => {
  it("announces itself on start with a retained online state (ADR 0011)", () => {
    const { device, sent } = setup();
    device.start();
    expect(sent[0]).toMatchObject({
      path: "backend/status/connectivity",
      payload: { status: "online" },
      opts: { qos: 1, retain: true },
    });
    expect(sent.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        "backend/status/system",
        "backend/status/network",
        "backend/telemetry/gps",
        "backend/telemetry/battery",
        "backend/telemetry/bme_data",
      ]),
    );
    expectValid(sent);
    device.stop();
  });

  it("publishes valid telemetry every interval with QoS 0, no retain", () => {
    const { device, sent } = setup({}, Math.random);
    device.start();
    const before = sent.length;
    vi.advanceTimersByTime(5_000 * 50);
    const telemetry = sent.slice(before).filter((s) => s.path.startsWith("backend/telemetry/"));
    expect(telemetry).toHaveLength(5 * 50);
    expect(telemetry.every((s) => s.opts.qos === 0 && !s.opts.retain)).toBe(true);
    expectValid(sent);
    device.stop();
  });

  it("stops with a retained offline state", () => {
    const { device, sent } = setup();
    device.start();
    device.stop();
    expect(sent.at(-1)).toMatchObject({
      path: "backend/status/connectivity",
      payload: { status: "offline" },
      opts: { retain: true },
    });
  });

  it("answers location with the current fix", () => {
    const { send, last, sent } = setup();
    send("command/location", { request_id: "r1", action: "get_current_location" });
    expect(last("backend/response/location")).toMatchObject({
      request_id: "r1",
      status: "success",
      location: { fix_valid: true },
    });
    expectValid(sent);
  });

  it("echoes buzzer, peripheral and sleep parameters", () => {
    const { send, last, sent } = setup();
    send("command/buzzer", { request_id: "b", enabled: true, duration_ms: 1500 });
    send("command/peripheral", { request_id: "p", peripheral: "speaker", enabled: false });
    send("command/sleep", { request_id: "s", action: "enter_sleep", duration_seconds: 600 });
    expect(last("backend/response/buzzer")).toMatchObject({ enabled: true, duration_ms: 1500 });
    expect(last("backend/response/peripheral")).toMatchObject({ peripheral: "speaker" });
    expect(last("backend/response/sleep")).toMatchObject({ duration_seconds: 600 });
    expect(last("backend/status/system")).toMatchObject({ device_state: "sleep" });
    expectValid(sent);
  });

  it("answers invalid commands with an error", () => {
    const { send, last } = setup();
    send("command/buzzer", { request_id: "r1", enabled: "yes" });
    expect(last("backend/response/buzzer")).toMatchObject({ status: "error" });
    send("command/reboot", { request_id: "r2", reboot_enable: "yes" });
    expect(last("backend/response/reboot")).toMatchObject({ status: "rejected" });
  });

  it("returns the cached result for a repeated request_id", () => {
    let roll = 0.9;
    const { send, sent } = setup({ failRate: 0.5 }, () => roll);
    send("command/buzzer", { request_id: "r1", enabled: true, duration_ms: 3000 });
    roll = 0; // would fail now, but a repeat must not re-run the action
    send("command/buzzer", { request_id: "r1", enabled: true, duration_ms: 3000 });
    const statuses = sent
      .filter((s) => s.path === "backend/response/buzzer")
      .map((s) => s.payload.status);
    expect(statuses).toEqual(["success", "success"]);
  });

  it("can fail and duplicate responses on purpose", () => {
    const { send, sent } = setup({ failRate: 1, duplicateRate: 1 });
    send("command/reboot", { request_id: "r1", reboot_enable: true });
    vi.advanceTimersByTime(200);
    const responses = sent.filter((s) => s.path === "backend/response/reboot");
    expect(responses).toHaveLength(2);
    expect(responses[0]?.payload).toMatchObject({ status: "rejected" });
    expectValid(sent);
  });

  it("acknowledges a SET on device/settings/ack and reschedules telemetry", () => {
    const { device, send, last, sent } = setup();
    device.start();
    send("settings/set/gps_settings", {
      action: "set",
      setting_id: "s1",
      setting_type: "gps",
      gps_interval: "60",
    });
    expect(last("device/settings/ack/gps_settings")).toMatchObject({
      action: "ack",
      setting_id: "s1",
      setting_type: "gps",
    });
    expect(device.tickMs).toBe(60_000);

    send("settings/get/gps_settings", { action: "get", setting_id: "s2", setting_type: "gps" });
    expect(last("backend/settings/response/gps_settings")).toMatchObject({
      action: "get_response",
      setting_id: "s2",
      gps_interval: 60,
      gps_enabled: true,
    });

    const gps = () => sent.filter((s) => s.path === "backend/telemetry/gps").length;
    const before = gps();
    vi.advanceTimersByTime(60_000);
    expect(gps() - before).toBe(1);
    expectValid(sent);
    device.stop();
  });

  it("does not acknowledge an invalid SET or an unknown group", () => {
    const { send, sent } = setup();
    send("settings/set/gps_settings", {
      action: "set",
      setting_id: "s1",
      setting_type: "gps",
      gps_interval: 0,
    });
    send("settings/set/led_colour", { action: "set", setting_id: "s2", value: "red" });
    expect(sent).toEqual([]);
  });

  it("ignores other devices, its own ACKs, non-JSON and messages without an id", () => {
    const { device, sent } = setup();
    device.handleMessage("pettracker/sim02/device/command/reboot", '{"request_id":"r"}');
    device.handleMessage(`${PREFIX}device/settings/ack/gps_settings`, '{"setting_id":"s"}');
    device.handleMessage(`${PREFIX}device/command/reboot`, "nope");
    device.handleMessage(`${PREFIX}device/command/reboot`, '{"timestamp":1}');
    device.handleMessage(`${PREFIX}device/settings/get/gps_settings`, '{"request_id":"r"}');
    vi.advanceTimersByTime(10);
    expect(sent).toEqual([]);
  });

  it("reports geofence exit and low battery as QoS 1 events", () => {
    const { device, sent } = setup({}, Math.random);
    device.start();
    // ~1000 ticks: the dog leaves the 150 m fence and the battery drains below 15 %.
    vi.advanceTimersByTime(5_000 * 1000);
    const events = sent.filter((s) => s.path.startsWith("backend/event/"));
    expect(
      events.some((e) => e.path === "backend/event/geofence" && e.payload.out_status === true),
    ).toBe(true);
    expect(events.some((e) => e.path === "backend/event/low_battery")).toBe(true);
    expect(events.every((e) => e.opts.qos === 1)).toBe(true);
    expectValid(sent);
    device.stop();
  });
});
