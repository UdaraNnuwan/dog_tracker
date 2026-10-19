import type { InboundMessage, RejectReason } from "./inbound.js";

/**
 * Messages the `MqttBridge` sends to browsers on the `/api/live` WebSocket.
 * Times are epoch seconds (rule 5).
 */

/** `path` as it appears in the topic, e.g. `telemetry/gps` or `settings/response/gps_interval`. */
export type LiveTopicKey = string;

export interface LiveReading {
  data: InboundMessage["data"];
  receivedAt: number;
}

export interface LiveDevice {
  deviceId: string;
  latest: Record<LiveTopicKey, LiveReading>;
}

export type LiveEvent =
  | { type: "snapshot"; devices: LiveDevice[] }
  | {
      type: "message";
      deviceId: string;
      key: LiveTopicKey;
      data: InboundMessage["data"];
      receivedAt: number;
      retained: boolean;
    }
  | {
      type: "rejected";
      topic: string;
      reason: RejectReason;
      issues: string[];
      receivedAt: number;
    };

/** Topic key of a validated message (adds the setting name for settings responses). */
export function liveTopicKey(msg: InboundMessage): LiveTopicKey {
  return msg.path === "settings/response" ? `${msg.path}/${msg.setting}` : msg.path;
}
