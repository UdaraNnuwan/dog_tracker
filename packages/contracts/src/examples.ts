/**
 * Example payloads, copied verbatim from the spec where it gives one. Entries marked
 * `derived: true` have no example in the spec and are built from its field tables instead.
 *
 * Used as test fixtures, as simulator seeds and as `examples` in the exported JSON Schema.
 */
export interface SpecExample {
  /** Path after `pettracker/{backend|device}/{device_id}/`. */
  path: string;
  direction: "backend" | "device";
  section: string;
  payload: Record<string, unknown>;
  derived?: true;
}

const TS = 1717330000;

export const SPEC_EXAMPLES: readonly SpecExample[] = [
  // ---- device → backend
  {
    path: "telemetry/gps",
    direction: "backend",
    section: "5.1",
    payload: {
      timestamp: TS,
      latitude: 6.9271,
      longitude: 79.8612,
      speed: 1.2,
      accuracy: 4.5,
      satellites: 10,
    },
  },
  {
    path: "telemetry/battery",
    direction: "backend",
    section: "5.2",
    payload: { timestamp: TS, voltage: 3.95, percentage: 82, charging: false },
  },
  {
    path: "telemetry/imu",
    direction: "backend",
    section: "5.3",
    payload: {
      timestamp: TS,
      accelerometer: { x: 0.12, y: -0.03, z: 9.78 },
      gyroscope: { x: 0.4, y: -0.2, z: 0.1 },
    },
  },
  {
    path: "telemetry/signal_strength",
    direction: "backend",
    section: "5.4",
    payload: { timestamp: TS, rssi: -79, rsrp: -101, rsrq: -11, sinr: 14 },
  },
  {
    path: "status/system",
    direction: "backend",
    section: "6.1",
    payload: {
      timestamp: TS,
      firmware_version: "1.1.0",
      uptime: 86400,
      free_memory: 152320,
      reset_reason: "power_on",
    },
  },
  {
    path: "status/network",
    direction: "backend",
    section: "6.2",
    payload: {
      timestamp: TS,
      connected: true,
      network_type: "lte",
      operator: "example_operator",
      ip_address: "10.20.30.40",
    },
  },
  {
    path: "status/connectivity",
    direction: "backend",
    section: "11",
    payload: { timestamp: TS, status: "online" },
  },
  {
    path: "status/connectivity",
    direction: "backend",
    section: "11",
    payload: { status: "offline" },
  },
  {
    path: "event/geofence",
    direction: "backend",
    section: "6.3",
    payload: { timestamp: TS, geofence_id: "home", event: "exit" },
  },
  {
    path: "event/low_battery",
    direction: "backend",
    section: "6.4",
    payload: { timestamp: TS, percentage: 15, voltage: 3.55 },
  },
  {
    path: "event/tamper",
    direction: "backend",
    section: "6.5",
    payload: { timestamp: TS, detected: true },
  },
  {
    path: "response/reboot",
    direction: "backend",
    section: "7.2",
    payload: { timestamp: 1717330001, request_id: "req_1003", status: "success" },
  },
  {
    path: "response/reboot",
    direction: "backend",
    section: "7.3",
    payload: {
      timestamp: 1717330001,
      request_id: "req_1003",
      status: "failed",
      error_code: "reboot_failed",
      message: "Unable to restart device",
    },
  },
  {
    path: "response/location",
    direction: "backend",
    section: "7",
    derived: true,
    payload: {
      timestamp: 1717330001,
      request_id: "req_1003",
      status: "success",
      latitude: 6.9271,
      longitude: 79.8612,
    },
  },
  {
    path: "settings/response/gps_interval",
    direction: "backend",
    section: "8.2",
    payload: { timestamp: 1717330001, request_id: "req_2001", status: "success", value: 45 },
  },
  {
    path: "diagnostic/log",
    direction: "backend",
    section: "9.1",
    payload: {
      timestamp: TS,
      level: "error",
      module: "storage",
      error_type: "eeprom",
      error_code: "400004",
    },
  },

  // ---- backend → device
  {
    path: "command/location",
    direction: "device",
    section: "7.1",
    payload: { timestamp: TS, request_id: "req_1003" },
  },
  {
    path: "command/reboot",
    direction: "device",
    section: "7.1",
    payload: { timestamp: TS, request_id: "req_1003" },
  },
  {
    path: "command/buzzer",
    direction: "device",
    section: "7",
    derived: true,
    payload: { timestamp: TS, request_id: "req_1004", enabled: true, duration: 5 },
  },
  {
    path: "command/peripheral",
    direction: "device",
    section: "7",
    derived: true,
    payload: { timestamp: TS, request_id: "req_1005", peripheral: "gps", enabled: false },
  },
  {
    path: "command/sleep",
    direction: "device",
    section: "7",
    derived: true,
    payload: { timestamp: TS, request_id: "req_1006", mode: "deep" },
  },
  {
    path: "settings/set/gps_interval",
    direction: "device",
    section: "8.1",
    payload: { timestamp: TS, request_id: "req_2001", value: 45 },
  },
  {
    path: "settings/get/gps_interval",
    direction: "device",
    section: "8",
    derived: true,
    payload: { timestamp: TS, request_id: "req_2002" },
  },
];
