import type { InboundMessage, ParseResult, PipelineLog } from "@udara/contracts";
import type { StorageOutcome } from "../bridge/pipelineLog.js";
import {
  GpsThinner,
  toStoredLog,
  toStoredMessage,
  toStoredRejection,
  type StoredLog,
  type StoredMessage,
  type StoredRejection,
} from "./rows.js";

/** Rows held while Supabase is unreachable; beyond this the oldest are dropped. */
const MAX_PENDING = 5_000;

export interface Batch {
  messages: StoredMessage[];
  rejected: StoredRejection[];
  logs: StoredLog[];
}

/**
 * Buffers rows between flushes (rule 10: batch writes, flush every 5–10 s). A failed flush
 * puts its rows back in front so nothing is lost while Supabase is briefly down; memory stays
 * bounded by MAX_PENDING (ADR 0006).
 */
export class IngestBuffer {
  private messages: StoredMessage[] = [];
  private rejected: StoredRejection[] = [];
  private logs: StoredLog[] = [];
  private gps = new GpsThinner();
  dropped = 0;

  get size(): number {
    return this.messages.length + this.rejected.length + this.logs.length;
  }

  /** Buffers one inbound message and says what will happen to it (for the log line). */
  add(
    topic: string,
    result: ParseResult<InboundMessage>,
    retained: boolean,
    receivedAt: number,
  ): StorageOutcome {
    let outcome: StorageOutcome;
    if (!result.ok) {
      this.rejected.push(toStoredRejection(topic, result, receivedAt));
      outcome = "rejected";
    } else {
      const row = toStoredMessage(result.value, receivedAt, retained);
      if (!row) return "live_only";
      if (result.value.path === "telemetry/gps" && !retained) {
        const { latitude, longitude } = result.value.data;
        if (!this.gps.keep(row.device_id, latitude, longitude, row.ts)) return "thinned";
      }
      this.messages.push(row);
      // ingest_batch only updates the device's latest state from retained replays.
      outcome = retained ? "retained" : "stored";
    }
    this.trim();
    return outcome;
  }

  /** Buffers a log line for `pipeline_logs`; `debug` lines are skipped (live only). */
  addLog(entry: PipelineLog): void {
    const row = toStoredLog(entry);
    if (!row) return;
    this.logs.push(row);
    this.trim();
  }

  /** Takes everything buffered so far. */
  drain(): Batch {
    const batch = { messages: this.messages, rejected: this.rejected, logs: this.logs };
    this.messages = [];
    this.rejected = [];
    this.logs = [];
    return batch;
  }

  /** Puts a failed batch back in front of anything that arrived meanwhile. */
  restore(batch: Batch): void {
    this.messages = [...batch.messages, ...this.messages];
    this.rejected = [...batch.rejected, ...this.rejected];
    this.logs = [...batch.logs, ...this.logs];
    this.trim();
  }

  /** Drops buffered rows (and GPS thinning state) for one device or all. */
  clear(deviceId?: string): void {
    if (deviceId === undefined) {
      this.messages = [];
      this.rejected = [];
      this.logs = [];
    } else {
      this.messages = this.messages.filter((m) => m.device_id !== deviceId);
      this.rejected = this.rejected.filter((r) => r.device_id !== deviceId);
      this.logs = this.logs.filter((l) => l.device_id !== deviceId);
    }
    this.gps.forget(deviceId);
  }

  /** Over the cap, drops the oldest logs first, then rejections, then messages. */
  private trim(): void {
    let over = this.size - MAX_PENDING;
    if (over <= 0) return;
    this.dropped += over;
    for (const list of [this.logs, this.rejected, this.messages]) {
      const n = Math.min(over, list.length);
      list.splice(0, n);
      over -= n;
    }
  }
}
