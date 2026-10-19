import { INBOUND_TOPICS, topicDocs } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { controlsFor } from "../src/device/controls.js";

describe("controlsFor", () => {
  it("puts the GPS interval setting next to GPS", () => {
    expect(controlsFor("telemetry/gps").map((c) => c.path)).toEqual([
      "settings/set/gps_interval",
      "settings/get/gps_interval",
      "command/location",
    ]);
  });

  it("maps responses back to their request", () => {
    expect(controlsFor("response/buzzer").map((c) => c.path)).toEqual(["command/buzzer"]);
    expect(controlsFor("settings/response/gps_interval").map((c) => c.path)).toEqual([
      "settings/set/gps_interval",
      "settings/get/gps_interval",
    ]);
  });

  it("gives every subscribed topic a control that really is publishable", () => {
    const published = new Set(
      topicDocs()
        .filter((d) => d.direction === "device")
        .map((d) => d.path),
    );
    for (const key of [...Object.keys(INBOUND_TOPICS), "settings/response/gps_interval"]) {
      const controls = controlsFor(key);
      expect(controls.length, key).toBeGreaterThan(0);
      for (const c of controls) expect(published.has(c.path), `${key} → ${c.path}`).toBe(true);
    }
    expect(controlsFor("rejected")).toEqual([]);
  });
});
