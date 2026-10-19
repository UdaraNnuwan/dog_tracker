import {
  liveTopicKey,
  type InboundMessage,
  type ParseResult,
  type PipelineLog,
  type PipelineLogLevel,
  type PipelineLogSource,
} from "@udara/contracts";

/** Lines kept in memory for the snapshot a new browser gets. */
const DEFAULT_RECENT = 300;

/** What storage did with an inbound message (see `IngestBuffer.add`). */
export type StorageOutcome =
  "stored" | "thinned" | "live_only" | "retained" | "rejected" | "storage_off";

const OUTCOME_TEXT: Record<StorageOutcome, string> = {
  stored: "saved to history",
  thinned: "not saved: moved < 5 m (rule 10)",
  live_only: "live only, not saved (rule 10)",
  retained: "retained replay: state only",
  rejected: "saved to rejected_messages",
  storage_off: "storage off",
};

export type LogDraft = Omit<PipelineLog, "seq" | "at">;

/** Raw payload kept per line; inbound payloads can be up to 16 KB (rule 4). */
export const MAX_LOGGED_PAYLOAD_CHARS = 4_000;

const encoder = new TextEncoder();
// Lossy on purpose: invalid UTF-8 is logged with replacement characters instead of failing.
const lossy = new TextDecoder("utf-8");

/** The exact payload text as received, truncated for storage. */
export function rawPayload(payload: Uint8Array | string): {
  bytes: number;
  payload: string;
  truncated: boolean;
} {
  const bytes = typeof payload === "string" ? encoder.encode(payload).length : payload.length;
  const text = typeof payload === "string" ? payload : lossy.decode(payload);
  const truncated = text.length > MAX_LOGGED_PAYLOAD_CHARS;
  return {
    bytes,
    payload: truncated ? text.slice(0, MAX_LOGGED_PAYLOAD_CHARS) : text,
    truncated,
  };
}

/** Short human summary of a payload, so the log reads without opening the detail. */
function summary(msg: InboundMessage): string {
  switch (msg.path) {
    case "telemetry/gps":
      return `${msg.data.latitude.toFixed(5)}, ${msg.data.longitude.toFixed(5)}${
        msg.data.speed !== undefined ? ` · ${(msg.data.speed * 3.6).toFixed(1)} km/h` : ""
      }`;
    case "telemetry/battery":
      return `${msg.data.percentage}% · ${msg.data.voltage} V${msg.data.charging ? " · charging" : ""}`;
    case "telemetry/signal_strength":
      return msg.data.rssi !== undefined ? `rssi ${msg.data.rssi} dBm` : "";
    case "status/connectivity":
      return msg.data.status;
    case "event/geofence":
      return `${msg.data.event} ${msg.data.geofence_id}`;
    case "event/low_battery":
      return `${msg.data.percentage}%`;
    default: {
      const status = (msg.data as { status?: unknown }).status;
      return typeof status === "string" ? status : "";
    }
  }
}

/** Events worth a warning (or error) in the log, independent of storage. */
function levelOf(msg: InboundMessage): PipelineLogLevel {
  switch (msg.path) {
    case "event/tamper":
      return "error";
    case "event/geofence":
      return msg.data.event === "exit" ? "warn" : "info";
    case "event/low_battery":
      return "warn";
    case "status/connectivity":
      return msg.data.status === "offline" ? "warn" : "info";
    case "diagnostic/crash":
      return "error";
    case "diagnostic/log":
      return msg.data.level === "error"
        ? "error"
        : msg.data.level === "warn" || msg.data.level === "warning"
          ? "warn"
          : "info";
    default: {
      const status = (msg.data as { status?: unknown }).status;
      return status === "failed" ? "warn" : "info";
    }
  }
}

/**
 * Log line for one inbound message, with the exact JSON payload as received (also for
 * rejected messages). Raw IMU is `debug` (live only): it arrives with every telemetry tick
 * and isn't stored either (rule 10), so its lines aren't saved (ADR 0008).
 */
export function describeInbound(
  topic: string,
  result: ParseResult<InboundMessage>,
  outcome: StorageOutcome,
  payload: Uint8Array | string,
): LogDraft {
  const raw = rawPayload(payload);
  if (!result.ok) {
    return {
      level: "warn",
      source: "ingest",
      deviceId: result.deviceId ?? null,
      topic: result.path ?? topic,
      message: `rejected: ${result.reason}`,
      detail: { topic, ...raw, issues: result.issues, storage: OUTCOME_TEXT[outcome] },
    };
  }
  const msg = result.value;
  const text = summary(msg);
  return {
    level: msg.path === "telemetry/imu" ? "debug" : levelOf(msg),
    source: "ingest",
    deviceId: msg.deviceId,
    topic: liveTopicKey(msg),
    message: `${text ? `${text} · ` : ""}${OUTCOME_TEXT[outcome]}`,
    detail: { topic, ...raw, outcome },
  };
}

/**
 * Numbers log lines and keeps the most recent ones for snapshots. Pure apart from the
 * injected clock, so it is unit-testable.
 */
export class PipelineLogger {
  private seq = 0;
  private recentLines: PipelineLog[] = [];

  constructor(
    private readonly now: () => number,
    private readonly keep = DEFAULT_RECENT,
  ) {}

  line(draft: LogDraft): PipelineLog {
    const entry: PipelineLog = { ...draft, seq: ++this.seq, at: this.now() };
    this.recentLines.push(entry);
    if (this.recentLines.length > this.keep) this.recentLines.shift();
    return entry;
  }

  /** Shorthand for bridge/storage/demo lines. */
  system(
    level: PipelineLogLevel,
    source: PipelineLogSource,
    message: string,
    extra: { deviceId?: string; detail?: Record<string, unknown> } = {},
  ): PipelineLog {
    return this.line({
      level,
      source,
      deviceId: extra.deviceId ?? null,
      topic: null,
      message,
      detail: extra.detail ?? null,
    });
  }

  /** Oldest first. */
  recent(): PipelineLog[] {
    return [...this.recentLines];
  }

  clear(deviceId?: string): void {
    this.recentLines =
      deviceId === undefined ? [] : this.recentLines.filter((l) => l.deviceId !== deviceId);
  }
}
