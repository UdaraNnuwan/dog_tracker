import {
  COMMANDS,
  DEVICE_PREFIX,
  PROTOCOL_VERSION,
  SETTINGS,
  formatIssues,
  isCommandName,
  isSettingName,
  type CommandName,
  type SettingName,
} from "@udara/contracts";
import { bearing, distanceM, offset, round, type LatLon } from "./geo.js";

export interface PublishOptions {
  qos: 0 | 1;
  retain: boolean;
}

/** Everything the device needs from the outside world, so tests can drive it with fakes. */
export interface DeviceIO {
  /** `path` is relative to `pettracker/backend/{device_id}/`. */
  publish(path: string, payload: Record<string, unknown>, opts: PublishOptions): void;
  log(msg: string): void;
  random(): number;
}

export interface DeviceOptions {
  deviceId: string;
  home: LatLon;
  /** Telemetry period until a `gps_interval` setting is applied (demo speed). */
  intervalS: number;
  /** Probability a command/setting fails with status=failed. */
  failRate: number;
  /** Probability a response is published twice (exercises QoS 1 dedupe, rule 6). */
  duplicateRate: number;
  responseDelayMs: { min: number; max: number };
}

const GEOFENCE_ID = "home";
const GEOFENCE_RADIUS_M = 150;
/** Wander radius; beyond it the dog heads back home. */
const ROAM_RADIUS_M = 300;
const LOW_BATTERY_PCT = 15;
/** Spec §7.5: devices keep processed request_ids for at least 5 minutes. */
const REQUEST_CACHE_MS = 5 * 60_000;

const QOS0 = { qos: 0, retain: false } as const;
const QOS1 = { qos: 1, retain: false } as const;

interface CachedResponse {
  path: string;
  body: Record<string, unknown>;
  at: number;
}

/**
 * One fake collar (spec §4–§11): periodic telemetry, geofence and low-battery events,
 * command/settings responses with configurable delay, failures and duplicates, and
 * idempotent handling of repeated request_ids (§7.4). MQTT is handled by the caller.
 */
export class SimDevice {
  readonly id: string;
  private pos: LatLon;
  private heading: number;
  private speed = 0;
  private battery: number;
  private charging = false;
  private lowBatterySent = false;
  private insideGeofence = true;
  private rssi = -75;
  /** Battery temperature, °C (spec §5.2, optional field). */
  private temperature = 30;
  private bootedAt = Date.now();
  private sleepMode = "none";
  private settings: { [S in SettingName]: number } = { gps_interval: 30 };
  private gpsIntervalApplied = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handled = new Map<string, CachedResponse>();

  constructor(
    private readonly opts: DeviceOptions,
    private readonly io: DeviceIO,
  ) {
    this.id = opts.deviceId;
    this.pos = { ...opts.home };
    this.heading = io.random() * 360;
    this.battery = 60 + io.random() * 40;
  }

  /** Current position, rounded like the GPS telemetry. */
  get position(): LatLon {
    return { latitude: round(this.pos.latitude, 6), longitude: round(this.pos.longitude, 6) };
  }

  /** Telemetry period in ms: the gps_interval setting once one was applied, else the demo interval. */
  get tickMs(): number {
    return (this.gpsIntervalApplied ? this.settings.gps_interval : this.opts.intervalS) * 1000;
  }

  /** Call after every (re)connect: announces the device and starts telemetry. */
  start(): void {
    this.publish("status/connectivity", { status: "online" }, { qos: 1, retain: true });
    this.publishSystemStatus("power_on");
    this.publish("status/network", {
      connected: true,
      network_type: "lte",
      operator: "sim_operator",
      ip_address: `10.0.0.${1 + Math.floor(this.io.random() * 250)}`,
    });
    this.tick();
    this.schedule();
  }

