/**
 * Topic namespace constants and builders (spec V3 "Topic structure"):
 * `pettracker/{device_id}/{publisher}/{category}/{topic}`.
 * Parsing an inbound topic together with its payload lives in `inbound.ts`.
 */
export const TOPIC_ROOT = "pettracker";

/** Published by the collar to the backend. */
export const BACKEND = "backend";
/** Published by the backend to the collar. */
export const DEVICE = "device";
export type Publisher = typeof BACKEND | typeof DEVICE;

/**
 * The bridge's subscriptions: everything the collars publish, plus the settings ACKs, which the
 * collar publishes under `device/settings/ack/…` (spec V3 §6, ADR 0011).
 */
export const INGEST_SUBSCRIPTIONS = [
  `${TOPIC_ROOT}/+/${BACKEND}/#`,
  `${TOPIC_ROOT}/+/${DEVICE}/settings/ack/+`,
] as const;

/** Lowercase, no spaces. Kept conservative: [a-z0-9_-], 1..64 chars. */
const DEVICE_ID_RE = /^[a-z0-9_-]{1,64}$/;

export function isValidDeviceId(deviceId: string): boolean {
  return DEVICE_ID_RE.test(deviceId);
}

/** Splits `pettracker/{device_id}/{publisher}/{path}`; null when the shape doesn't match. */
export function splitTopic(
  topic: string,
): { deviceId: string; publisher: string; path: string } | null {
  const [root, deviceId, publisher, ...rest] = topic.split("/");
  if (root !== TOPIC_ROOT || deviceId === undefined || publisher === undefined) return null;
  return { deviceId, publisher, path: rest.join("/") };
}

/**
 * True when `topic` is a concrete (no wildcards) backend→collar topic with a valid device_id
 * and at least one segment after the publisher. Settings ACKs are the collar's to publish, so
 * they are refused too. The bridge refuses to publish anywhere else.
 */
export function isPublishableDeviceTopic(topic: string): boolean {
  if (topic.includes("+") || topic.includes("#")) return false;
  const t = splitTopic(topic);
  if (!t || t.publisher !== DEVICE || !isValidDeviceId(t.deviceId)) return false;
  const segments = t.path.split("/");
  if (!segments.every((segment) => segment.length > 0)) return false;
  return !t.path.startsWith("settings/ack/");
}

/** `pettracker/{device_id}/backend/{path}`: collar → backend. */
export function backendTopic(deviceId: string, path: string): string {
  return `${TOPIC_ROOT}/${deviceId}/${BACKEND}/${path}`;
}

/** `pettracker/{device_id}/device/{path}`: backend → collar (and the collar's settings ACKs). */
export function deviceTopic(deviceId: string, path: string): string {
  return `${TOPIC_ROOT}/${deviceId}/${DEVICE}/${path}`;
}

/** Subscription a collar uses for everything addressed to it. */
export function deviceSubscription(deviceId: string): string {
  return deviceTopic(deviceId, "#");
}
