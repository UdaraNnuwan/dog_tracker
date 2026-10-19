/**
 * Topic namespace constants and builders (spec §2, §12, §16).
 * Parsing an inbound topic together with its payload lives in `inbound.ts`.
 */
export const TOPIC_ROOT = "pettracker";

/** device → cloud */
export const BACKEND_PREFIX = `${TOPIC_ROOT}/backend/`;
/** cloud → device */
export const DEVICE_PREFIX = `${TOPIC_ROOT}/device/`;

/** The bridge's only subscription (spec §12, backend row). */
export const INGEST_SUBSCRIPTION = `${TOPIC_ROOT}/backend/#`;

/** Lowercase, no spaces (spec §2). Kept conservative: [a-z0-9_-], 1..64 chars. */
const DEVICE_ID_RE = /^[a-z0-9_-]{1,64}$/;

export function isValidDeviceId(deviceId: string): boolean {
  return DEVICE_ID_RE.test(deviceId);
}

/**
 * True when `topic` is a concrete (no wildcards) cloud→device topic with a valid
 * device_id and at least one segment after it. The bridge refuses to publish anywhere else.
 */
export function isPublishableDeviceTopic(topic: string): boolean {
  if (!topic.startsWith(DEVICE_PREFIX)) return false;
  if (topic.includes("+") || topic.includes("#")) return false;
  const [deviceId, ...rest] = topic.slice(DEVICE_PREFIX.length).split("/");
  if (deviceId === undefined || !isValidDeviceId(deviceId)) return false;
  return rest.length > 0 && rest.every((segment) => segment.length > 0);
}

/** `pettracker/backend/{device_id}/{path}`: device → cloud. */
export function backendTopic(deviceId: string, path: string): string {
  return `${BACKEND_PREFIX}${deviceId}/${path}`;
}

/** `pettracker/device/{device_id}/{path}`: cloud → device. */
export function deviceTopic(deviceId: string, path: string): string {
  return `${DEVICE_PREFIX}${deviceId}/${path}`;
}

/** Subscription a collar uses for everything addressed to it (spec §12, device row). */
export function deviceSubscription(deviceId: string): string {
  return deviceTopic(deviceId, "#");
}
