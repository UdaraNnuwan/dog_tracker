import { parseInbound } from "@udara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimDevice, type DeviceOptions, type PublishOptions } from "../src/device.js";

interface Sent {
  path: string;
  payload: Record<string, unknown>;
  opts: PublishOptions;
}

const ID = "sim01";
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
    { publish: (path, payload, o) => sent.push({ path, payload, opts: o }), log: () => {}, random },
  );
  const command = (path: string, body: Record<string, unknown>) => {
    device.handleMessage(
      `pettracker/device/${ID}/${path}`,
      JSON.stringify({ timestamp: 1, ...body }),
    );
    vi.advanceTimersByTime(1);
  };
  const last = (path: string) => sent.filter((s) => s.path === path).at(-1)?.payload;
  return { device, sent, command, last };
}

/** Every published payload must pass the same contract validation as the bridge. */
function expectValid(sent: Sent[]) {
  for (const s of sent) {
    const r = parseInbound(`pettracker/backend/${ID}/${s.path}`, JSON.stringify(s.payload));
    expect(r.ok, `${s.path}: ${JSON.stringify(r)}`).toBe(true);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SimDevice", () => {
  it("announces itself on start with a retained online state (spec §11)", () => {
    const { device, sent } = setup();
    device.start();
    expect(sent[0]).toMatchObject({
      path: "status/connectivity",
      payload: { status: "online" },
      opts: { qos: 1, retain: true },
    });
    expect(sent.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        "status/system",
        "status/network",
        "telemetry/gps",
        "telemetry/battery",
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
    const telemetry = sent.slice(before).filter((s) => s.path.startsWith("telemetry/"));
    expect(telemetry).toHaveLength(4 * 50);
    expect(telemetry.every((s) => s.opts.qos === 0 && !s.opts.retain)).toBe(true);
    expectValid(sent);
    device.stop();
  });

  it("reports battery temperature in a plausible range", () => {
    const { device, sent } = setup({}, Math.random);
    device.start();
    vi.advanceTimersByTime(5_000 * 200);
    const temps = sent
      .filter((s) => s.path === "telemetry/battery")
      .map((s) => s.payload.temperature as number);
    expect(temps.length).toBeGreaterThan(100);
    expect(Math.min(...temps)).toBeGreaterThan(20);
    expect(Math.max(...temps)).toBeLessThan(45);
    device.stop();
  });

  it("stops with a retained offline state", () => {
    const { device, sent } = setup();
    device.start();
    device.stop();
    expect(sent.at(-1)).toMatchObject({
      path: "status/connectivity",
      payload: { status: "offline" },
      opts: { retain: true },
    });
  });

  it("answers location with the current fix", () => {
    const { command, last, sent } = setup();
    command("command/location", { request_id: "r1" });
    expect(last("response/location")).toMatchObject({ request_id: "r1", status: "success" });
    expect(last("response/location")).toHaveProperty("latitude");
    expectValid(sent);
  });

  it("rejects commands with an invalid payload", () => {
    const { command, last } = setup();
    command("command/buzzer", { request_id: "r1", enabled: "yes" });
    expect(last("response/buzzer")).toMatchObject({
      status: "rejected",
      error_code: "invalid_payload",
    });
  });

  it("returns the cached result for a repeated request_id (spec §7.4)", () => {
    let roll = 0.9;
    const { command, sent } = setup({ failRate: 0.5 }, () => roll);
    command("command/buzzer", { request_id: "r1", enabled: true, duration: 3 });
    roll = 0; // would fail now, but a repeat must not re-run the action
    command("command/buzzer", { request_id: "r1", enabled: true, duration: 3 });
    const responses = sent.filter((s) => s.path === "response/buzzer").map((s) => s.payload.status);
    expect(responses).toEqual(["success", "success"]);
  });

  it("can fail and duplicate responses on purpose", () => {
    const { command, sent } = setup({ failRate: 1, duplicateRate: 1 });
    command("command/reboot", { request_id: "r1" });
    vi.advanceTimersByTime(200);
    const responses = sent.filter((s) => s.path === "response/reboot");
    expect(responses).toHaveLength(2);
    expect(responses[0]?.payload).toMatchObject({ status: "failed", error_code: "reboot_failed" });
    expectValid(sent);
  });

  it("applies gps_interval and reschedules telemetry", () => {
    const { device, command, last, sent } = setup();
    device.start();
    command("settings/set/gps_interval", { request_id: "s1", value: 60 });
    expect(last("settings/response/gps_interval")).toMatchObject({ status: "success", value: 60 });
    expect(device.tickMs).toBe(60_000);

    command("settings/get/gps_interval", { request_id: "s2" });
    expect(last("settings/response/gps_interval")).toMatchObject({ request_id: "s2", value: 60 });

    const before = sent.filter((s) => s.path === "telemetry/gps").length;
    vi.advanceTimersByTime(60_000);
    expect(sent.filter((s) => s.path === "telemetry/gps").length - before).toBe(1);
    expectValid(sent);
    device.stop();
  });

  it("fails out-of-range and unsupported settings", () => {
    const { command, last } = setup();
    command("settings/set/gps_interval", { request_id: "s1", value: 5 });
    expect(last("settings/response/gps_interval")).toMatchObject({
      status: "failed",
      error_code: "invalid_range",
    });
    command("settings/set/led_colour", { request_id: "s2", value: "red" });
    expect(last("settings/response/led_colour")).toMatchObject({
      status: "unsupported",
      error_code: "unsupported_setting",
    });
  });

  it("ignores other devices, non-JSON and messages without request_id", () => {
    const { device, sent } = setup();
    device.handleMessage("pettracker/device/sim02/command/reboot", '{"request_id":"r"}');
    device.handleMessage(`pettracker/device/${ID}/command/reboot`, "nope");
    device.handleMessage(`pettracker/device/${ID}/command/reboot`, '{"timestamp":1}');
    vi.advanceTimersByTime(10);
    expect(sent).toEqual([]);
  });

  it("reports geofence exit and low battery as QoS 1 events", () => {
    const { device, sent } = setup({}, Math.random);
    device.start();
    // ~1000 ticks: the dog leaves the 150 m fence and the battery drains below 15 %.
    vi.advanceTimersByTime(5_000 * 1000);
    const events = sent.filter((s) => s.path.startsWith("event/"));
    expect(events.some((e) => e.path === "event/geofence" && e.payload.event === "exit")).toBe(
      true,
    );
    expect(events.some((e) => e.path === "event/low_battery")).toBe(true);
    expect(events.every((e) => e.opts.qos === 1)).toBe(true);
    expectValid(sent);
    device.stop();
  });
});
