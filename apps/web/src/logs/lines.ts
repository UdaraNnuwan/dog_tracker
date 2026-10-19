import type { PipelineLog, PipelineLogLevel } from "@udara/contracts";
import { toEpoch, type LogRow } from "../api.js";
import { logKey } from "../live/model.js";

/** One log line as the tables show it, whether it came live or from `pipeline_logs`. */
export interface LogLine {
  key: string;
  /** Epoch seconds (rule 5: converted to text at the UI edge only). */
  at: number;
  level: PipelineLogLevel;
  source: string;
  deviceId: string | null;
  topic: string | null;
  message: string;
  /** The message's JSON exactly as received (`detail.payload`), or null for system lines. */
  json: string | null;
  detail: unknown;
}

/** `detail.payload` when it is the raw JSON text of an inbound message. */
export function payloadOf(detail: unknown): string | null {
  if (detail === null || typeof detail !== "object") return null;
  const payload = (detail as { payload?: unknown }).payload;
  return typeof payload === "string" ? payload : null;
}

/** Pretty-printed JSON, or the text unchanged when it isn't valid JSON (rejected payloads). */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export const fromLive = (l: PipelineLog): LogLine => ({
  key: `live:${logKey(l)}`,
  at: l.at,
  level: l.level,
  source: l.source,
  deviceId: l.deviceId,
  topic: l.topic,
  message: l.message,
  json: payloadOf(l.detail),
  detail: l.detail,
});

const LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

export const fromRow = (r: LogRow): LogLine => ({
  key: `db:${r.id}`,
  at: toEpoch(r.at),
  level: (LEVELS.includes(r.level) ? r.level : "info") as PipelineLogLevel,
  source: r.source,
  deviceId: r.device_id,
  topic: r.topic,
  message: r.message,
  json: payloadOf(r.detail),
  detail: r.detail,
});

const RANK: Record<PipelineLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Filter for the live panel: device, topic, minimum level. */
export function matches(
  line: LogLine,
  f: { deviceId: string | null; topic: string | null; minLevel: PipelineLogLevel },
): boolean {
  return (
    (f.deviceId === null || line.deviceId === f.deviceId) &&
    (f.topic === null || line.topic === f.topic) &&
    RANK[line.level] >= RANK[f.minLevel]
  );
}