  /** Graceful shutdown: the broker's Last Will only fires on unexpected disconnects. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.io.publish("status/connectivity", { status: "offline" }, { qos: 1, retain: true });
  }

  tick(): void {
    this.move();
    this.updateBattery();
    this.rssi = Math.max(-110, Math.min(-55, this.rssi + (this.io.random() - 0.5) * 6));

    this.publish("telemetry/gps", {
      latitude: round(this.pos.latitude, 6),
      longitude: round(this.pos.longitude, 6),
      speed: round(this.speed, 2),
      accuracy: round(3 + this.io.random() * 4, 1),
      satellites: 7 + Math.floor(this.io.random() * 6),
    });
    this.publish("telemetry/battery", {
      voltage: round(3.3 + (this.battery / 100) * 0.9, 2),
      percentage: Math.round(this.battery),
      charging: this.charging,
      temperature: round(this.temperature, 1),
    });
    this.publish("telemetry/signal_strength", {
      rssi: Math.round(this.rssi),
      rsrp: Math.round(this.rssi - 22),
      rsrq: -8 - Math.round(this.io.random() * 6),
      sinr: 5 + Math.round(this.io.random() * 15),
    });
    const jitter = () => round((this.io.random() - 0.5) * (0.2 + this.speed), 2);
    this.publish("telemetry/imu", {
      accelerometer: { x: jitter(), y: jitter(), z: round(9.81 + jitter(), 2) },
      gyroscope: { x: jitter() * 10, y: jitter() * 10, z: jitter() * 10 },
    });
  }

  /** Handles a message on `pettracker/device/{id}/…`; ignores everything else. */
  handleMessage(topic: string, raw: string): void {
    const prefix = `${DEVICE_PREFIX}${this.id}/`;
    if (!topic.startsWith(prefix)) return;
    const path = topic.slice(prefix.length);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.io.log(`${this.id}: ignoring non-JSON message on ${path}`);
      return;
    }
    const requestId = (json as { request_id?: unknown } | null)?.request_id;
    if (typeof requestId !== "string" || !requestId) {
      this.io.log(`${this.id}: ignoring ${path} without request_id`);
      return;
    }

    // Spec §7.4: a repeated request_id returns the previous result, no repeated action.
    this.expireCache();
    const cached = this.handled.get(requestId);
    if (cached) {
      this.respond(cached.path, cached.body);
      return;
    }

