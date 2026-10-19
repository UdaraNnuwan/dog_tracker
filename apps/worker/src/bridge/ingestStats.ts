import type { InboundMessage, ParseResult } from "@udara/contracts";

/** Rejection samples kept per tick, so one misbehaving device can't flood the logs. */
const MAX_SAMPLES = 3;

export interface RejectionSample {
  topic: string;
  reason: string;
  issues: string[];
}

export interface IngestSummary {
  accepted: Record<string, number>;
  rejected: Record<string, number>;
  samples: RejectionSample[];
}

/**
 * Per-tick ingest counters for the summary log line (one line per tick, not per message:
 * Workers Logs quota, ADR 0001 §7). Accepted messages are counted by topic path, rejections
 * by reason with a few samples.
 */
export class IngestStats {
  private accepted = new Map<string, number>();
  private rejected = new Map<string, number>();
  private samples: RejectionSample[] = [];

  record(topic: string, result: ParseResult<InboundMessage>): void {
    if (result.ok) {
      const key = result.value.path;
      this.accepted.set(key, (this.accepted.get(key) ?? 0) + 1);
      return;
    }
    this.rejected.set(result.reason, (this.rejected.get(result.reason) ?? 0) + 1);
    if (this.samples.length < MAX_SAMPLES) {
      this.samples.push({ topic, reason: result.reason, issues: result.issues.slice(0, 5) });
    }
  }

  /** Returns the summary since the last flush (null when nothing arrived) and resets. */
  flush(): IngestSummary | null {
    if (this.accepted.size === 0 && this.rejected.size === 0) return null;
    const summary = {
      accepted: Object.fromEntries(this.accepted),
      rejected: Object.fromEntries(this.rejected),
      samples: this.samples,
    };
    this.accepted = new Map();
    this.rejected = new Map();
    this.samples = [];
    return summary;
  }
}
