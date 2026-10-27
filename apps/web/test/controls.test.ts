import { INBOUND_TOPICS, topicDocs } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { controlsFor } from "../src/device/controls.js";

describe("controlsFor", () => {
  it("puts the GPS settings next to GPS", () => {
    expect(controlsFor("telemetry/gps").map((c) => c.path)).toEqual([
      "settings/set/gps_settings",
      "settings/get/gps_settings",
      "command/location",
    ]);
  });

  it("maps responses back to their request", () => {
    expect(controlsFor("response/buzzer").map((c) => c.path)).toEqual(["command/buzzer"]);
    for (const key of ["settings/response/gps_settings", "settings/ack/gps_settings"]) {
      expect(controlsFor(key).map((c) => c.path)).toEqual([
        "settings/set/gps_settings",
        "settings/get/gps_settings",
      ]);
    }
  });

  it("gives every subscribed topic a control that really is publishable", () => {
    const docs = topicDocs();
    const published = new Set(docs.filter((d) => d.publisher === "backend").map((d) => d.path));
    const subscribed = docs.filter((d) => d.publisher === "collar").map((d) => d.path);
    expect(subscribed).toEqual(expect.arrayContaining(Object.keys(INBOUND_TOPICS)));
    for (const key of subscribed) {
      const controls = controlsFor(key);
      expect(controls.length, key).toBeGreaterThan(0);
      for (const c of controls) expect(published.has(c.path), `${key} → ${c.path}`).toBe(true);
    }
    expect(controlsFor("rejected")).toEqual([]);
  });
});
