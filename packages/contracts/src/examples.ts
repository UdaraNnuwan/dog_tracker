import { SETTINGS, SETTING_NAMES, type SettingName } from "./settings.js";

/**
 * Example payloads from spec V3. Copied from the spec with its JSON errors fixed (missing or
 * trailing commas, unterminated strings) and settings keys normalised (`"gps_interval "` →
 * `gps_interval`, `Vaccines` → `vaccines`, `Display_inverted` → `display_inverted`, ADR 0011).
 * Values keep the spec's form, so settings values stay strings like `"60"`.
 * Entries marked `derived: true` have no example in the spec.
 *
 * Used as test fixtures, as simulator seeds and as `examples` in the exported JSON Schema.
 */
export interface SpecExample {
  /** Path after `pettracker/{device_id}/{publisher}/`. */
  path: string;
  /** The topic's publisher segment: `backend` (collar → backend) or `device`. */
  direction: "backend" | "device";
  /** Spec V3 chapter and the topic's position in it, e.g. `1.1` = Telemetry / GPS. */
  section: string;
  payload: Record<string, unknown>;
  derived?: true;
}

const TS = 1717330000;
const TS1 = 1717330001;
const REQ = "REQ_1003";

const backend = (section: string, path: string, payload: Record<string, unknown>) =>
  ({ section, path, direction: "backend", payload }) as const;
const device = (section: string, path: string, payload: Record<string, unknown>) =>
  ({ section, path, direction: "device", payload }) as const;

/** Field values of each settings group's SET / response example (spec V3 §6). */
const SETTING_VALUES: Record<SettingName, Record<string, unknown>> = {
  network_settings: { mqtt_hb_interval: "60", mqtt_retry_interval: "60", telemetry_interval: "60" },
  gps_settings: { gps_interval: "60", gps_enabled: "true" },
  profile_settings: {
    pet_name: "shadow",
    owner_qr: "https://example.com/owner/shadow",
    vaccination_status: "1",
    next_vacc_due: "2027-01-01",
    vaccines: [
      { name: "rabies", date: "2028-01-01", completed: "true" },
      { name: "distemper", date: "2028-01-01", completed: "true" },
      { name: "parvovirus", date: "2028-01-01", completed: "true" },
    ],
  },
  power_settings: {
    power_mode: "active",
    low_bat_thresh: "20",
    low_bat_alert_enable: "true",
    inactive_timeout: "60",
    display_timeout: "30",
    display_brightness: "70",
  },
  sensor_settings: {
    imu_sample_rate: "60",
    imu_sleep_detect_timeout: "60",
    imu_detach_detect_timeout: "60",
    bme_enable: "true",
    temp_max_value: "60",
  },
  device_settings: {
    pwrkey_hold_timeout: "60",
    speaker_enable: "true",
    audio_volume: "60",
    audio_sample_rate: "60",
    display_enable: "true",
    display_rotation: "0",
    display_inverted: "false",
    display_timeout: "60",
    display_brightness: "60",
    geofence_alert_enable: "true",
    motion_alert_enable: "true",
    high_temp_alert_enable: "true",
  },
};

function settingsExamples(): SpecExample[] {
  return SETTING_NAMES.flatMap((s, i) => {
    const section = `6.${i + 1}`;
    const head = (action: string, setting_id: string) => ({
      timestamp: TS,
      action,
      setting_id,
      setting_type: SETTINGS[s].type,
    });
    return [
      device(section, `settings/set/${s}`, { ...head("set", "set_1004"), ...SETTING_VALUES[s] }),
      device(section, `settings/ack/${s}`, head("ack", "set_1004")),
      device(section, `settings/get/${s}`, head("get", "set_1003")),
      backend(section, `settings/response/${s}`, {
        ...head("get_response", "set_1003"),
        ...SETTING_VALUES[s],
      }),
    ];
  });
}

