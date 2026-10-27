import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  COMMAND_NAMES,
  SETTING_NAMES,
  SPEC_EXAMPLES,
  buildCommand,
  buildSettingsGet,
  buildSettingsSet,
  isPublishableDeviceTopic,
  schemas,
  type SettingName,
} from "../src/index.js";

const meta = { requestId: "0d9b1f0e-6f3c-4c55-9a43-2f1c3e1f9a10", timestamp: 1717330000 };
const envelope = { timestamp: meta.timestamp, request_id: meta.requestId };

describe("spec examples (backend → collar)", () => {
  const published = SPEC_EXAMPLES.filter(
    (e) => e.direction === "device" && !e.path.startsWith("settings/ack/"),
  );

  it.each(published.map((e) => [`§${e.section} ${e.path}`, e] as const))("validates %s", (_, e) => {
    const [kind, a, b] = e.path.split("/");
    const schema =
      kind === "command"
        ? COMMANDS[a as keyof typeof COMMANDS]
        : a === "set"
          ? schemas.settingsSet(b as SettingName)
          : schemas.settingsGet(b as SettingName);
    const r = schema.safeParse(e.payload);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it("covers every command and settings group", () => {
    const covered = new Set(published.map((e) => e.path));
    expect(COMMAND_NAMES.filter((c) => !covered.has(`command/${c}`))).toEqual([]);
    for (const s of SETTING_NAMES) {
      expect(covered.has(`settings/set/${s}`), s).toBe(true);
      expect(covered.has(`settings/get/${s}`), s).toBe(true);
    }
  });
});

describe("buildCommand", () => {
  it("builds topic and payload with the envelope", () => {
    const r = buildCommand("dog001", "buzzer", { enabled: true, duration_ms: 1500 }, meta);
    expect(r).toEqual({
      ok: true,
      value: {
        topic: "pettracker/dog001/device/command/buzzer",
        payload: { ...envelope, enabled: true, duration_ms: 1500 },
        requestId: meta.requestId,
      },
    });
    if (r.ok) expect(isPublishableDeviceTopic(r.value.topic)).toBe(true);
  });

  it("fills the fixed actions the spec requires", () => {
    expect(buildCommand("dog001", "location", {}, meta)).toMatchObject({
      ok: true,
      value: { payload: { ...envelope, action: "get_current_location" } },
    });
    expect(buildCommand("dog001", "sleep", { duration_seconds: 600 }, meta)).toMatchObject({
      ok: true,
      value: { payload: { action: "enter_sleep", duration_seconds: 600 } },
    });
    expect(buildCommand("dog001", "reboot", {}, meta)).toMatchObject({
      ok: true,
      value: { payload: { reboot_enable: true } },
    });
  });

  it.each(COMMAND_NAMES)("produces a publishable topic for %s", (name) => {
    const params: Record<string, object> = {
      config: { config: { tracking_enabled: true } },
      buzzer: { enabled: false, duration_ms: 1 },
      peripheral: { peripheral: "speaker", enabled: true },
      sleep: { duration_seconds: 60 },
    };
    const r = buildCommand("dog001", name, params[name] ?? {}, meta);
    expect(r.ok && isPublishableDeviceTopic(r.value.topic)).toBe(true);
  });

  it("never lets params override the envelope", () => {
    const sneaky = { request_id: "attacker", timestamp: 0 } as unknown as Record<string, never>;
    const r = buildCommand("dog001", "reboot", sneaky, meta);
    expect(r).toMatchObject({ ok: true, value: { payload: envelope } });
  });

  it("rejects invalid params", () => {
    const r = buildCommand("dog001", "buzzer", { enabled: "yes", duration_ms: 0 } as never, meta);
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
  const settingsEnvelope = { timestamp: meta.timestamp, setting_id: meta.requestId };

  it("builds settings/set with typed values (spec V3 §6, ADR 0011)", () => {
    expect(
      buildSettingsSet("dog001", "gps_settings", { gps_interval: "60", gps_enabled: "true" }, meta),
    ).toEqual({
      ok: true,
      value: {
        topic: "pettracker/dog001/device/settings/set/gps_settings",
        payload: {
          ...settingsEnvelope,
          action: "set",
          setting_type: "gps",
          gps_interval: 60,
          gps_enabled: true,
        },
        requestId: meta.requestId,
      },
    });
  });

  it.each([
    ["gps_settings", { gps_interval: 0 }],
    ["gps_settings", { gps_interval: 45.5 }],
    ["gps_settings", { gps_interval: "abc" }],
    ["gps_settings", { gps_enabled: "yes" }],
    ["device_settings", { audio_volume: 101 }],
    ["device_settings", { display_rotation: 1 }],
    ["profile_settings", { owner_qr: "x" }],
  ])("refuses %s %j before publishing (rule 8)", (setting, fields) => {
    expect(buildSettingsSet("dog001", setting, fields, meta)).toMatchObject({
      ok: false,
      reason: "invalid_payload",
    });
  });

  it("refuses a SET without any field of the group", () => {
    expect(buildSettingsSet("dog001", "gps_settings", { other: 1 }, meta)).toMatchObject({
      ok: false,
      reason: "invalid_payload",
    });
  });

  it("never lets fields override the envelope", () => {
    const r = buildSettingsSet(
      "dog001",
      "gps_settings",
      { gps_interval: 60, setting_id: "x", action: "get", setting_type: "power" },
      meta,
    );
    expect(r).toMatchObject({
      ok: true,
      value: { payload: { ...settingsEnvelope, action: "set", setting_type: "gps" } },
    });
  });

  it("refuses settings outside the registry", () => {
    expect(buildSettingsSet("dog001", "gps_interval", { value: 60 }, meta)).toMatchObject({
      ok: false,
      reason: "unknown_setting",
    });
    expect(buildSettingsGet("dog001", "led_colour", meta)).toMatchObject({
      ok: false,
      reason: "unknown_setting",
    });
  });

  it("builds settings/get", () => {
    expect(buildSettingsGet("dog001", "power_settings", meta)).toEqual({
      ok: true,
      value: {
        topic: "pettracker/dog001/device/settings/get/power_settings",
        payload: { ...settingsEnvelope, action: "get", setting_type: "power" },
        requestId: meta.requestId,
      },
    });
  });
});
