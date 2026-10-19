import { DurableObject } from "cloudflare:workers";
import {
  INGEST_SUBSCRIPTION,
  deviceTopic,
  isPublishableDeviceTopic,
  liveTopicKey,
  parseInbound,
  type DemoStatus,
  type LiveEvent,
  type PipelineLog,
  type RequestStatus,
} from "@udara/contracts";
import type { Env } from "../env.js";
import { log } from "../log.js";
import { describeFrame, frameToBytes } from "../mqtt/frames.js";
import { MqttSession } from "../mqtt/session.js";
import { MAX_BACKOFF_ATTEMPT, reconnectDelayMs } from "./backoff.js";
import { readMqttConfig } from "./config.js";
import { DemoRun, IDLE_DEMO, demoOptions } from "./demo.js";
import { IngestStats } from "./ingestStats.js";
import { LiveState } from "./liveState.js";
import { PipelineLogger, describeInbound } from "./pipelineLog.js";
import {
  MAX_RETRIES,
  RequestTracker,
  responsePathFor,
  type NewRequest,
  type TrackerEvent,
} from "./requests.js";
import type { Json, TablesInsert } from "@udara/db-types";
import { IngestBuffer, type Batch } from "../storage/IngestBuffer.js";
import { serviceClient, type Db } from "../storage/supabase.js";

/** The bridge is a singleton (CLAUDE.md rule 10). */
export const BRIDGE_ID = "main";

/** Alarm cadence: drives keep-alive pings and revives the bridge after eviction. */
const TICK_MS = 15_000;
/** Inbound packets above this are a protocol error (rule 4: max size). */
const MAX_INBOUND_PACKET_BYTES = 64 * 1024;
const MAX_OUTBOUND_PAYLOAD_BYTES = 16 * 1024;
/** Rule 10: batch writes to Supabase, flushing every 5–10 s. */
const FLUSH_DELAY_MS = 5_000;

export type BridgeState = "idle" | "unconfigured" | "connecting" | "ready" | "backoff";

/** `disabled`: no SUPABASE_URL / SUPABASE_SECRET_KEY. `failing`: last flush failed, rows kept. */
export type StorageState = "disabled" | "ok" | "failing";

/** Times are epoch seconds (rule 5). */
export interface BridgeStatus {
  state: BridgeState;
  connectedSince: number | null;
  lastMessageAt: number | null;
  messagesReceived: number;
  reconnects: number;
  lastError: string | null;
  storage: {
    state: StorageState;
    pending: number;
    lastFlushAt: number | null;
    rowsWritten: number;
    dropped: number;
    lastError: string | null;
  };
}

const encoder = new TextEncoder();
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The only MQTT client in the system. Holds one outbound WebSocket to HiveMQ Cloud,
 * subscribes to `pettracker/backend/#` and is the only place that publishes.
 *
 * Inbound messages are validated against `@udara/contracts`, summarised per tick, fanned
 * out to browsers on `/api/live` (WebSocket Hibernation API, ADR 0004) and batched into
 * Supabase through `ingest_batch` (ADR 0006).
 */
export class MqttBridge extends DurableObject<Env> {
  private state: BridgeState = "idle";
  private session: MqttSession | null = null;
  private attempt = 0;
  private nextReconnectAt = 0;
  private connectedSince: number | null = null;
  private lastMessageAt: number | null = null;
  private messagesReceived = 0;
  private reconnects = 0;
  private lastError: string | null = null;
  /** Accepted/rejected counts since the last tick, for the summary log line. */
  private ingestStats = new IngestStats();
  /** Latest reading per device/topic for `/api/live` (ADR 0004). */
  private live = new LiveState();
  /** Rows waiting for the next Supabase flush (ADR 0006). */
  private buffer = new IngestBuffer();
  private db: Db | null | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private storageState: StorageState = "ok";
  private lastFlushAt: number | null = null;
  private rowsWritten = 0;
  private storageError: string | null = null;
  /** Processing log: live to browsers, saved to `pipeline_logs` (ADR 0008). */
  private logs = new PipelineLogger(nowSeconds);
  private demo: DemoRun | null = null;
  /** Command/settings requests waiting for the device's answer (rule 3). */
  private requests = new RequestTracker({
    send: (req) => this.sendAttempt(req),
    onUpdate: (req, event) => this.onRequestUpdate(req, event),
    now: nowSeconds,
    random: Math.random,
  });

  // ------------------------------------------------------------ RPC surface

