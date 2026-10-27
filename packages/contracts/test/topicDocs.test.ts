import { describe, expect, it } from "vitest";
import { INBOUND_TOPICS, SETTING_NAMES, TOPIC_FIELDS, topicDocs } from "../src/index.js";

describe("topicDocs", () => {
  const docs = topicDocs();

  it("lists every subscribed and published topic", () => {
    const byCollar = docs.filter((d) => d.publisher === "collar").map((d) => d.path);
    const byBackend = docs.filter((d) => d.publisher === "backend").map((d) => d.path);
    expect(byCollar.sort()).toEqual(
      [
        ...Object.keys(INBOUND_TOPICS),
        ...SETTING_NAMES.flatMap((s) => [`settings/response/${s}`, `settings/ack/${s}`]),
      ].sort(),
    );
    expect(byBackend).toContain("command/reboot");
    expect(byBackend).toContain("settings/set/gps_settings");
    expect(byBackend).toContain("settings/get/gps_settings");
    // OTA is a spec proposal only (CLAUDE.md).
    expect(byBackend).not.toContain("command/firmware_update");
    // The backend only publishes QoS 1, retain=false (rule 2).
    expect(
      docs.filter((d) => d.publisher === "backend").every((d) => d.qos === 1 && !d.retain),
    ).toBe(true);
  });

  it("files the ACK under the device publisher, published by the collar", () => {
    expect(docs.find((d) => d.path === "settings/ack/gps_settings")).toMatchObject({
      direction: "device",
      publisher: "collar",
      topic: "pettracker/{device_id}/device/settings/ack/gps_settings",
    });
  });

  it("carries topic, spec section, example and schema", () => {
    const gps = docs.find((d) => d.direction === "backend" && d.path === "telemetry/gps")!;
    expect(gps).toMatchObject({
      topic: "pettracker/{device_id}/backend/telemetry/gps",
      qos: 0,
      retain: false,
      tbd: false,
      sections: ["1.1"],
    });
    expect(gps.examples[0]).toMatchObject({ latitude: 6.9271 });
    expect(gps.schema).toMatchObject({ type: "object" });
    expect(gps.schema.required).toEqual(expect.arrayContaining(["latitude", "longitude", "speed"]));
  });

  it("marks the spec's TBD topics", () => {
    const tbd = docs.filter((d) => d.tbd).map((d) => d.path);
    expect(tbd).toEqual(
      expect.arrayContaining(["event/geofence", "command/config", "response/sleep"]),
    );
    expect(tbd).not.toContain("command/location");
  });
});

describe("TOPIC_FIELDS", () => {
  /** Property names of a schema, across union members, in first-seen order. */
  function fieldsOf(schema: Record<string, unknown>): string[] {
    const members = (schema.anyOf ?? schema.oneOf ?? [schema]) as Record<string, unknown>[];
    const out = new Set<string>();
    for (const m of members) {
      for (const k of Object.keys((m.properties as object | undefined) ?? {})) out.add(k);
    }
    return [...out];
  }

  it("matches the schema of every topic the bridge receives", () => {
    const received = topicDocs().filter((d) => d.publisher === "collar");
    expect(Object.keys(TOPIC_FIELDS).sort()).toEqual(received.map((d) => d.path).sort());
    for (const d of received) {
      expect([...TOPIC_FIELDS[d.path]!].sort(), d.path).toEqual(fieldsOf(d.schema).sort());
    }
  });
});