export const SPEC_EXAMPLES: readonly SpecExample[] = [
  // ---- 1. telemetry
  backend("1.1", "telemetry/gps", {
    timestamp: TS,
    latitude: 6.9271,
    longitude: 79.8612,
    speed: 1.2,
  }),
  backend("1.2", "telemetry/battery", {
    timestamp: TS,
    voltage: 3.95,
    percentage: 82,
    charging: false,
  }),
  backend("1.3", "telemetry/imu", {
    timestamp: TS,
    acceleration: { x: 0.02, y: -0.1, z: 9.79 },
    gyroscope: { x: 0.3, y: -0.1, z: 0.0 },
  }),
  backend("1.4", "telemetry/signal_strength", {
    timestamp: TS,
    strength_lower_limit: 50.0,
    strength_upper_limit: 79.0,
  }),
  backend("1.5", "telemetry/bme_data", {
    timestamp: TS,
    temperature: 50.0,
    pressure: 79.0,
    humidity: 80.0,
  }),

  // ---- 2. status
  backend("2.1", "status/system", {
    timestamp: TS,
    firmware_version: "1.0.0",
    uptime_seconds: 86400,
    free_heap_bytes: 185600,
    reset_reason: "power_on",
    device_state: "active",
  }),
  backend("2.2", "status/network", {
    timestamp: TS,
    connection: "lte",
    registration: "registered",
    operator: "Example Operator",
    apn: "internet",
    ip_address: "10.24.13.8",
  }),
  // Not in spec V3 (ADR 0011): online announcement and the broker's Last Will.
  { ...backend("2", "status/connectivity", { timestamp: TS, status: "online" }), derived: true },
  { ...backend("2", "status/connectivity", { status: "offline" }), derived: true },

  // ---- 3. events
  backend("3.1", "event/geofence", { timestamp: TS, in_status: true, out_status: false }),
  backend("3.2", "event/low_battery", {
    timestamp: TS,
    percentage: 14,
    voltage: 3.55,
    threshold_percentage: 15,
    charging: false,
  }),

  // ---- 4. commands
  device("4.1", "command/config", {
    timestamp: TS,
    request_id: REQ,
    config: { tracking_enabled: true, report_interval_seconds: 30 },
  }),
  device("4.2", "command/location", {
    timestamp: TS,
    request_id: REQ,
    action: "get_current_location",
  }),
  device("4.3", "command/buzzer", {
    timestamp: TS,
    request_id: REQ,
    enabled: true,
    duration_ms: 1500,
    volume_percent: 70,
  }),
  device("4.4", "command/reboot", { timestamp: TS, request_id: REQ, reboot_enable: true }),
  device("4.5", "command/peripheral", {
    timestamp: TS,
    request_id: REQ,
    peripheral: "speaker",
    enabled: false,
  }),
  device("4.6", "command/sleep", {
    timestamp: TS,
    request_id: REQ,
    action: "enter_sleep",
    duration_seconds: 600,
  }),

  // ---- 5. responses
  backend("5.1", "response/config", {
    timestamp: TS1,
    request_id: REQ,
    status: "success",
    applied: { tracking_enabled: true, report_interval_seconds: 30 },
  }),
  backend("5.2", "response/location", {
    timestamp: TS1,
    request_id: REQ,
    status: "success",
    location: { latitude: 6.9271, longitude: 79.8612, accuracy_m: 8.5, fix_valid: true },
  }),
  backend("5.3", "response/buzzer", {
    timestamp: TS1,
    request_id: REQ,
    status: "success",
    enabled: true,
    duration_ms: 1500,
  }),
  backend("5.4", "response/reboot", { timestamp: TS1, request_id: REQ, status: "accepted" }),
  backend("5.5", "response/peripheral", {
    timestamp: TS1,
    request_id: REQ,
    status: "success",
    peripheral: "speaker",
    enabled: false,
  }),
  backend("5.6", "response/sleep", {
    timestamp: TS1,
    request_id: REQ,
    status: "success",
    action: "enter_sleep",
    duration_seconds: 600,
  }),

  // ---- 6. settings
  ...settingsExamples(),

  // ---- 7. diagnostics
  backend("7.1", "diagnostic/log", { timestamp: TS, error_type: "eeprom", error_code: "400004" }),
  backend("7.2", "diagnostic/debug_log", {
    timestamp: TS,
    level: "info",
    module: "gps",
    message: "GNSS fix acquired",
  }),
];
