import {
  COMMANDS,
  SETTINGS,
  backendTopic,
  deviceTopic,
  formatIssues,
  isCommandName,
  isSettingName,
  schemas,
  splitTopic,
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
  /** Full topic, e.g. `pettracker/{device_id}/backend/telemetry/gps`. */
  publish(topic: string, payload: Record<string, unknown>, opts: PublishOptions): void;
  log(msg: string): void;
  random(): number;
}

export interface DeviceOptions {
  deviceId: string;
  home: LatLon;
  /** Telemetry period until a `gps_interval` setting is applied (demo speed). */
  intervalS: number;
  /** Probability a command fails (status error/rejected) or a SET is not acknowledged. */
  failRate: number;
  /** Probability a response is published twice (exercises QoS 1 dedupe, rule 6). */
  duplicateRate: number;
  responseDelayMs: { min: number; max: number };
}

const GEOFENCE_RADIUS_M = 150;
/** Wander radius; beyond it the dog heads back home. */
const ROAM_RADIUS_M = 300;
/** Processed request_ids / setting_ids are remembered this long, so retries aren't re-run. */
const REQUEST_CACHE_MS = 5 * 60_000;

const QOS0 = { qos: 0, retain: false } as const;
const QOS1 = { qos: 1, retain: false } as const;

interface Answer {
  topic: string;
  body: Record<string, unknown>;
}

type SettingsState = { [S in SettingName]: Record<string, unknown> };

/** What a fresh collar reports for each settings group. */
const defaultSettings = (deviceId: string): SettingsState => ({
  network_settings: { mqtt_hb_interval: 60, mqtt_retry_interval: 60, telemetry_interval: 30 },
  gps_settings: { gps_interval: 30, gps_enabled: true },
  profile_settings: { pet_name: deviceId, vaccination_status: 0 },
  power_settings: {
    power_mode: "active",
    low_bat_thresh: 15,
    low_bat_alert_enable: true,
    inactive_timeout: 300,
  },
  sensor_settings: {
    imu_enable: true,
    imu_sample_rate: 100,
    imu_sleep_detect_timeout: 600,
    imu_detach_detect_timeout: 60,
    bme_enable: true,
    temp_max_value: 45,
  },
  device_settings: {
    pwrkey_hold_timeout: 3,
    speaker_enable: true,
    audio_volume: 60,
    display_enable: true,
    display_rotation: 0,
    display_inverted: false,
    display_timeout: 30,
    display_brightness: 70,
    geofence_alert_enable: true,
    motion_alert_enable: true,
    high_temp_alert_enable: true,
  },
});

