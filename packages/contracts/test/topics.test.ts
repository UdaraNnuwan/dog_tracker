import { describe, expect, it } from "vitest";
import {
  INGEST_SUBSCRIPTIONS,
  backendTopic,
  deviceTopic,
  isPublishableDeviceTopic,
  isValidDeviceId,
} from "../src/index.js";

describe("topics", () => {
  it("subscribes to everything collars publish, including settings ACKs", () => {
    expect(INGEST_SUBSCRIPTIONS).toEqual([
      "pettracker/+/backend/#",
      "pettracker/+/device/settings/ack/+",
    ]);
  });

  it("puts the device id before the publisher (spec V3)", () => {
    expect(backendTopic("dog001", "telemetry/gps")).toBe("pettracker/dog001/backend/telemetry/gps");
    expect(deviceTopic("dog001", "command/reboot")).toBe("pettracker/dog001/device/command/reboot");
  });

  it.each(["dog001", "collar_7", "a-b"])("accepts device id %s", (id) => {
    expect(isValidDeviceId(id)).toBe(true);
  });

  it.each(["", "Dog001", "dog 001", "dog/001", "x".repeat(65)])("rejects device id %j", (id) => {
    expect(isValidDeviceId(id)).toBe(false);
  });

  it.each([
    "pettracker/dog001/device/command/reboot",
    "pettracker/dog001/device/settings/set/gps_settings",
    "pettracker/dog001/device/settings/get/gps_settings",
  ])("allows publishing to %s", (topic) => {
    expect(isPublishableDeviceTopic(topic)).toBe(true);
  });

  it.each([
    "pettracker/dog001/backend/telemetry/gps",
    "pettracker/dog001/device",
    "pettracker/dog001/device/",
    "pettracker/+/device/command/reboot",
    "pettracker/dog001/device/command/#",
    "pettracker/Dog001/device/command/reboot",
    "pettracker/dog001/device//reboot",
    "pettracker/device/dog001/command/reboot",
    "other/dog001/device/command/reboot",
    // The collar publishes the ACKs, never the backend.
    "pettracker/dog001/device/settings/ack/gps_settings",
  ])("refuses publishing to %s", (topic) => {
    expect(isPublishableDeviceTopic(topic)).toBe(false);
  });
});
