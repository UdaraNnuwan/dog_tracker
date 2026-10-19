import { backendTopic, type DemoStatus } from "@udara/contracts";
import { SimDevice } from "@udara/simulator/device";

export const DEMO_DEFAULT_DEVICES = 2;
export const DEMO_MAX_DEVICES = 5;
export const DEMO_DEFAULT_SECONDS = 60;
export const DEMO_MAX_SECONDS = 600;
/** Telemetry period of the demo collars: fast, so the tables fill quickly. */
const DEMO_INTERVAL_S = 2;
/** Demo collars wander around Colombo, like `pnpm sim`. */
const HOME = { latitude: 6.9271, longitude: 79.8612 };

/** Delivers one fake inbound message: (full topic, raw payload). */
export type Inject = (topic: string, payload: string) => void;

/**
 * Scripted extras on top of the simulated telemetry, so one run shows every kind of log
 * line: events, a diagnostic, and an invalid payload that validation rejects (rule 4).
 * `at` is seconds after the start; `device` indexes the demo collars.
 */
const SCRIPT: { at: number; device: number; path: string; body: Record<string, unknown> }[] = [
  { at: 8, device: 0, path: "event/geofence", body: { geofence_id: "home", event: "exit" } },
  // Invalid: percentage out of range and voltage missing.
  { at: 12, device: 0, path: "telemetry/battery", body: { percentage: 150, charging: false } },
  { at: 16, device: 0, path: "event/low_battery", body: { percentage: 14, voltage: 3.55 } },
  {
    at: 20,
    device: 1,
    path: "diagnostic/log",
    body: { level: "error", module: "storage", error_type: "eeprom", error_code: "400004" },
  },
  { at: 24, device: 1, path: "event/tamper", body: { detected: true } },
  { at: 30, device: 0, path: "event/geofence", body: { geofence_id: "home", event: "enter" } },
];

export interface DemoOptions {
  devices: number;
  seconds: number;
}

/**
 * One Demo run (ADR 0008): fake collars from `tools/simulator` whose messages go straight
 * into the bridge's inbound pipeline instead of over MQTT. Everything after the transport
 * (validation, live view, storage, logs) is the real code path.
 */
export class DemoRun {
  private readonly sims: SimDevice[] = [];
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  readonly startedAt: number;
  readonly endsAt: number;
  private running = true;

  constructor(
    opts: DemoOptions,
    private readonly inject: Inject,
    private readonly onEnd: () => void,
    now = Date.now(),
  ) {
    this.startedAt = Math.floor(now / 1000);
    this.endsAt = this.startedAt + opts.seconds;
    for (let i = 1; i <= opts.devices; i++) {
      const deviceId = `demo${String(i).padStart(2, "0")}`;
      const spread = (i - 1) * 0.0015;
      this.sims.push(
        new SimDevice(
          {
            deviceId,
            home: { latitude: HOME.latitude + spread, longitude: HOME.longitude + spread },
            intervalS: DEMO_INTERVAL_S,
            failRate: 0,
            duplicateRate: 0,
            responseDelayMs: { min: 300, max: 1_000 },
          },
          {
            // Live publishes reach existing subscribers with retain=0 (MQTT 3.1.1 §3.3.1.3),
            // so the demo never marks messages as retained.
            publish: (path, payload) =>
              this.running && inject(backendTopic(deviceId, path), JSON.stringify(payload)),
            log: () => {},
            random: Math.random,
          },
        ),
      );
    }
  }

  get devices(): string[] {
    return this.sims.map((s) => s.id);
  }

  start(): void {
    for (const sim of this.sims) sim.start();
    for (const step of SCRIPT) {
      const sim = this.sims[step.device];
      if (!sim) continue;
      this.timers.push(
        setTimeout(() => {
          if (!this.running) return;
          const body = {
            timestamp: Math.floor(Date.now() / 1000),
            // Events say where they happened (optional in spec §6.3, sent by the simulator).
            ...(step.path === "event/geofence" ? sim.position : {}),
            ...step.body,
          };
          this.inject(backendTopic(sim.id, step.path), JSON.stringify(body));
        }, step.at * 1000),
      );
    }
    this.timers.push(setTimeout(() => this.stop(), (this.endsAt - this.startedAt) * 1000));
  }

  /**
   * Hands a cloud → device message to a demo collar (they aren't on MQTT). Returns false
   * when no running demo collar has this id. The collar answers through `inject`.
   */
  deliver(deviceId: string, topic: string, payload: string): boolean {
    const sim = this.running ? this.sims.find((s) => s.id === deviceId) : undefined;
    if (!sim) return false;
    sim.handleMessage(topic, payload);
    return true;
  }

  /** Ends the run: collars publish `offline` (graceful stop, spec §11). Idempotent. */
  stop(): void {
    if (!this.running) return;
    for (const t of this.timers) clearTimeout(t);
    for (const sim of this.sims) sim.stop();
    this.running = false;
    this.onEnd();
  }

  status(): DemoStatus {
    return {
      running: this.running,
      devices: this.devices,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
    };
  }
}

export const IDLE_DEMO: DemoStatus = { running: false, devices: [], startedAt: null, endsAt: null };

/** Clamps request input to the allowed demo size. */
export function demoOptions(input: { devices?: unknown; seconds?: unknown }): DemoOptions {
  const int = (v: unknown, fallback: number, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 ? Math.min(v, max) : fallback;
  return {
    devices: int(input.devices, DEMO_DEFAULT_DEVICES, DEMO_MAX_DEVICES),
    seconds: int(input.seconds, DEMO_DEFAULT_SECONDS, DEMO_MAX_SECONDS),
  };
}
