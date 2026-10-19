/**
 * Fake collars for development: `pnpm sim --devices 5`. Run with --help for options.
 * Each device is its own mqtt.js client (an implementation independent of the bridge's
 * codec, ADR 0001 §1) with a retained online state and a Last Will (spec §11).
 */
import { parseArgs } from "node:util";
import mqtt from "mqtt";
import { backendTopic, deviceSubscription, isValidDeviceId } from "@udara/contracts";
import { SimDevice } from "./device.js";

const HELP = `Usage: pnpm sim [options]

  --devices <n>         number of collars (default 3)
  --prefix <s>          device id prefix; ids are <prefix>01, <prefix>02, … (default "sim")
  --interval <s>        telemetry period in seconds until gps_interval is set (default 5)
  --fail-rate <0..1>    share of commands/settings that fail (default 0)
  --duplicate-rate <0..1> share of responses published twice (default 0)
  --delay <min-max>     response delay in ms (default 300-1500)
  --home <lat,lon>      geofence centre and start point (default 6.9271,79.8612 Colombo)
  --url <url>           broker (default $SIM_MQTT_URL or wss://broker.hivemq.com:8884/mqtt)

Credentials come from $SIM_MQTT_USERNAME / $SIM_MQTT_PASSWORD (empty = anonymous).
On the public broker everyone shares ids: pick a unique --prefix.`;

const { values } = parseArgs({
  options: {
    devices: { type: "string", default: "3" },
    prefix: { type: "string", default: "sim" },
    interval: { type: "string", default: "5" },
    "fail-rate": { type: "string", default: "0" },
    "duplicate-rate": { type: "string", default: "0" },
    delay: { type: "string", default: "300-1500" },
    home: { type: "string", default: "6.9271,79.8612" },
    url: {
      type: "string",
      default: process.env.SIM_MQTT_URL ?? "wss://broker.hivemq.com:8884/mqtt",
    },
    help: { type: "boolean", default: false },
  },
});

function fail(msg: string): never {
  console.error(`${msg}\n\n${HELP}`);
  process.exit(1);
}

function number(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max)
    fail(`--${name} must be between ${min} and ${max}`);
  return n;
}

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const count = number("devices", values.devices, 1, 100);
const intervalS = number("interval", values.interval, 1, 86_400);
const failRate = number("fail-rate", values["fail-rate"], 0, 1);
const duplicateRate = number("duplicate-rate", values["duplicate-rate"], 0, 1);
const [minDelay = NaN, maxDelay = NaN] = values.delay.split("-").map(Number);
if (!(minDelay >= 0 && maxDelay >= minDelay)) fail("--delay must look like 300-1500");
const [lat = NaN, lon = NaN] = values.home.split(",").map(Number);
if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) fail("--home must look like 6.9271,79.8612");

const username = process.env.SIM_MQTT_USERNAME || undefined;
const password = process.env.SIM_MQTT_PASSWORD || undefined;

const devices: { device: SimDevice; client: mqtt.MqttClient }[] = [];

for (let i = 1; i <= count; i++) {
  const deviceId = `${values.prefix}${String(i).padStart(2, "0")}`;
  if (!isValidDeviceId(deviceId)) fail(`invalid device id "${deviceId}": use [a-z0-9_-]`);

  // Spread the devices around home so they don't overlap on the map.
  const home = {
    latitude: lat + (Math.random() - 0.5) * 0.004,
    longitude: lon + (Math.random() - 0.5) * 0.004,
  };

  let client: mqtt.MqttClient | null = null;
  const device = new SimDevice(
    {
      deviceId,
      home,
      intervalS,
      failRate,
      duplicateRate,
      responseDelayMs: { min: minDelay, max: maxDelay },
    },
    {
      publish: (path, payload, opts) => {
        client?.publish(backendTopic(deviceId, path), JSON.stringify(payload), opts);
      },
      log: (msg) => console.log(msg),
      random: Math.random,
    },
  );

  client = mqtt.connect(values.url, {
    clientId: `${deviceId}-${Math.random().toString(16).slice(2, 8)}`,
    protocolVersion: 4,
    clean: true,
    keepalive: 60,
    reconnectPeriod: 5_000,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    will: {
      topic: backendTopic(deviceId, "status/connectivity"),
      payload: Buffer.from(JSON.stringify({ status: "offline" })),
      qos: 1,
      retain: true,
    },
  });
  client.on("connect", () => {
    console.log(`${deviceId}: connected`);
    client.subscribe(deviceSubscription(deviceId), { qos: 1 });
    device.start();
  });
  client.on("message", (topic, payload) => device.handleMessage(topic, payload.toString()));
  client.on("error", (err) => console.error(`${deviceId}: ${err.message}`));
  client.on("offline", () => console.log(`${deviceId}: offline, retrying`));
  devices.push({ device, client });
}

console.log(
  `simulating ${count} collar(s) on ${values.url}: ${devices.map((d) => d.device.id).join(", ")}. Ctrl+C to stop.`,
);

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log("\nstopping: publishing offline states…");
  for (const { device } of devices) device.stop();
  void Promise.all(devices.map(({ client }) => client.endAsync())).then(() => process.exit(0));
});
