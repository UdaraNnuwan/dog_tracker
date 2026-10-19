import type { FieldRow } from "./fields.js";

/** Added by the backend to every request (spec §3, §7.1, rule 3): not entered by hand. */
export const ENVELOPE_FIELDS = new Set(["timestamp", "request_id", "protocol_version"]);

export type FormValue = string | boolean;

/** Fields the user fills in for a published topic. */
export const editableFields = (fields: FieldRow[]) =>
  fields.filter((f) => !ENVELOPE_FIELDS.has(f.name));

/** Starting values: booleans off, the first enum option, everything else empty. */
export function initialValues(fields: FieldRow[]): Record<string, FormValue> {
  return Object.fromEntries(
    editableFields(fields).map((f) => [
      f.name,
      f.input.kind === "boolean"
        ? false
        : f.input.kind === "enum"
          ? (f.input.options[0] ?? "")
          : "",
    ]),
  );
}

/**
 * Form values → the JSON fields to send. Empty optional fields are left out; required ones
 * and malformed numbers/JSON give an error per field. Ranges are checked by the backend
 * (same Zod schema), so its messages are the source of truth.
 */
export function toFields(
  fields: FieldRow[],
  values: Record<string, FormValue>,
): { fields: Record<string, unknown>; errors: Record<string, string> } {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of editableFields(fields)) {
    const raw = values[f.name];
    if (f.input.kind === "boolean") {
      out[f.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      if (f.required) errors[f.name] = "required";
      continue;
    }
    switch (f.input.kind) {
      case "integer":
      case "number": {
        const n = Number(text);
        if (!Number.isFinite(n) || (f.input.kind === "integer" && !Number.isInteger(n))) {
          errors[f.name] = f.input.kind === "integer" ? "whole number" : "number";
        } else out[f.name] = n;
        break;
      }
      case "json":
        try {
          out[f.name] = JSON.parse(text);
        } catch {
          errors[f.name] = "valid JSON";
        }
        break;
      default:
        out[f.name] = text;
    }
  }
  return { fields: out, errors };
}

/** What will be published, with placeholders for what the backend fills in. */
export function previewPayload(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: "<now, epoch seconds>",
    request_id: "<UUID from the backend>",
    ...fields,
    protocol_version: "1.2",
  };
}

/** Topic path the device answers on (spec §7, §8). */
export const answerPath = (path: string) =>
  path.replace(/^command\//, "response/").replace(/^settings\/(set|get)\//, "settings/response/");
