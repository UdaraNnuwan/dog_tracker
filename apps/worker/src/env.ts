import type { MqttBridge } from "./bridge/MqttBridge.js";

export interface Env {
  ASSETS: Fetcher;
  MQTT_BRIDGE: DurableObjectNamespace<MqttBridge>;

  // vars (wrangler.jsonc)
  MQTT_CLIENT_ID: string;
  MQTT_KEEPALIVE_SECONDS: string;
  /** "true" opens /api/live without login. `.env` only, never deployed (ADR 0004). */
  LIVE_VIEW_UNAUTHENTICATED?: string;

  // secrets (`wrangler secret put` / .env) — optional so a missing one degrades to
  // bridge state "unconfigured" instead of crashing.
  HIVEMQ_HOST?: string;
  HIVEMQ_USERNAME?: string;
  HIVEMQ_PASSWORD?: string;
  // Supabase ingestion (phase 4). the secret key bypasses RLS: Worker-only, never in the frontend.
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
}