  status(): BridgeStatus {
    return {
      state: this.state,
      connectedSince: this.connectedSince,
      lastMessageAt: this.lastMessageAt,
      messagesReceived: this.messagesReceived,
      reconnects: this.reconnects,
      lastError: this.lastError,
      storage: {
        state: this.storage() ? this.storageState : "disabled",
        pending: this.buffer.size,
        lastFlushAt: this.lastFlushAt,
        rowsWritten: this.rowsWritten,
        dropped: this.buffer.dropped,
        lastError: this.storageError,
      },
    };
  }

  /**
   * Forgets buffered rows and live state for one device or all, before the Worker clears the
   * stored history, so nothing old is written back afterwards.
   */
  async clearLocal(deviceId?: string): Promise<void> {
    await this.flushing;
    this.buffer.clear(deviceId);
    this.live.clear(deviceId);
    this.logs.clear(deviceId);
  }

  // ------------------------------------------------------------ demo run (ADR 0008)

  /** Starts fake collars feeding the inbound pipeline; replaces a running demo. */
  startDemo(input: { devices?: unknown; seconds?: unknown } = {}): DemoStatus {
    this.demo?.stop();
    const opts = demoOptions(input);
    const run: DemoRun = new DemoRun(
      opts,
      (topic, payload) => this.handleInbound(topic, payload, false),
      () => {
        this.emit(this.logs.system("info", "demo", "demo finished", { detail: { ...opts } }));
        this.broadcast({ type: "demo", demo: this.demoStatus() });
      },
    );
    this.demo = run;
    this.emit(
      this.logs.system("info", "demo", `demo started: ${run.devices.join(", ")}`, {
        detail: { ...opts },
      }),
    );
    run.start();
    this.broadcast({ type: "demo", demo: this.demoStatus() });
    return this.demoStatus();
  }

  stopDemo(): DemoStatus {
    this.demo?.stop();
    return this.demoStatus();
  }

  demoStatus(): DemoStatus {
    return this.demo?.status() ?? IDLE_DEMO;
  }

  /** Called by the cron watchdog. Starts the bridge if needed; respects reconnect backoff. */
  async ensureConnected(): Promise<BridgeStatus> {
    if (this.canConnectNow()) await this.openConnection();
    await this.ensureAlarm();
    return this.status();
  }

  /** QoS 1, retain=false, cloud→device namespace only (rule 2). Resolves on PUBACK. */
  async publish(topic: string, payload: string): Promise<void> {
    if (!isPublishableDeviceTopic(topic)) {
      throw new Error(`refusing to publish outside the device namespace: ${topic}`);
    }
    const bytes = encoder.encode(payload);
    if (bytes.length > MAX_OUTBOUND_PAYLOAD_BYTES) throw new Error("payload too large");
    if (!this.session || this.state !== "ready") throw new Error("mqtt not connected");
    await this.session.publish(topic, bytes);
  }

  // ------------------------------------------------------------ commands & settings (rule 3)

  /**
   * Publishes a command or settings request built and validated by the Worker (with a
   * backend-generated UUID request_id) and tracks it until the device answers, retrying with
   * the same request_id. Demo collars get it directly; everything else goes over MQTT.
   */
  async sendRequest(input: Omit<NewRequest, "responsePath">): Promise<RequestStatus> {
    const responsePath = responsePathFor(input.path);
    if (!responsePath) throw new Error(`not a command or settings path: ${input.path}`);
    return this.requests.start({ ...input, responsePath });
  }

  requestList(): RequestStatus[] {
    return this.requests.list();
  }

  private async sendAttempt(req: RequestStatus): Promise<void> {
    const topic = deviceTopic(req.deviceId, req.path);
    if (this.demo?.deliver(req.deviceId, topic, req.payload)) return;
    await this.publish(topic, req.payload);
  }

  private onRequestUpdate(req: RequestStatus, event: TrackerEvent): void {
    this.broadcast({ type: "request", request: req });
    const total = MAX_RETRIES + 1;
    const line = (level: PipelineLog["level"], message: string, json: string | null) =>
      this.emit(
        this.logs.line({
          level,
          source: "bridge",
          deviceId: req.deviceId,
          topic: req.path,
          message,
          detail: {
            request_id: req.requestId,
            topic: deviceTopic(req.deviceId, req.path),
            attempts: req.attempts,
            payload: json,
          },
        }),
      );
    if (req.state === "error") {
      line("error", `not sent: ${req.error ?? "unknown error"}`, req.payload);
      return;
    }
    switch (event) {
      case "sent":
        line(
          "info",
          `published (attempt 1/${total}), waiting for ${req.responsePath}`,
          req.payload,
        );
        break;
      case "retry":
        line(
          "warn",
          `no answer in 10 s, retry ${req.attempts}/${total} (same request_id)`,
          req.payload,
        );
        break;
      case "timeout":
        line("error", `timeout: no answer after ${req.attempts} attempts`, req.payload);
        break;
      case "response":
        line(req.state === "success" ? "info" : "warn", `answered: ${req.state}`, req.response);
        break;
      case "duplicate":
        line("info", "duplicate answer ignored (rule 6)", req.response);
        break;
    }
  }

