import { topicDocs } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { schemaVariants } from "../src/topics/fields.js";
import {
  answerPath,
  editableFields,
  initialValues,
  previewPayload,
  toFields,
} from "../src/topics/sendForm.js";

const fieldsOf = (path: string) =>
  schemaVariants(topicDocs().find((d) => d.direction === "device" && d.path === path)!.schema)[0]!
    .fields;

describe("send form", () => {
  it("leaves the envelope to the backend", () => {
    expect(editableFields(fieldsOf("command/buzzer")).map((f) => f.name)).toEqual([
      "enabled",
      "duration_ms",
      "volume_percent",
    ]);
    expect(editableFields(fieldsOf("command/location"))).toEqual([]);
    expect(editableFields(fieldsOf("settings/get/gps_settings"))).toEqual([]);
    expect(editableFields(fieldsOf("settings/set/gps_settings")).map((f) => f.name)).toEqual([
      "gps_interval",
      "gps_enabled",
    ]);
  });

  it("converts values and reports missing or malformed ones", () => {
    const buzzer = fieldsOf("command/buzzer");
    expect(initialValues(buzzer)).toEqual({ enabled: false, duration_ms: "", volume_percent: "" });
    expect(toFields(buzzer, { enabled: true, duration_ms: "1500", volume_percent: "" })).toEqual({
      fields: { enabled: true, duration_ms: 1500 },
      errors: {},
    });
    expect(toFields(buzzer, { enabled: false, duration_ms: "" }).errors).toEqual({
      duration_ms: "required",
    });
    const set = fieldsOf("settings/set/gps_settings");
    expect(toFields(set, { gps_interval: "4.5" }).errors).toEqual({ gps_interval: "whole number" });
    // An unticked optional switch is not sent: a SET only changes what was filled in.
    expect(toFields(set, { gps_interval: "60", gps_enabled: false }).fields).toEqual({
      gps_interval: 60,
    });
  });

  it("knows where the device answers", () => {
    expect(answerPath("command/buzzer")).toBe("response/buzzer");
    expect(answerPath("settings/set/gps_settings")).toBe("settings/ack/gps_settings");
    expect(answerPath("settings/get/gps_settings")).toBe("settings/response/gps_settings");
  });

  it("starts from schema defaults", () => {
    expect(initialValues(fieldsOf("command/reboot"))).toEqual({ reboot_enable: true });
  });

  it("previews the published JSON", () => {
    expect(previewPayload("command/buzzer", { enabled: true })).toEqual({
      timestamp: "<now, epoch seconds>",
      request_id: "<UUID from the backend>",
      enabled: true,
    });
    expect(previewPayload("settings/set/gps_settings", { gps_interval: 45 })).toEqual({
      timestamp: "<now, epoch seconds>",
      action: "set",
      setting_id: "<UUID from the backend>",
      setting_type: "gps",
      gps_interval: 45,
    });
  });
});
