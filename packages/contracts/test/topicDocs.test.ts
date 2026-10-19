import { describe, expect, it } from "vitest";
import { INBOUND_TOPICS, SETTING_NAMES, TOPIC_FIELDS, topicDocs } from "../src/index.js";

describe("topicDocs", () => {
  const docs = topicDocs();

  it("lists every subscribed and published topic", () => {
    const sub = docs.filter((d) => d.direction === "backend").map((d) => d.path);
    const pub = docs.filter((d) => d.direction === "device").map((d) => d.path);
    expect(sub).toEqual([
      ...Object.keys(INBOUND_TOPICS),
      ...SETTING_NAMES.map((s) => `settings/response/${s}`),
    ]);
    expect(pub).toContain("command/reboot");
    expect(pub).toContain("settings/set/gps_interval");
    // OTA is a spec proposal only (CLAUDE.md).
    expect(pub).not.toContain("command/firmware_update");
    // The backend only publishes QoS 1, retain=false (rule 2).
    expect(
      docs.filter((d) => d.direction === "device").every((d) => d.qos === 1 && !d.retain),
    ).toBe(true);
  });

  it("carries topic, spec section, example and schema", () => {
    const gps = docs.find((d) => d.direction === "backend" && d.path === "telemetry/gps")!;
    expect(gps).toMatchObject({
      topic: "pettracker/backend/{device_id}/telemetry/gps",
      qos: 0,
      retain: false,
      sections: ["5.1"],
    });
    expect(gps.examples[0]).toMatchObject({ latitude: 6.9271 });
    expect(gps.schema).toMatchObject({ type: "object" });
    expect(gps.schema.required).toEqual(expect.arrayContaining(["latitude", "longitude"]));
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
    out.delete("protocol_version");
    return [...out];
  }

  it("matches the schema of every subscribed topic", () => {
    const backend = topicDocs().filter((d) => d.direction === "backend");
    expect(Object.keys(TOPIC_FIELDS).sort()).toEqual(backend.map((d) => d.path).sort());
    for (const d of backend) {
      expect([...TOPIC_FIELDS[d.path]!].sort(), d.path).toEqual(fieldsOf(d.schema).sort());
    }
  });
});
