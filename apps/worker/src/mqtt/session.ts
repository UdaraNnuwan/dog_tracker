import type { Logger } from "../log.js";
import {
  DISCONNECT,
  MqttProtocolError,
  PINGREQ,
  PacketReader,
  encodeConnect,
  encodePuback,
  encodePublish,
  encodeSubscribe,
  type ConnectOptions,
  type InboundPacket,
  type QoS,
} from "./codec.js";

/** Byte pipe the session writes to (a WebSocket in production, a fake in tests). */
export interface Transport {
  send(bytes: Uint8Array): void;
  close(): void;
}

export interface InboundMessage {
  topic: string;
  payload: Uint8Array;
  retain: boolean;
  dup: boolean;
}

export interface SessionOptions extends ConnectOptions {
  subscriptions: { filter: string; qos: QoS }[];
  maxPacketBytes: number;
  /** Must not throw; a throw is caught, logged and the message is still acknowledged. */
  onMessage: (msg: InboundMessage) => void;
  onReady: (info: { sessionPresent: boolean }) => void;
  onClosed: (reason: string) => void;
  log: Logger;
  now: () => number;
}

export type SessionState = "connecting" | "subscribing" | "ready" | "closed";

const CONNACK_TIMEOUT_MS = 30_000;

/** CONNACK return codes (MQTT 3.1.1 §3.2.2.3). */
const CONNACK_REASONS: Record<number, string> = {
  1: "unacceptable protocol version",
  2: "identifier rejected",
  3: "server unavailable",
  4: "bad user name or password",
  5: "not authorized",
};

interface Pending {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * One MQTT 3.1.1 connection lifetime: CONNECT → CONNACK → SUBSCRIBE → SUBACK → ready.
 * Not reusable; create a new session per transport. Time only advances through `tick()`.
 */
export class MqttSession {
  private _state: SessionState = "connecting";
  private readonly reader: PacketReader;
  private readonly startedAt: number;
  private lastSentAt: number;
  private pingSentAt: number | null = null;
  private sessionPresent = false;
  private nextPacketId = 1;
  private readonly inflight = new Map<number, Pending>();

  constructor(
    private readonly transport: Transport,
    private readonly opts: SessionOptions,
  ) {
    this.reader = new PacketReader(opts.maxPacketBytes);
    this.startedAt = opts.now();
    this.lastSentAt = this.startedAt;
  }

  get state(): SessionState {
    return this._state;
  }

  private isClosed(): boolean {
    return this._state === "closed";
  }

  start(): void {
    this.send(
      encodeConnect({
        clientId: this.opts.clientId,
        keepAliveSeconds: this.opts.keepAliveSeconds,
        cleanSession: this.opts.cleanSession,
        ...(this.opts.username !== undefined ? { username: this.opts.username } : {}),
        ...(this.opts.password !== undefined ? { password: this.opts.password } : {}),
      }),
    );
  }

  receive(chunk: Uint8Array): void {
    if (this._state === "closed") return;
    let packets: InboundPacket[];
    try {
      packets = this.reader.push(chunk);
    } catch (err) {
      this.close(err instanceof MqttProtocolError ? err.message : "decode failure");
      return;
    }
    for (const p of packets) {
      if (this.isClosed()) return;
      this.handle(p);
    }
  }

  /**
   * QoS 1, retain=false — fixed, not parameters (CLAUDE.md rule 2, spec §10).
   * Resolves on PUBACK; rejects if the connection drops first (the caller's
   * request_id-level retry handles redelivery, see ADR 0001).
   */
  publish(topic: string, payload: Uint8Array): Promise<void> {
    if (this._state !== "ready") return Promise.reject(new Error("mqtt not connected"));
    const packetId = this.allocatePacketId();
    return new Promise<void>((resolve, reject) => {
      this.inflight.set(packetId, { resolve, reject });
      this.send(encodePublish({ topic, payload, qos: 1, retain: false, packetId }));
    });
  }

  /** Call periodically (alarm). Handles keep-alive pings and dead-connection detection. */
  tick(): void {
    if (this._state === "closed") return;
    const now = this.opts.now();
    const keepAliveMs = this.opts.keepAliveSeconds * 1000;

    if (this._state === "connecting" && now - this.startedAt > CONNACK_TIMEOUT_MS) {
      this.close("connack timeout");
      return;
    }
    if (this.pingSentAt !== null && now - this.pingSentAt > keepAliveMs) {
      this.close("ping timeout");
      return;
    }
    if (
      this._state !== "connecting" &&
      this.pingSentAt === null &&
      now - this.lastSentAt >= keepAliveMs / 2
    ) {
      this.pingSentAt = now;
      this.send(PINGREQ);
    }
  }

  /** Idempotent. Sends DISCONNECT when `graceful`, rejects in-flight publishes, notifies once. */
  close(reason: string, graceful = false): void {
    if (this._state === "closed") return;
    this._state = "closed";
    if (graceful) {
      try {
        this.transport.send(DISCONNECT);
      } catch {
        // socket already gone
      }
    }
    for (const pending of this.inflight.values())
      pending.reject(new Error(`mqtt closed: ${reason}`));
    this.inflight.clear();
    try {
      this.transport.close();
    } catch {
      // socket already gone
    }
    this.opts.onClosed(reason);
  }

  private handle(p: InboundPacket): void {
    switch (p.type) {
      case "connack": {
        if (this._state !== "connecting") return this.close("unexpected CONNACK");
        if (p.returnCode !== 0) {
          return this.close(`connect refused: ${CONNACK_REASONS[p.returnCode] ?? p.returnCode}`);
        }
        this._state = "subscribing";
        this.sessionPresent = p.sessionPresent;
        // Re-subscribing on a persistent session is harmless and guards against a lost session.
        this.send(encodeSubscribe(this.allocatePacketId(), this.opts.subscriptions));
        return;
      }
      case "suback": {
        if (this._state !== "subscribing") return;
        if (p.returnCodes.some((rc) => rc === 0x80)) return this.close("subscription refused");
        this._state = "ready";
        this.opts.onReady({ sessionPresent: this.sessionPresent });
        return;
      }
      case "publish":
        return this.deliver(p);
      case "puback": {
        const pending = this.inflight.get(p.packetId);
        if (!pending) return; // duplicate/late PUBACK
        this.inflight.delete(p.packetId);
        pending.resolve();
        return;
      }
      case "pingresp":
        this.pingSentAt = null;
        return;
    }
  }

  private deliver(p: Extract<InboundPacket, { type: "publish" }>): void {
    try {
      this.opts.onMessage({ topic: p.topic, payload: p.payload, retain: p.retain, dup: p.dup });
    } catch (err) {
      // Rule 4: never let a handler failure break the connection.
      this.opts.log("error", "mqtt message handler threw", { topic: p.topic, error: String(err) });
    }
    if (p.qos === 1 && p.packetId !== undefined) this.send(encodePuback(p.packetId));
  }

  private allocatePacketId(): number {
    for (let i = 0; i < 0xffff; i++) {
      const id = this.nextPacketId;
      this.nextPacketId = id === 0xffff ? 1 : id + 1;
      if (!this.inflight.has(id)) return id;
    }
    throw new Error("no free MQTT packet ids");
  }

  private send(bytes: Uint8Array): void {
    this.lastSentAt = this.opts.now();
    try {
      this.transport.send(bytes);
    } catch (err) {
      this.close(`send failed: ${String(err)}`);
    }
  }
}
