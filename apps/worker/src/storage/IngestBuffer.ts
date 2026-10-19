import type { InboundMessage, ParseResult } from "@udara/contracts";
import {
  GpsThinner,
  toStoredMessage,
  toStoredRejection,
  type StoredMessage,
  type StoredRejection,
} from "./rows.js";

/** Rows held while Supabase is unreachable; beyond this the oldest are dropped. */
const MAX_PENDING = 5_000;

export interface Batch {
  messages: StoredMessage[];
  rejected: StoredRejection[];
}

/**
 * Buffers rows between flushes (rule 10: batch writes, flush every 5–10 s). A failed flush
 * puts its rows back in front so nothing is lost while Supabase is briefly down; memory stays
 * bounded by MAX_PENDING (ADR 0006).
 */
export class IngestBuffer {
  private messages: StoredMessage[] = [];
  private rejected: StoredRejection[] = [];
  private gps = new GpsThinner();
  dropped = 0;

  get size(): number {
    return this.messages.length + this.rejected.length;
  }

  add(
    topic: string,
    result: ParseResult<InboundMessage>,
    retained: boolean,
    receivedAt: number,
  ): void {
    if (!result.ok) {
      this.rejected.push(toStoredRejection(topic, result, receivedAt));
    } else {
      const row = toStoredMessage(result.value, receivedAt, retained);
      if (!row) return;
      if (result.value.path === "telemetry/gps" && !retained) {
        const { latitude, longitude } = result.value.data;
        if (!this.gps.keep(row.device_id, latitude, longitude, row.ts)) return;
      }
      this.messages.push(row);
    }
    this.trim();
  }

  /** Takes everything buffered so far. */
  drain(): Batch {
    const batch = { messages: this.messages, rejected: this.rejected };
    this.messages = [];
    this.rejected = [];
    return batch;
  }

  /** Puts a failed batch back in front of anything that arrived meanwhile. */
  restore(batch: Batch): void {
    this.messages = [...batch.messages, ...this.messages];
    this.rejected = [...batch.rejected, ...this.rejected];
    this.trim();
  }

  /** Drops buffered rows (and GPS thinning state) for one device or all. */
  clear(deviceId?: string): void {
    if (deviceId === undefined) {
      this.messages = [];
      this.rejected = [];
    } else {
      this.messages = this.messages.filter((m) => m.device_id !== deviceId);
      this.rejected = this.rejected.filter((r) => r.device_id !== deviceId);
    }
    this.gps.forget(deviceId);
  }

  private trim(): void {
    const over = this.size - MAX_PENDING;
    if (over <= 0) return;
    const fromRejected = Math.min(over, this.rejected.length);
    this.rejected.splice(0, fromRejected);
    this.messages.splice(0, over - fromRejected);
    this.dropped += over;
  }
}