    const response = this.process(path, json, requestId);
    if (!response) return;
    this.handled.set(requestId, { ...response, at: Date.now() });
    this.respond(response.path, response.body);
  }

  // ------------------------------------------------------------ commands

  private process(
    path: string,
    json: unknown,
    requestId: string,
  ): { path: string; body: Record<string, unknown> } | null {
    const [kind, a = "", b = ""] = path.split("/");
    if (kind === "command" && isCommandName(a)) {
      return { path: `response/${a}`, body: this.runCommand(a, json, requestId) };
    }
    if (kind === "settings" && (a === "set" || a === "get")) {
      return { path: `settings/response/${b}`, body: this.runSetting(a, b, json, requestId) };
    }
    this.io.log(`${this.id}: unsupported topic ${path}`);
    return null;
  }

  private runCommand(name: CommandName, json: unknown, requestId: string) {
    const parsed = COMMANDS[name].safeParse(json);
    if (!parsed.success) {
      return {
        request_id: requestId,
        status: "rejected",
        error_code: "invalid_payload",
        message: formatIssues(parsed.error).join("; "),
      };
    }
    if (this.io.random() < this.opts.failRate) {
      return {
        request_id: requestId,
        status: "failed",
        error_code: `${name}_failed`,
        message: "simulated failure",
      };
    }
    switch (name) {
      case "location":
        return {
          request_id: requestId,
          status: "success",
          latitude: round(this.pos.latitude, 6),
          longitude: round(this.pos.longitude, 6),
        };
      case "reboot":
        // Spec §7: acknowledge before restarting.
        setTimeout(() => {
          this.bootedAt = Date.now();
          this.publishSystemStatus("remote_reboot");
        }, 2_000);
        break;
      case "sleep": {
        // Re-parse with the concrete schema: TS can't narrow `parsed` through `name`.
        const sleep = COMMANDS.sleep.safeParse(json);
        if (sleep.success) this.sleepMode = sleep.data.mode;
        break;
      }
      case "buzzer":
      case "peripheral":
        break;
    }
    return { request_id: requestId, status: "success" };
  }

  private runSetting(op: "set" | "get", name: string, json: unknown, requestId: string) {
    if (!isSettingName(name)) {
      return { request_id: requestId, status: "unsupported", error_code: "unsupported_setting" };
    }
    if (op === "get")
      return { request_id: requestId, status: "success", value: this.settings[name] };

    const value = SETTINGS[name].schema.safeParse((json as { value?: unknown }).value);
    if (!value.success) {
      return {
        request_id: requestId,
        status: "failed",
        error_code: "invalid_range",
        message: formatIssues(value.error).join("; "),
      };
    }
    if (this.io.random() < this.opts.failRate) {
      return { request_id: requestId, status: "failed", error_code: "storage_error" };
    }
    this.settings[name] = value.data;
    if (name === "gps_interval") {
      this.gpsIntervalApplied = true;
      if (this.timer) this.schedule();
    }
    return { request_id: requestId, status: "success", value: value.data };
  }

  private respond(path: string, body: Record<string, unknown>): void {
    const { min, max } = this.opts.responseDelayMs;
    const delay = min + this.io.random() * (max - min);
    setTimeout(() => {
      this.publish(path, body, QOS1);
      if (this.io.random() < this.opts.duplicateRate) {
        setTimeout(() => this.publish(path, body, QOS1), 100);
      }
    }, delay);
  }

  private expireCache(): void {
    const cutoff = Date.now() - REQUEST_CACHE_MS;
    for (const [id, entry] of this.handled) if (entry.at < cutoff) this.handled.delete(id);
  }

  // ------------------------------------------------------------ simulation

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  private move(): void {
    if (this.sleepMode !== "none") {
      this.speed = 0;
      return;
    }
    const fromHome = distanceM(this.opts.home, this.pos);
    this.heading =
      fromHome > ROAM_RADIUS_M
        ? bearing(this.pos, this.opts.home) + (this.io.random() - 0.5) * 40
        : this.heading + (this.io.random() - 0.5) * 60;
    // Mostly trotting, sometimes resting.
    this.speed = this.io.random() < 0.2 ? 0 : 0.5 + this.io.random() * 2;
    this.pos = offset(this.pos, this.speed * (this.tickMs / 1000), this.heading);

    const inside = distanceM(this.opts.home, this.pos) <= GEOFENCE_RADIUS_M;
    if (inside !== this.insideGeofence) {
      this.insideGeofence = inside;
      this.publish(
        "event/geofence",
        {
          geofence_id: GEOFENCE_ID,
          event: inside ? "enter" : "exit",
          latitude: round(this.pos.latitude, 6),
          longitude: round(this.pos.longitude, 6),
        },
        QOS1,
      );
    }
  }

  private updateBattery(): void {
    if (this.charging) {
      this.battery = Math.min(100, this.battery + 2);
      if (this.battery >= 100) this.charging = false;
    } else {
      this.battery = Math.max(0, this.battery - 0.4);
      if (this.battery <= 5) this.charging = true;
    }
    // Drifts around ~30 °C, warmer while charging or running.
    const target = 29 + (this.charging ? 6 : 0) + this.speed * 0.8;
    this.temperature += (target - this.temperature) * 0.2 + (this.io.random() - 0.5) * 0.6;

    if (!this.lowBatterySent && !this.charging && this.battery <= LOW_BATTERY_PCT) {
      this.lowBatterySent = true;
      this.publish(
        "event/low_battery",
        {
          percentage: Math.round(this.battery),
          voltage: round(3.3 + (this.battery / 100) * 0.9, 2),
        },
        QOS1,
      );
    }
    if (this.battery > LOW_BATTERY_PCT + 5) this.lowBatterySent = false;
  }

  private publishSystemStatus(resetReason: string): void {
    this.publish("status/system", {
      firmware_version: "1.1.0-sim",
      uptime: Math.floor((Date.now() - this.bootedAt) / 1000),
      free_memory: 150_000 + Math.floor(this.io.random() * 5_000),
      reset_reason: resetReason,
    });
  }

  /** Adds the spec §3 envelope. */
  private publish(path: string, body: Record<string, unknown>, opts: PublishOptions = QOS0): void {
    this.io.publish(
      path,
      { timestamp: Math.floor(Date.now() / 1000), ...body, protocol_version: PROTOCOL_VERSION },
      opts,
    );
  }
}
