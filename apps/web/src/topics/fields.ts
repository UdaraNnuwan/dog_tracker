/** Turns a topic's JSON Schema (from `topicDocs()`) into rows for a field table. */

type Schema = Record<string, unknown>;

export interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  /** Ranges, lengths, enums, units… in one readable line. */
  rules: string;
  /** How a form should ask for this field (the send dialog). */
  input: FieldInput;
}

export type FieldInput =
  | { kind: "boolean" }
  | { kind: "integer" | "number"; min: number | null; max: number | null }
  | { kind: "string"; minLength: number | null }
  | { kind: "enum"; options: string[] }
  | { kind: "json" };

export interface Variant {
  /** e.g. `status: success`, or null when the payload has a single shape. */
  label: string | null;
  fields: FieldRow[];
  /** True when extra, unlisted fields are expected (opaque diagnostics). */
  open: boolean;
}

const isSchema = (v: unknown): v is Schema => v !== null && typeof v === "object";

/** Bounds that only mean "any int/timestamp" add noise, so they are left out. */
const NOISE_MAX = 1e10;

function typeOf(s: Schema): string {
  if ("const" in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const variants = s.anyOf ?? s.oneOf;
  if (Array.isArray(variants)) return variants.filter(isSchema).map(typeOf).join(" | ");
  if (s.type === "object" && isSchema(s.properties)) {
    return `{ ${Object.keys(s.properties).join(", ")} }`;
  }
  if (Array.isArray(s.type)) return s.type.join(" | ");
  return typeof s.type === "string" ? s.type : "any";
}

function rulesOf(s: Schema): string {
  const out: string[] = [];
  const num = (k: string) => (typeof s[k] === "number" ? s[k] : null);
  const min = num("minimum");
  const max = num("maximum");
  const hasMax = max !== null && max < NOISE_MAX;
  if (min !== null && hasMax) out.push(`${min}…${max}`);
  else if (min !== null) out.push(`≥ ${min}`);
  else if (hasMax) out.push(`≤ ${max}`);
  const minLen = num("minLength");
  const maxLen = num("maxLength");
  if (minLen !== null || maxLen !== null) out.push(`length ${minLen ?? 0}…${maxLen ?? "∞"}`);
  if (typeof s.format === "string") out.push(s.format);
  if (typeof s.description === "string") out.push(s.description);
  return out.join(" · ");
}

function inputOf(s: Schema): FieldInput {
  if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === "string")) {
    return { kind: "enum", options: s.enum };
  }
  const num = (k: string) => (typeof s[k] === "number" && Math.abs(s[k]) < NOISE_MAX ? s[k] : null);
  switch (s.type) {
    case "boolean":
      return { kind: "boolean" };
    case "integer":
    case "number":
      return { kind: s.type, min: num("minimum"), max: num("maximum") };
    case "string":
      return { kind: "string", minLength: num("minLength") };
    default:
      return { kind: "json" };
  }
}

function fieldsOf(s: Schema): FieldRow[] {
  const props = isSchema(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  return Object.entries(props)
    .filter((e): e is [string, Schema] => isSchema(e[1]))
    .map(([name, p]) => ({
      name,
      type: typeOf(p),
      required: required.has(name),
      rules: rulesOf(p),
      input: inputOf(p),
    }));
}

/** A label for a union member: its distinguishing constant, e.g. `status: success`. */
function variantLabel(s: Schema, i: number): string {
  const props = isSchema(s.properties) ? s.properties : {};
  for (const [name, p] of Object.entries(props)) {
    if (isSchema(p) && "const" in p) return `${name}: ${String(p.const)}`;
    if (isSchema(p) && Array.isArray(p.enum) && p.enum.length <= 3) {
      return `${name}: ${p.enum.join(" | ")}`;
    }
  }
  return `variant ${i + 1}`;
}

/** One field table per payload shape (unions such as success/failed responses give several). */
export function schemaVariants(schema: Schema): Variant[] {
  const union = schema.anyOf ?? schema.oneOf;
  const members = Array.isArray(union) ? union.filter(isSchema) : [schema];
  return members.map((m, i) => ({
    label: members.length > 1 ? variantLabel(m, i) : null,
    fields: fieldsOf(m),
    open: m.additionalProperties !== undefined && m.additionalProperties !== false,
  }));
}