  // ------------------------------------------------------------ live view (ADR 0004)

  /** Browser WebSocket for `/api/live`. Access control happens in the Worker route. */
  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const snapshot: LiveEvent = {
      type: "snapshot",
      devices: this.live.deviceList(),
      logs: this.logs.recent(),
      demo: this.demoStatus(),
      requests: this.requests.list(),
    };
    server.send(JSON.stringify(snapshot));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Browsers only listen; anything they send is ignored. */
  override webSocketMessage(): void {}

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code, "closing");
    } catch {
      // Already closed (automatic close reply on recent compatibility dates).
    }
  }

  private broadcast(event: LiveEvent): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const text = JSON.stringify(event);
    for (const ws of sockets) {
      try {
        ws.send(text);
      } catch {
        // Socket is closing; the runtime removes it from getWebSockets().
      }
    }
  }

  // ------------------------------------------------------------ inbound pipeline

  /**
   * Every inbound message, from MQTT or the demo: validate (never throws, rule 4), buffer for
   * storage, update live state, and log what happened.
   */
  private handleInbound(topic: string, payload: Uint8Array | string, retained: boolean): void {
    const receivedAt = nowSeconds();
    const result = parseInbound(topic, payload);
    this.ingestStats.record(topic, result);
    let outcome: ReturnType<IngestBuffer["add"]> = "storage_off";
    if (this.storage()) {
      outcome = this.buffer.add(topic, result, retained, receivedAt);
      this.scheduleFlush();
    }
    this.broadcast(this.live.apply(topic, result, retained, receivedAt));
    this.emit(this.logs.line(describeInbound(topic, result, outcome, payload)));
    if (result.ok) {
      const msg = result.value;
      const key = liveTopicKey(msg);
      if (key.startsWith("response/") || key.startsWith("settings/response/")) {
        this.requests.handleResponse(msg.deviceId, key, msg.data);
      }
    }
  }

  /** Sends a log line to browsers and queues it for `pipeline_logs`. */
  private emit(entry: PipelineLog): void {
    this.broadcast({ type: "log", entry });
    if (this.storage()) {
      this.buffer.addLog(entry);
      this.scheduleFlush();
    }
  }

  // ------------------------------------------------------------ lifecycle

  override async alarm(): Promise<void> {
    if (this.session) this.session.tick();
    else if (this.canConnectNow()) await this.openConnection();
    this.flushIngestLog();
    await this.flush();
    await this.scheduleAlarm();
  }

  // ------------------------------------------------------------ storage (ADR 0006)

  private storage(): Db | null {
    if (this.db === undefined) {
      this.db = serviceClient(this.env);
      if (!this.db) log("warn", "storage disabled: set SUPABASE_URL and SUPABASE_SECRET_KEY");
    }
    return this.db;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.ctx.waitUntil(this.flush());
    }, FLUSH_DELAY_MS);
  }

  /**
   * Writes everything buffered: messages in one `ingest_batch` call, then log lines. On failure
   * the unwritten rows are kept for the next flush.
   */
  private flush(): Promise<void> {
    this.flushing ??= this.writeBatch().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async writeBatch(): Promise<void> {
    const db = this.storage();
    if (!db || this.buffer.size === 0) return;
    const batch: Batch = this.buffer.drain();
    let pending: Batch = batch;
    try {
      if (batch.messages.length || batch.rejected.length) {
        const { error } = await db.rpc("ingest_batch", {
          p_messages: batch.messages as unknown as Json,
          p_rejected: batch.rejected as unknown as Json,
        });
        if (error) throw new Error(error.message);
        this.rowsWritten += batch.messages.length + batch.rejected.length;
      }
      // Messages are in; only the log lines are left to retry from here.
      pending = { messages: [], rejected: [], logs: batch.logs };
      if (batch.logs.length) {
        const { error } = await db
          .from("pipeline_logs")
          .insert(batch.logs as unknown as TablesInsert<"pipeline_logs">[]);
        if (error) throw new Error(`pipeline_logs: ${error.message}`);
        this.rowsWritten += batch.logs.length;
      }
      this.lastFlushAt = nowSeconds();
      if (this.storageState !== "ok") {
        log("info", "storage recovered");
        this.emit(this.logs.system("info", "storage", "storage recovered"));
      }
      this.storageState = "ok";
      this.storageError = null;
    } catch (err) {
      this.buffer.restore(pending);
      this.storageError = String(err);
      log("error", "storage flush failed", { error: this.storageError, pending: this.buffer.size });
      // One line per outage, not per retry: the line itself is retried with the batch.
      if (this.storageState !== "failing") {
        this.emit(
          this.logs.system("error", "storage", "storage flush failed, retrying", {
            detail: { error: this.storageError },
          }),
        );
      }
      this.storageState = "failing";
      this.scheduleFlush();
    }
  }

  private canConnectNow(): boolean {
    if (this.session || this.state === "connecting") return false;
    return this.state !== "backoff" || Date.now() >= this.nextReconnectAt;
  }

  private async openConnection(): Promise<void> {
    const cfg = readMqttConfig(this.env);
    if (!cfg) {
      if (this.state !== "unconfigured")
        log("error", "mqtt bridge unconfigured: check HIVEMQ_* secrets");
      this.state = "unconfigured";
      return;
    }
    this.state = "connecting"; // set before the first await: blocks concurrent connects

    let ws: WebSocket;
    try {
      const res = await fetch(cfg.url, {
        headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "mqtt" },
      });
      if (!res.webSocket) throw new Error(`websocket upgrade failed: HTTP ${res.status}`);
      ws = res.webSocket;
      ws.accept();
      // Recent compatibility dates default to "blob" (WHATWG); Blob needs an async read,
      // which would break in-order packet processing.
      ws.binaryType = "arraybuffer";
    } catch (err) {
      await this.scheduleReconnect(`connect failed: ${String(err)}`);
      return;
    }

    const session = new MqttSession(
      {
        send: (bytes) => ws.send(bytes),
        close: () => ws.close(1000, "closing"),
      },
      {
        clientId: cfg.clientId,
        ...(cfg.username !== undefined ? { username: cfg.username } : {}),
        ...(cfg.password !== undefined ? { password: cfg.password } : {}),
        keepAliveSeconds: cfg.keepAliveSeconds,
        cleanSession: false,
        subscriptions: [{ filter: INGEST_SUBSCRIPTION, qos: 1 }],
        maxPacketBytes: MAX_INBOUND_PACKET_BYTES,
        now: Date.now,
        log,
        onReady: ({ sessionPresent }) => {
          this.state = "ready";
          this.attempt = 0;
          this.lastError = null;
          this.connectedSince = nowSeconds();
          log("info", "mqtt bridge ready", { session_present: sessionPresent });
          this.emit(
            this.logs.system("info", "bridge", "connected to broker", {
              detail: { session_present: sessionPresent },
            }),
          );
        },
        onClosed: (reason) => {
          if (this.session !== session) return;
          this.session = null;
          this.connectedSince = null;
          this.ctx.waitUntil(this.scheduleReconnect(reason));
        },
        onMessage: (msg) => {
          this.messagesReceived++;
          this.lastMessageAt = nowSeconds();
          this.handleInbound(msg.topic, msg.payload, msg.retain);
        },
      },
    );

    ws.addEventListener("message", (event) => {
      const data: unknown = event.data;
      const bytes = frameToBytes(data);
      if (!bytes) {
        session.close(`unexpected websocket frame: ${describeFrame(data)}`);
        return;
      }
      session.receive(bytes);
    });
    ws.addEventListener("close", (event) => session.close(`socket closed (${event.code})`));
    ws.addEventListener("error", () => session.close("socket error"));

    this.session = session;
    session.start();
  }

  private async scheduleReconnect(reason: string): Promise<void> {
    // Credentials won't fix themselves: back off to the maximum right away.
    if (reason.startsWith("connect refused"))
      this.attempt = Math.max(this.attempt, MAX_BACKOFF_ATTEMPT);
    const delay = reconnectDelayMs(this.attempt);
    this.attempt++;
    this.reconnects++;
    this.state = "backoff";
    this.lastError = reason;
    this.nextReconnectAt = Date.now() + delay;
    log("warn", "mqtt bridge disconnected", { reason, retry_in_ms: delay });
    this.emit(
      this.logs.system(
        "warn",
        "bridge",
        `disconnected, retrying in ${Math.round(delay / 1000)} s`,
        {
          detail: { reason },
        },
      ),
    );
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > this.nextReconnectAt) {
      await this.ctx.storage.setAlarm(this.nextReconnectAt);
    }
  }

  private async scheduleAlarm(): Promise<void> {
    let next = Date.now() + TICK_MS;
    if (this.state === "backoff") next = Math.min(next, this.nextReconnectAt);
    await this.ctx.storage.setAlarm(next);
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.scheduleAlarm();
  }

  private flushIngestLog(): void {
    const summary = this.ingestStats.flush();
    if (!summary) return;
    log(Object.keys(summary.rejected).length ? "warn" : "info", "mqtt ingest", { ...summary });
  }
}
