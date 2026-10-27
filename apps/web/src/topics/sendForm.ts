import type { FieldRow } from "./fields.js";

/**
 * Added by the backend to every request (spec V3 §4, §6, rule 3): not entered by hand. `action`
 * is fixed per topic (`set`, `get`, `get_current_location`, `enter_sleep`).
 */
export const ENVELOPE_FIELDS = new Set([
  "timestamp",
  "request_id",
  "setting_id",
  "setting_type",
  "action",
]);

export type FormValue = string | boolean;

/** Fields the user fills in for a published topic. */
export const editableFields = (fields: FieldRow[]) =>
  fields.filter((f) => !ENVELOPE_FIELDS.has(f.name));

/** Starting values: the schema default, else booleans off, the first enum option, or empty. */
export function initialValues(fields: FieldRow[]): Record<string, FormValue> {
  return Object.fromEntries(
    editableFields(fields).map((f) => [
      f.name,
      f.input.kind === "boolean"
        ? f.default === true
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
      // An optional setting left off is not sent, so a SET only changes what was ticked.
      if (raw === true || f.required) out[f.name] = raw === true;
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
export function previewPayload(
  path: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const [kind, op, setting = ""] = path.split("/");
  if (kind === "settings") {
    return {
      timestamp: "<now, epoch seconds>",
      action: op,
      setting_id: "<UUID from the backend>",
      setting_type: setting.replace(/_settings$/, ""),
      ...fields,
    };
  }
  return { timestamp: "<now, epoch seconds>", request_id: "<UUID from the backend>", ...fields };
}

/** Topic path the collar answers on (spec V3 §5, §6). */
export const answerPath = (path: string) =>
  path
    .replace(/^command\//, "response/")
    .replace(/^settings\/set\//, "settings/ack/")
    .replace(/^settings\/get\//, "settings/response/");
