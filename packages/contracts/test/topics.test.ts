import { describe, expect, it } from "vitest";
import { INGEST_SUBSCRIPTION, isPublishableDeviceTopic, isValidDeviceId } from "../src/index.js";

describe("topics", () => {
  it("subscribes to the whole backend namespace", () => {
    expect(INGEST_SUBSCRIPTION).toBe("pettracker/backend/#");
  });

  it.each(["dog001", "collar_7", "a-b"])("accepts device id %s", (id) => {
    expect(isValidDeviceId(id)).toBe(true);
  });

  it.each(["", "Dog001", "dog 001", "dog/001", "x".repeat(65)])("rejects device id %j", (id) => {
    expect(isValidDeviceId(id)).toBe(false);
  });

  it.each([
    "pettracker/device/dog001/command/reboot",
    "pettracker/device/dog001/settings/set/gps_interval",
  ])("allows publishing to %s", (topic) => {
    expect(isPublishableDeviceTopic(topic)).toBe(true);
  });

  it.each([
    "pettracker/backend/dog001/telemetry/gps",
    "pettracker/device/dog001",
    "pettracker/device/dog001/",
    "pettracker/device/+/command/reboot",
    "pettracker/device/dog001/command/#",
    "pettracker/device/Dog001/command/reboot",
    "pettracker/device/dog001//reboot",
    "other/device/dog001/command/reboot",
  ])("refuses publishing to %s", (topic) => {
    expect(isPublishableDeviceTopic(topic)).toBe(false);
  });
});
