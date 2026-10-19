import type { RequestState, RequestStatus } from "@udara/contracts";

/** Rule 3: wait this long for the device's response before retrying. */
export const ACK_TIMEOUT_MS = 10_000;
/** Rule 3: up to 2 retries, always with the same request_id. */
export const MAX_RETRIES = 2;
/** Rule 3: 5–10 s between a timed-out attempt and its retry. */
export const backoffMs = (random: () => number) => 5_000 + Math.round(random() * 5_000);
/** Finished requests kept for snapshots. */
const KEEP = 50;

export interface NewRequest {
  requestId: string;
  deviceId: string;
  path: string;
  responsePath: string;
  /** JSON text to publish. */
  payload: string;
}

export type TrackerEvent = "sent" | "retry" | "response" | "duplicate" | "timeout";

export interface TrackerIO {
  /** Publishes one attempt; rejects when it could not be sent (e.g. broker down). */
  send(req: RequestStatus): Promise<void>;
  /** Every state change, including each retry. */
  onUpdate(req: RequestStatus, event: TrackerEvent): void;
  now(): number;
  random(): number;
}

/** `command/x` → `response/x`; `settings/{set,get}/s` → `settings/response/s` (spec §7, §8). */
export function responsePathFor(path: string): string | null {
  const [kind, a, b] = path.split("/");
  if (kind === "command" && a && b === undefined) return `response/${a}`;
  if (kind === "settings" && (a === "set" || a === "get") && b) return `settings/response/${b}`;
  return null;
}

const FINAL_FROM_RESPONSE = new Set<RequestState>(["success", "failed", "rejected", "unsupported"]);

/**
 * Tracks command/settings requests until the device answers (rule 3): ack timeout, retries
 * with the same request_id and backoff, then `timeout`. Responses are matched and deduped by
 * request_id (spec §7, rule 6): a second answer to a finished request changes nothing.
 * Only in memory: a bridge restart forgets pending requests (persisting them is phase 8).
 */
export class RequestTracker {
  private requests = new Map<string, RequestStatus>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly io: TrackerIO) {}

  async start(input: NewRequest): Promise<RequestStatus> {
    const now = this.io.now();
    const req: RequestStatus = {
      ...input,
      state: "pending",
      attempts: 0,
      sentAt: now,
      updatedAt: now,
      response: null,
      error: null,
    };
    this.requests.set(req.requestId, req);
    this.trim();
    await this.attempt(req, "sent");
    return { ...req };
  }

  /**
   * Feeds a validated inbound message. Returns true when it answered a known request
   * (also for duplicates), so the caller can log it as such.
   */
  handleResponse(deviceId: string, path: string, data: Record<string, unknown>): boolean {
    const requestId = data.request_id;
    if (typeof requestId !== "string") return false;
    const req = this.requests.get(requestId);
    if (!req || req.deviceId !== deviceId || req.responsePath !== path) return false;
    if (req.state !== "pending") {
      this.io.onUpdate({ ...req }, "duplicate");
      return true;
    }
    const status = data.status;
    req.state =
      typeof status === "string" && FINAL_FROM_RESPONSE.has(status as RequestState)
        ? (status as RequestState)
        : "failed";
    req.response = JSON.stringify(data);
    req.updatedAt = this.io.now();
    this.clearTimer(requestId);
    this.io.onUpdate({ ...req }, "response");
    return true;
  }

  /** Newest first. */
  list(): RequestStatus[] {
    return [...this.requests.values()].reverse().map((r) => ({ ...r }));
  }

  /** Drops pending timers, e.g. before the object goes away. */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private async attempt(req: RequestStatus, event: "sent" | "retry"): Promise<void> {
    req.attempts++;
    req.updatedAt = this.io.now();
    try {
      await this.io.send(req);
    } catch (err) {
      req.state = "error";
      req.error = String(err instanceof Error ? err.message : err);
      this.io.onUpdate({ ...req }, event);
      return;
    }
    // The response may already have arrived while the publish was in flight.
    if (req.state !== "pending") return;
    this.io.onUpdate({ ...req }, event);
    this.timers.set(
      req.requestId,
      setTimeout(() => this.onAckTimeout(req), ACK_TIMEOUT_MS),
    );
  }

  private onAckTimeout(req: RequestStatus): void {
    this.timers.delete(req.requestId);
    if (req.state !== "pending") return;
    if (req.attempts > MAX_RETRIES) {
      req.state = "timeout";
      req.updatedAt = this.io.now();
      this.io.onUpdate({ ...req }, "timeout");
      return;
    }
    this.timers.set(
      req.requestId,
      setTimeout(
        () => {
          this.timers.delete(req.requestId);
          if (req.state === "pending") void this.attempt(req, "retry");
        },
        backoffMs(() => this.io.random()),
      ),
    );
  }

  private clearTimer(requestId: string): void {
    const t = this.timers.get(requestId);
    if (t) clearTimeout(t);
    this.timers.delete(requestId);
  }

  /** Keeps every pending request and the newest finished ones. */
  private trim(): void {
    if (this.requests.size <= KEEP) return;
    for (const [id, r] of this.requests) {
      if (this.requests.size <= KEEP) break;
      if (r.state !== "pending") this.requests.delete(id);
    }
  }
}
