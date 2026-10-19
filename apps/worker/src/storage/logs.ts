import { isValidDeviceId, PIPELINE_LOG_SOURCES, type PipelineLogSource } from "@udara/contracts";
import type { Db } from "./supabase.js";

/** Saved levels (debug lines are live only, ADR 0008). */
export const SAVED_LOG_LEVELS = ["info", "warn", "error"] as const;
export type SavedLogLevel = (typeof SAVED_LOG_LEVELS)[number];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;
const MAX_TEXT = 100;

export interface LogsQuery {
  from: string | null;
  to: string | null;
  deviceId: string | null;
  /** Exact topic key, e.g. `telemetry/gps`. */
  topic: string | null;
  /** Minimum level: `warn` returns warn + error. */
  minLevel: SavedLogLevel | null;
  source: PipelineLogSource | null;
  /** Case-insensitive substring of the message. */
  search: string | null;
  /** Cursor: only lines with a smaller id (older), for "load older". */
  beforeId: number | null;
  /** Cursor: only lines with a larger id (newer), for live tail. */
  afterId: number | null;
  limit: number;
}

type Params = Partial<
  Record<
    "from" | "to" | "device" | "topic" | "level" | "source" | "q" | "before" | "after" | "limit",
    string
  >
>;

const cursor = (raw: string | undefined): number | null | string => {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : "before/after must be positive integers";
};

const iso = (raw: string | undefined): string | null | undefined => {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

/** Validates query-string input; returns an error message for a 400 instead of throwing. */
export function parseLogsQuery(params: Params): LogsQuery | string {
  const from = iso(params.from);
  const to = iso(params.to);
  if (from === undefined || to === undefined) return "from/to must be ISO dates";
  if (from && to && from > to) return "from must be before to";

  const deviceId = params.device || null;
  if (deviceId !== null && !isValidDeviceId(deviceId)) return "invalid device id";

  const topic = params.topic || null;
  if (topic !== null && (topic.length > MAX_TEXT || !/^[a-z0-9_/+#-]+$/i.test(topic))) {
    return "invalid topic";
  }

  const level = params.level || null;
  if (level !== null && !(SAVED_LOG_LEVELS as readonly string[]).includes(level)) {
    return `level must be one of ${SAVED_LOG_LEVELS.join(", ")}`;
  }
  const source = params.source || null;
  if (source !== null && !(PIPELINE_LOG_SOURCES as readonly string[]).includes(source)) {
    return `source must be one of ${PIPELINE_LOG_SOURCES.join(", ")}`;
  }

  const search = params.q?.trim() || null;
  if (search !== null && search.length > MAX_TEXT) return `q must be at most ${MAX_TEXT} chars`;

  const beforeId = cursor(params.before);
  const afterId = cursor(params.after);
  if (typeof beforeId === "string") return beforeId;
  if (typeof afterId === "string") return afterId;

  const limit = params.limit ? Number(params.limit) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return `limit must be 1..${MAX_LIMIT}`;
  }

  return {
    from,
    to,
    deviceId,
    topic,
    minLevel: level as SavedLogLevel | null,
    source: source as PipelineLogSource | null,
    search,
    beforeId,
    afterId,
    limit,
  };
}

/** Levels at or above `min`. */
export function levelsFrom(min: SavedLogLevel): SavedLogLevel[] {
  return SAVED_LOG_LEVELS.slice(SAVED_LOG_LEVELS.indexOf(min));
}

/** Escapes `%`, `_` and `\` for an ILIKE pattern. */
export const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Newest first (id order = insert order). */
export function queryLogs(db: Db, q: LogsQuery) {
  let query = db
    .from("pipeline_logs")
    .select("id, at, level, source, device_id, topic, message, detail");
  if (q.from) query = query.gte("at", q.from);
  if (q.to) query = query.lte("at", q.to);
  if (q.deviceId) query = query.eq("device_id", q.deviceId);
  if (q.topic) query = query.eq("topic", q.topic);
  if (q.minLevel && q.minLevel !== "info") query = query.in("level", levelsFrom(q.minLevel));
  if (q.source) query = query.eq("source", q.source);
  if (q.search) query = query.ilike("message", `%${likeEscape(q.search)}%`);
  if (q.beforeId !== null) query = query.lt("id", q.beforeId);
  if (q.afterId !== null) query = query.gt("id", q.afterId);
  return query.order("id", { ascending: false }).limit(q.limit);
}
