import { topicDocs } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { schemaVariants } from "../src/topics/fields.js";

const doc = (direction: "backend" | "device", path: string) =>
  topicDocs().find((d) => d.direction === direction && d.path === path)!;

describe("schemaVariants", () => {
  it("lists fields with type, required flag and readable rules", () => {
    const [gps] = schemaVariants(doc("backend", "telemetry/gps").schema);
    expect(gps!.label).toBeNull();
    const byName = Object.fromEntries(gps!.fields.map((f) => [f.name, f]));
    expect(byName.latitude).toEqual({
      name: "latitude",
      type: "number",
      required: true,
      rules: "-90…90",
      input: { kind: "number", min: -90, max: 90 },
    });
    expect(byName.speed).toMatchObject({ required: false, rules: "≥ 0 · m/s" });
    // Huge technical bounds are hidden.
    expect(byName.timestamp).toMatchObject({ type: "integer", rules: "≥ 0" });
  });

  it("shows enums and marks opaque payloads as open", () => {
    const [conn] = schemaVariants(doc("backend", "status/connectivity").schema);
    expect(conn!.fields.find((f) => f.name === "status")!.type).toBe('"online" | "offline"');
    expect(schemaVariants(doc("backend", "diagnostic/crash").schema)[0]!.open).toBe(true);
  });

  it("describes form inputs for the send dialog", () => {
    const [buzzer] = schemaVariants(doc("device", "command/buzzer").schema);
    const inputs = Object.fromEntries(buzzer!.fields.map((f) => [f.name, f.input]));
    expect(inputs.enabled).toEqual({ kind: "boolean" });
    expect(inputs.duration).toEqual({ kind: "number", min: 0, max: null });
    const [set] = schemaVariants(doc("device", "settings/set/gps_interval").schema);
    expect(set!.fields.find((f) => f.name === "value")!.input).toEqual({
      kind: "integer",
      min: 10,
      max: 86400,
    });
  });

  it("gives every topic at least one field table", () => {
    for (const d of topicDocs()) {
      const variants = schemaVariants(d.schema);
      expect(variants.length, d.path).toBeGreaterThan(0);
      for (const v of variants) expect(v.fields.length, d.path).toBeGreaterThan(0);
    }
  });
});
