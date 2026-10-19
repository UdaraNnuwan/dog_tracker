import { z } from "zod";
import { COMMANDS, INBOUND_TOPICS, SETTINGS_RESPONSE_TOPIC } from "./catalogue.js";
import { SPEC_EXAMPLES } from "./examples.js";
import { settingsResponse } from "./schemas/inbound.js";
import { settingsGet, settingsSet } from "./schemas/outbound.js";
import { SETTING_NAMES } from "./settings.js";

/**
 * JSON Schema (draft 2020-12) for every topic payload, for the firmware team (spec §20 asks
 * for machine-readable schemas). Generated from the Zod schemas; the files are committed under
 * `packages/contracts/json-schema/` and a test fails when they drift.
 *
 * `io: "input"` describes what a publisher may send: unknown fields are allowed (spec §15).
 */
interface Target {
  direction: "backend" | "device";
  path: string;
  schema: z.ZodType;
  qos: 0 | 1;
  retain: boolean | "optional";
}

function targets(): Target[] {
  const list: Target[] = [];
  for (const [path, e] of Object.entries(INBOUND_TOPICS)) {
    list.push({ direction: "backend", path, schema: e.schema, qos: e.qos, retain: e.retain });
  }
  for (const s of SETTING_NAMES) {
    list.push({
      direction: "backend",
      path: `settings/response/${s}`,
      schema: settingsResponse(s),
      ...SETTINGS_RESPONSE_TOPIC,
    });
  }
  // Everything the backend publishes is QoS 1, retain=false (spec §4, rule 2).
  for (const [name, schema] of Object.entries(COMMANDS)) {
    list.push({ direction: "device", path: `command/${name}`, schema, qos: 1, retain: false });
  }
  for (const s of SETTING_NAMES) {
    list.push({
      direction: "device",
      path: `settings/set/${s}`,
      schema: settingsSet(s),
      qos: 1,
      retain: false,
    });
    list.push({
      direction: "device",
      path: `settings/get/${s}`,
      schema: settingsGet,
      qos: 1,
      retain: false,
    });
  }
  return list;
}

/** One topic of the catalogue with its payload format, for docs and the Topics page. */
export interface TopicDoc {
  /** `backend` = device → cloud (the bridge subscribes), `device` = cloud → device (it publishes). */
  direction: "backend" | "device";
  /** Path after `pettracker/{direction}/{device_id}/`. */
  path: string;
  /** Full topic with a `{device_id}` placeholder. */
  topic: string;
  qos: 0 | 1;
  retain: boolean | "optional";
  /** Spec sections of the examples, e.g. `["5.1"]`. */
  sections: string[];
  /** Examples from the spec (or derived from its field tables). */
  examples: Record<string, unknown>[];
  /** JSON Schema of the payload (draft 2020-12, publisher view: extra fields allowed). */
  schema: Record<string, unknown>;
}

/** Every topic the system subscribes to or publishes, in catalogue order. */
export function topicDocs(): TopicDoc[] {
  return targets().map((t) => {
    const examples = SPEC_EXAMPLES.filter((e) => e.direction === t.direction && e.path === t.path);
    return {
      direction: t.direction,
      path: t.path,
      topic: `pettracker/${t.direction}/{device_id}/${t.path}`,
      qos: t.qos,
      retain: t.retain,
      sections: [...new Set(examples.map((e) => e.section))],
      examples: examples.map((e) => e.payload),
      schema: z.toJSONSchema(t.schema, { io: "input" }),
    };
  });
}

/** Relative file path (e.g. `backend/telemetry/gps.schema.json`) → JSON Schema document. */
export function buildJsonSchemas(): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const t of topicDocs()) {
    const retain = t.retain === "optional" ? "optional" : String(t.retain);
    const { $schema, ...body } = t.schema;
    out.set(`${t.direction}/${t.path}.schema.json`, {
      $schema,
      title: t.topic,
      description: `Publisher QoS ${t.qos}, retain ${retain}.`,
      ...body,
      ...(t.examples.length ? { examples: t.examples } : {}),
    });
  }
  return out;
}

/** Stable, diff-friendly serialisation used for the committed files. */
export const serialiseSchema = (doc: Record<string, unknown>) =>
  `${JSON.stringify(doc, null, 2)}\n`;
