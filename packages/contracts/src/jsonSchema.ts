import { z } from "zod";
import { COMMANDS, INBOUND_TOPICS, SETTINGS_TOPIC, TBD_COMMANDS } from "./catalogue.js";
import { SPEC_EXAMPLES } from "./examples.js";
import { settingsAck, settingsResponse } from "./schemas/inbound.js";
import { settingsGet, settingsSet } from "./schemas/outbound.js";
import { SETTING_NAMES } from "./settings.js";

/**
 * JSON Schema (draft 2020-12) for every topic payload, for the firmware team. Generated from
 * the Zod schemas; the files are committed under `packages/contracts/json-schema/` and a test
 * fails when they drift.
 *
 * Topics the collar publishes use `io: "input"`: what it may send, unknown fields allowed.
 * Topics the backend publishes use `io: "output"`: exactly what it sends (typed values).
 */
interface Target {
  direction: "backend" | "device";
  path: string;
  schema: z.ZodType;
  qos: 0 | 1;
  retain: boolean;
  /** Who publishes it; differs from `direction` only for settings ACKs. */
  publisher: "collar" | "backend";
  tbd: boolean;
}

function targets(): Target[] {
  const list: Target[] = [];
  const collar = { publisher: "collar" as const, tbd: false };
  // Everything the backend publishes is QoS 1, retain=false (rule 2).
  const backend = { publisher: "backend" as const, qos: 1 as const, retain: false, tbd: false };
  for (const [path, e] of Object.entries(INBOUND_TOPICS)) {
    list.push({ ...collar, direction: "backend", path, ...e, tbd: e.tbd === true });
  }
  for (const [name, schema] of Object.entries(COMMANDS)) {
    const tbd = TBD_COMMANDS.has(name as keyof typeof COMMANDS);
    list.push({ ...backend, direction: "device", path: `command/${name}`, schema, tbd });
  }
  for (const s of SETTING_NAMES) {
    const settings = { ...SETTINGS_TOPIC, direction: "device" as const };
    list.push(
      { ...backend, ...settings, path: `settings/set/${s}`, schema: settingsSet(s) },
      { ...collar, ...settings, path: `settings/ack/${s}`, schema: settingsAck(s) },
      { ...backend, ...settings, path: `settings/get/${s}`, schema: settingsGet(s) },
      {
        ...collar,
        ...SETTINGS_TOPIC,
        direction: "backend",
        path: `settings/response/${s}`,
        schema: settingsResponse(s),
      },
    );
  }
  return list;
}

/** One topic of the catalogue with its payload format, for docs and the Topics page. */
export interface TopicDoc {
  /** The topic's publisher segment: `backend` = collar → backend, `device` = backend → collar. */
  direction: "backend" | "device";
  /** Who actually publishes: the collar also publishes the settings ACKs under `device/`. */
  publisher: "collar" | "backend";
  /** Path after `pettracker/{device_id}/{direction}/`. */
  path: string;
  /** Full topic with a `{device_id}` placeholder. */
  topic: string;
  qos: 0 | 1;
  retain: boolean;
  /** Marked TBD in the spec (pilot phase). */
  tbd: boolean;
  /** Spec sections of the examples, e.g. `["1.1"]`. */
  sections: string[];
  /** Examples from the spec (or derived from its field tables). */
  examples: Record<string, unknown>[];
  /** JSON Schema of the payload (draft 2020-12, publisher view). */
  schema: Record<string, unknown>;
}

/** Every topic the system subscribes to or publishes, in catalogue order. */
export function topicDocs(): TopicDoc[] {
  return targets().map((t) => {
    const examples = SPEC_EXAMPLES.filter((e) => e.direction === t.direction && e.path === t.path);
    return {
      direction: t.direction,
      publisher: t.publisher,
      path: t.path,
      topic: `pettracker/{device_id}/${t.direction}/${t.path}`,
      qos: t.qos,
      retain: t.retain,
      tbd: t.tbd,
      sections: [...new Set(examples.map((e) => e.section))],
      examples: examples.map((e) => e.payload),
      schema: z.toJSONSchema(t.schema, {
        io: t.publisher === "collar" ? "input" : "output",
        override: collapseSameUnion,
      }),
    };
  });
}

/**
 * In the output view a settings value's `number | "60"` union becomes two identical members;
 * show it once.
 */
function collapseSameUnion(ctx: { jsonSchema: Record<string, unknown> }): void {
  const members = ctx.jsonSchema.anyOf;
  if (!Array.isArray(members) || members.length < 2) return;
  const first = JSON.stringify(members[0]);
  if (!members.every((m) => JSON.stringify(m) === first)) return;
  delete ctx.jsonSchema.anyOf;
  Object.assign(ctx.jsonSchema, members[0]);
}

/** Relative file path (e.g. `backend/telemetry/gps.schema.json`) → JSON Schema document. */
export function buildJsonSchemas(): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const t of topicDocs()) {
    const { $schema, ...body } = t.schema;
    out.set(`${t.direction}/${t.path}.schema.json`, {
      $schema,
      title: t.topic,
      description: `Published by the ${t.publisher}, QoS ${t.qos}, retain ${t.retain}.${
        t.tbd ? " TBD in spec V3 (pilot phase)." : ""
      }`,
      ...body,
      ...(t.examples.length ? { examples: t.examples } : {}),
    });
  }
  return out;
}

/** Stable, diff-friendly serialisation used for the committed files. */
export const serialiseSchema = (doc: Record<string, unknown>) =>
  `${JSON.stringify(doc, null, 2)}\n`;
