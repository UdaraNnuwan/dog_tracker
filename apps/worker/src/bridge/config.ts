import type { Env } from "../env.js";

export interface MqttConfig {
  url: string;
  clientId: string;
  // Absent for brokers without auth (e.g. public broker.hivemq.com, dev only; ADR 0003).
  username?: string;
  password?: string;
  keepAliveSeconds: number;
}

/**
 * HiveMQ WebSocket endpoint (TLS, port 8884, path /mqtt). Returns null if incomplete.
 * Username and password are both set or both empty (anonymous broker); one without the other is
 * treated as a misconfiguration.
 */
export function readMqttConfig(env: Env): MqttConfig | null {
  const host = env.HIVEMQ_HOST?.trim();
  const username = env.HIVEMQ_USERNAME || undefined;
  const password = env.HIVEMQ_PASSWORD || undefined;
  const keepAliveSeconds = Number(env.MQTT_KEEPALIVE_SECONDS);
  if (!host || !env.MQTT_CLIENT_ID) return null;
  if ((username === undefined) !== (password === undefined)) return null;
  if (!Number.isInteger(keepAliveSeconds) || keepAliveSeconds < 10 || keepAliveSeconds > 600) {
    return null;
  }
  // fetch() performs the WebSocket upgrade; it takes https:// rather than wss://.
  return {
    url: `https://${host}:8884/mqtt`,
    clientId: env.MQTT_CLIENT_ID,
    ...(username !== undefined && password !== undefined ? { username, password } : {}),
    keepAliveSeconds,
  };
}
