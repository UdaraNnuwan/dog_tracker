import {
  liveTopicKey,
  type InboundMessage,
  type LiveDevice,
  type LiveEvent,
  type LiveReading,
  type ParseResult,
} from "@udara/contracts";

/** Bounds memory: the public dev broker carries strangers' devices too (ADR 0003). */
const DEFAULT_MAX_DEVICES = 200;

/**
 * Latest reading per device and topic, kept in the bridge's memory for the live view
 * (ADR 0004). Sent as a snapshot to each new browser connection; every inbound message
 * becomes one `LiveEvent` to broadcast. Not persisted: history is Supabase's job (phase 4).
 */
export class LiveState {
  /** Insertion order = least recently updated first, for eviction. */
  private devices = new Map<string, Map<string, LiveReading>>();

  constructor(private readonly maxDevices = DEFAULT_MAX_DEVICES) {}

  apply(
    topic: string,
    result: ParseResult<InboundMessage>,
    retained: boolean,
    receivedAt: number,
  ): LiveEvent {
    if (!result.ok) {
      return { type: "rejected", topic, reason: result.reason, issues: result.issues, receivedAt };
    }
    const msg = result.value;
    const key = liveTopicKey(msg);

    const latest = this.devices.get(msg.deviceId) ?? new Map<string, LiveReading>();
    this.devices.delete(msg.deviceId);
    this.devices.set(msg.deviceId, latest);
    latest.set(key, { data: msg.data, receivedAt });
    if (this.devices.size > this.maxDevices) {
      const oldest = this.devices.keys().next().value;
      if (oldest !== undefined) this.devices.delete(oldest);
    }

    return { type: "message", deviceId: msg.deviceId, key, data: msg.data, receivedAt, retained };
  }

  /** Forgets one device, or all of them. */
  clear(deviceId?: string): void {
    if (deviceId === undefined) this.devices.clear();
    else this.devices.delete(deviceId);
  }

  /** Latest readings of every device, for the snapshot a new browser gets. */
  deviceList(): LiveDevice[] {
    return [...this.devices].map(([deviceId, latest]) => ({
      deviceId,
      latest: Object.fromEntries(latest),
    }));
  }
}
