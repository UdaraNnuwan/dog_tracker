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
      "duration",
    ]);
    expect(editableFields(fieldsOf("command/reboot"))).toEqual([]);
  });

  it("converts values and reports missing or malformed ones", () => {
    const buzzer = fieldsOf("command/buzzer");
    expect(initialValues(buzzer)).toEqual({ enabled: false, duration: "" });
    expect(toFields(buzzer, { enabled: true, duration: "5" })).toEqual({
      fields: { enabled: true, duration: 5 },
      errors: {},
    });
    expect(toFields(buzzer, { enabled: false, duration: "" }).errors).toEqual({
      duration: "required",
    });
    const set = fieldsOf("settings/set/gps_interval");
    expect(toFields(set, { value: "4.5" }).errors).toEqual({ value: "whole number" });
  });

  it("knows where the device answers", () => {
    expect(answerPath("command/buzzer")).toBe("response/buzzer");
    expect(answerPath("settings/get/gps_interval")).toBe("settings/response/gps_interval");
  });

  it("previews the published JSON", () => {
    expect(previewPayload({ value: 45 })).toMatchObject({
      request_id: "<UUID from the backend>",
      value: 45,
      protocol_version: "1.2",
    });
  });
});
