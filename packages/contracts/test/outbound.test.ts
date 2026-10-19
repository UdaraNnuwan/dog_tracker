import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  COMMAND_NAMES,
  PROTOCOL_VERSION,
  SPEC_EXAMPLES,
  buildCommand,
  buildSettingsGet,
  buildSettingsSet,
  isPublishableDeviceTopic,
  schemas,
} from "../src/index.js";

const meta = { requestId: "0d9b1f0e-6f3c-4c55-9a43-2f1c3e1f9a10", timestamp: 1717330000 };
const envelope = {
  timestamp: meta.timestamp,
  request_id: meta.requestId,
  protocol_version: PROTOCOL_VERSION,
};

describe("spec examples (backend → device)", () => {
  const device = SPEC_EXAMPLES.filter((e) => e.direction === "device");

  it.each(device.map((e) => [`§${e.section} ${e.path}`, e] as const))("validates %s", (_, e) => {
    const [kind, a, b] = e.path.split("/");
    const schema =
      kind === "command"
        ? COMMANDS[a as keyof typeof COMMANDS]
        : a === "set"
          ? schemas.settingsSet(b as "gps_interval")
          : schemas.settingsGet;
    expect(schema.safeParse(e.payload).success).toBe(true);
  });

  it("covers every command", () => {
    const covered = new Set(device.map((e) => e.path));
    expect(COMMAND_NAMES.filter((c) => !covered.has(`command/${c}`))).toEqual([]);
  });
});

describe("buildCommand", () => {
  it("builds topic and payload with the envelope", () => {
    const r = buildCommand("dog001", "buzzer", { enabled: true, duration: 5 }, meta);
    expect(r).toEqual({
      ok: true,
      value: {
        topic: "pettracker/device/dog001/command/buzzer",
        payload: { ...envelope, enabled: true, duration: 5 },
        requestId: meta.requestId,
      },
    });
    if (r.ok) expect(isPublishableDeviceTopic(r.value.topic)).toBe(true);
  });

  it.each(COMMAND_NAMES)("produces a publishable topic for %s", (name) => {
    const params = {
      buzzer: { enabled: false, duration: 0 },
      peripheral: { peripheral: "gps", enabled: true },
      sleep: { mode: "deep" },
    } as const;
    const r = buildCommand("dog001", name, (params as Record<string, object>)[name] ?? {}, meta);
    expect(r.ok && isPublishableDeviceTopic(r.value.topic)).toBe(true);
  });

  it("never lets params override the envelope", () => {
    const sneaky = { request_id: "attacker", timestamp: 0 } as unknown as Record<string, never>;
    const r = buildCommand("dog001", "reboot", sneaky, meta);
    expect(r).toMatchObject({ ok: true, value: { payload: envelope } });
  });

  it("rejects invalid params", () => {
    const r = buildCommand("dog001", "buzzer", { enabled: "yes", duration: -1 } as never, meta);
    expect(r).toMatchObject({ ok: false, reason: "invalid_payload", path: "command/buzzer" });
    if (!r.ok) expect(r.issues).toHaveLength(2);
  });

  it.each(["Dog001", "dog 001", "+", "#", ""])("rejects device id %j", (id) => {
    expect(buildCommand(id, "reboot", {}, meta)).toMatchObject({
      ok: false,
      reason: "invalid_device_id",
    });
  });
});

describe("settings builders", () => {
  it("builds settings/set within range (spec §8.1)", () => {
    expect(buildSettingsSet("dog001", "gps_interval", 45, meta)).toEqual({
      ok: true,
      value: {
        topic: "pettracker/device/dog001/settings/set/gps_interval",
        payload: { ...envelope, value: 45 },
        requestId: meta.requestId,
      },
    });
  });

  it.each([9, 86_401, 45.5, "45", null])(
    "refuses gps_interval %j before publishing (rule 8)",
    (value) => {
      expect(buildSettingsSet("dog001", "gps_interval", value, meta)).toMatchObject({
        ok: false,
        reason: "invalid_payload",
      });
    },
  );

  it("refuses settings outside the registry", () => {
    expect(buildSettingsSet("dog001", "led_colour", "red", meta)).toMatchObject({
      ok: false,
      reason: "unknown_setting",
    });
    expect(buildSettingsGet("dog001", "led_colour", meta)).toMatchObject({
      ok: false,
      reason: "unknown_setting",
    });
  });

  it("builds settings/get", () => {
    expect(buildSettingsGet("dog001", "gps_interval", meta)).toMatchObject({
      ok: true,
      value: { topic: "pettracker/device/dog001/settings/get/gps_interval", payload: envelope },
    });
  });
});