/**
 * One fake collar (spec V3): periodic telemetry, geofence and low-battery events, command
 * responses and settings ACK/GET answers with configurable delay, failures and duplicates,
 * and idempotent handling of repeated request_ids / setting_ids. MQTT is handled by the caller.
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
  /** Midpoint of the reported signal strength range. */
  private signal = 65;
  private temperature = 30;
  private humidity = 70;
  private bootedAt = Date.now();
  /** Epoch ms until which the collar sleeps (command/sleep). */
  private sleepUntil = 0;
  private settings: SettingsState;
  private gpsIntervalApplied = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handled = new Map<string, Answer & { at: number }>();

  constructor(
    private readonly opts: DeviceOptions,
    private readonly io: DeviceIO,
  ) {
    this.id = opts.deviceId;
    this.pos = { ...opts.home };
    this.heading = io.random() * 360;
    this.battery = 60 + io.random() * 40;
    this.settings = defaultSettings(opts.deviceId);
  }

  /** Current position, rounded like the GPS telemetry. */
  get position(): LatLon {
    return { latitude: round(this.pos.latitude, 6), longitude: round(this.pos.longitude, 6) };
  }

  /** Telemetry period in ms: the gps_interval setting once one was applied, else the demo interval. */
  get tickMs(): number {
    const gps = this.settings.gps_settings.gps_interval as number;
    return (this.gpsIntervalApplied ? gps : this.opts.intervalS) * 1000;
  }

  private get sleeping(): boolean {
    return Date.now() < this.sleepUntil;
  }

  /** Call after every (re)connect: announces the device and starts telemetry. */
  start(): void {
    this.publish("status/connectivity", { status: "online" }, { qos: 1, retain: true });
    this.publishSystemStatus("power_on");
    this.publish("status/network", {
      connection: "lte",
      registration: "registered",
      operator: "sim_operator",
      apn: "internet",
      ip_address: `10.0.0.${1 + Math.floor(this.io.random() * 250)}`,
    });
    this.tick();
    this.schedule();
  }

  /** Graceful shutdown: the broker's Last Will only fires on unexpected disconnects. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.io.publish(
      backendTopic(this.id, "status/connectivity"),
      { status: "offline" },
      { qos: 1, retain: true },
    );
  }

  tick(): void {
    this.move();
    this.updateBattery();
    this.signal = Math.max(20, Math.min(95, this.signal + (this.io.random() - 0.5) * 6));
    this.humidity = Math.max(30, Math.min(95, this.humidity + (this.io.random() - 0.5) * 2));

    if (this.settings.gps_settings.gps_enabled !== false) {
      this.publish("telemetry/gps", {
        latitude: round(this.pos.latitude, 6),
        longitude: round(this.pos.longitude, 6),
        speed: round(this.speed, 2),
      });
    }
    this.publish("telemetry/battery", {
      voltage: round(3.3 + (this.battery / 100) * 0.9, 2),
      percentage: Math.round(this.battery),
      charging: this.charging,
    });
    const spread = 3 + this.io.random() * 6;
    this.publish("telemetry/signal_strength", {
      strength_lower_limit: round(this.signal - spread, 1),
      strength_upper_limit: round(this.signal + spread, 1),
    });
    if (this.settings.sensor_settings.bme_enable !== false) {
      this.publish("telemetry/bme_data", {
        temperature: round(this.temperature, 1),
        pressure: round(1009 + this.io.random() * 6, 1),
        humidity: round(this.humidity, 1),
      });
    }
    if (this.settings.sensor_settings.imu_enable !== false) {
      const jitter = () => round((this.io.random() - 0.5) * (0.2 + this.speed), 2);
      this.publish("telemetry/imu", {
        acceleration: { x: jitter(), y: jitter(), z: round(9.81 + jitter(), 2) },
        gyroscope: { x: jitter() * 10, y: jitter() * 10, z: jitter() * 10 },
      });
    }
  }

  /** Handles a message on `pettracker/{id}/device/…`; ignores everything else. */
  handleMessage(topic: string, raw: string): void {
    const t = splitTopic(topic);
    if (!t || t.deviceId !== this.id || t.publisher !== "device") return;
    // Our own ACKs come back through the `device/#` subscription.
    if (t.path.startsWith("settings/ack/")) return;
    const { path } = t;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.io.log(`${this.id}: ignoring non-JSON message on ${path}`);
      return;
    }
    const body = (json ?? {}) as { request_id?: unknown; setting_id?: unknown };
    const id = path.startsWith("settings/") ? body.setting_id : body.request_id;
    if (typeof id !== "string" || !id) {
      this.io.log(`${this.id}: ignoring ${path} without request_id / setting_id`);
      return;
    }

    // A repeated id returns the previous answer, no repeated action.
    this.expireCache();
    const cached = this.handled.get(id);
    if (cached) {
      this.respond(cached);
      return;
    }

    const answer = this.process(path, json, id);
    if (!answer) return;
    this.handled.set(id, { ...answer, at: Date.now() });
    this.respond(answer);
  }

  // ------------------------------------------------------------ commands & settings

  private process(path: string, json: unknown, id: string): Answer | null {
    const [kind, a = "", b = ""] = path.split("/");
    if (kind === "command" && isCommandName(a)) {
      return {
        topic: backendTopic(this.id, `response/${a}`),
        body: { request_id: id, ...this.runCommand(a, json) },
      };
    }
    if (kind === "settings" && isSettingName(b)) {
      if (a === "get") {
        return {
          topic: backendTopic(this.id, `settings/response/${b}`),
          body: this.settingsBody(b, "get_response", id, this.settings[b]),
        };
      }
      if (a === "set") return this.runSet(b, json, id);
    }
    this.io.log(`${this.id}: unsupported topic ${path}`);
    return null;
  }

  private runCommand(name: CommandName, json: unknown): Record<string, unknown> {
    const failed = name === "reboot" ? { status: "rejected" } : { status: "error" };
    const parsed = COMMANDS[name].safeParse(json);
    if (!parsed.success) {
      this.io.log(`${this.id}: invalid ${name}: ${formatIssues(parsed.error).join("; ")}`);
      return failed;
    }
    if (this.io.random() < this.opts.failRate) return failed;

    const ok = { status: "success" };
    switch (name) {
      case "config": {
        const config = COMMANDS.config.parse(json);
        return { ...ok, applied: config.config };
      }
      case "location":
        return {
          ...ok,
          location: {
            latitude: round(this.pos.latitude, 6),
            longitude: round(this.pos.longitude, 6),
            accuracy_m: round(3 + this.io.random() * 6, 1),
            fix_valid: true,
          },
        };
      case "buzzer": {
        const buzzer = COMMANDS.buzzer.parse(json);
        return { ...ok, enabled: buzzer.enabled, duration_ms: buzzer.duration_ms };
      }
      case "reboot": {
        if (!COMMANDS.reboot.parse(json).reboot_enable) return { status: "rejected" };
        // Acknowledge before restarting.
        setTimeout(() => {
          this.bootedAt = Date.now();
          this.sleepUntil = 0;
          this.publishSystemStatus("remote_reboot");
        }, 2_000);
        return { status: "accepted" };
      }
      case "peripheral": {
        const p = COMMANDS.peripheral.parse(json);
        return { ...ok, peripheral: p.peripheral, enabled: p.enabled };
      }
      case "sleep": {
        const sleep = COMMANDS.sleep.parse(json);
        this.sleepUntil = Date.now() + sleep.duration_seconds * 1000;
        this.publishSystemStatus("sleep");
        return { ...ok, action: sleep.action, duration_seconds: sleep.duration_seconds };
      }
    }
  }

  /** A valid SET is applied and acknowledged; an invalid or failed one gets no ACK. */
  private runSet(setting: SettingName, json: unknown, id: string): Answer | null {
    const parsed = schemas.settingsSet(setting).safeParse(json);
    if (!parsed.success) {
      this.io.log(`${this.id}: invalid ${setting}: ${formatIssues(parsed.error).join("; ")}`);
      return null;
    }
    if (this.io.random() < this.opts.failRate) {
      this.io.log(`${this.id}: simulated failure, not acknowledging ${setting}`);
      return null;
    }
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(SETTINGS[setting].fields)) {
      const value = (parsed.data as Record<string, unknown>)[key];
      if (value !== undefined) fields[key] = value;
    }
    this.settings[setting] = { ...this.settings[setting], ...fields };
    if (setting === "gps_settings" && fields.gps_interval !== undefined) {
      this.gpsIntervalApplied = true;
      if (this.timer) this.schedule();
    }
    return {
      topic: deviceTopic(this.id, `settings/ack/${setting}`),
      body: this.settingsBody(setting, "ack", id, {}),
    };
  }

  private settingsBody(
    setting: SettingName,
    action: string,
    id: string,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    return { action, setting_id: id, setting_type: SETTINGS[setting].type, ...fields };
  }

  private respond(answer: Answer): void {
    const { min, max } = this.opts.responseDelayMs;
    const delay = min + this.io.random() * (max - min);
    const send = () => this.io.publish(answer.topic, this.stamp(answer.body), QOS1);
    setTimeout(() => {
      send();
      if (this.io.random() < this.opts.duplicateRate) setTimeout(send, 100);
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
    if (this.sleeping) {
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
      this.publish("event/geofence", { in_status: inside, out_status: !inside }, QOS1);
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

    const power = this.settings.power_settings;
    const threshold = power.low_bat_thresh as number;
    if (
      power.low_bat_alert_enable !== false &&
      !this.lowBatterySent &&
      !this.charging &&
      this.battery <= threshold
    ) {
      this.lowBatterySent = true;
      this.publish(
        "event/low_battery",
        {
          percentage: Math.round(this.battery),
          voltage: round(3.3 + (this.battery / 100) * 0.9, 2),
          threshold_percentage: threshold,
          charging: this.charging,
        },
        QOS1,
      );
    }
    if (this.battery > threshold + 5) this.lowBatterySent = false;
  }

  private publishSystemStatus(resetReason: string): void {
    this.publish("status/system", {
      firmware_version: "1.1.0-sim",
      uptime_seconds: Math.floor((Date.now() - this.bootedAt) / 1000),
      free_heap_bytes: 150_000 + Math.floor(this.io.random() * 5_000),
      reset_reason: resetReason,
      device_state: this.sleeping ? "sleep" : "active",
    });
  }

  private stamp(body: Record<string, unknown>): Record<string, unknown> {
    return { timestamp: Math.floor(Date.now() / 1000), ...body };
  }

  /** `path` is under `pettracker/{id}/backend/`. */
  private publish(path: string, body: Record<string, unknown>, opts: PublishOptions = QOS0): void {
    this.io.publish(backendTopic(this.id, path), this.stamp(body), opts);
  }
}
