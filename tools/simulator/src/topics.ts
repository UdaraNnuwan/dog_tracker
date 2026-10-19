import {
  COMMANDS,
  INBOUND_TOPICS,
  SETTINGS_RESPONSE_TOPIC,
  formatIssues,
  isCommandName,
  isSettingName,
  parseInbound,
  schemas,
  type InboundTopicPath,
} from "@udara/contracts";

export type Direction = "backend" | "device";

export interface TopicSpec {
  direction: Direction;
  /** Path after `pettracker/{direction}/{device_id}/`. */
  path: string;
  qos: 0 | 1;
  retain: boolean;
}

/** `backend/telemetry/gps` (file path without .csv) → topic spec, or an error message. */
export function topicFromFile(relative: string): TopicSpec | string {
  const [direction, ...rest] = relative
    .replace(/\\/g, "/")
    .replace(/\.csv$/, "")
    .split("/");
  const path = rest.join("/");
  if (direction === "backend") {
    if (Object.hasOwn(INBOUND_TOPICS, path)) {
      const e = INBOUND_TOPICS[path as InboundTopicPath];
      return { direction, path, qos: e.qos, retain: e.retain === true };
    }
    const setting = path.match(/^settings\/response\/(.+)$/)?.[1];
    if (setting !== undefined) {
      return { direction, path, qos: SETTINGS_RESPONSE_TOPIC.qos, retain: false };
    }
    return `unknown backend topic "${path}"`;
  }
  if (direction === "device") {
    const [kind, a = "", b] = path.split("/");
    if (kind === "command" && isCommandName(a) && b === undefined) {
      return { direction, path, qos: 1, retain: false };
    }
    if (kind === "settings" && (a === "set" || a === "get") && b) {
      return { direction, path, qos: 1, retain: false };
    }
    return `unknown device topic "${path}"`;
  }
  return `first folder must be "backend" or "device", got "${direction}"`;
}

/**
 * Validates a payload with the same contracts the bridge (backend topics) and the collar
 * (device topics) use. Returns issues; empty means valid.
 */
export function validatePayload(
  spec: TopicSpec,
  deviceId: string,
  payload: Record<string, unknown>,
): string[] {
  if (spec.direction === "backend") {
    const r = parseInbound(`pettracker/backend/${deviceId}/${spec.path}`, JSON.stringify(payload));
    return r.ok ? [] : [r.reason, ...r.issues];
  }
  const [kind, a = "", b = ""] = spec.path.split("/");
  const schema =
    kind === "command" && isCommandName(a)
      ? COMMANDS[a]
      : a === "get"
        ? schemas.settingsGet
        : isSettingName(b)
          ? schemas.settingsSet(b)
          : null;
  if (!schema) return [`unknown setting "${b}"`];
  const r = schema.safeParse(payload);
  return r.success ? [] : formatIssues(r.error);
}
