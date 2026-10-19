/**
 * Replays CSV test data to MQTT, one file per topic: `pnpm replay --help` (ADR 0007).
 * Files live under `test-data/{backend|device}/<topic path>.csv`, e.g.
 * `test-data/backend/telemetry/gps.csv` → `pettracker/backend/{device_id}/telemetry/gps`.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import mqtt from "mqtt";
import { isValidDeviceId } from "@udara/contracts";
import { parseReplayFile, type ReplayRow } from "./csv.js";
import { topicFromFile, validatePayload, type TopicSpec } from "./topics.js";

const DEFAULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test-data");

const HELP = `Usage: pnpm replay [options]

  --dir <path>        folder with {backend,device}/<topic>.csv files (default tools/simulator/test-data)
  --only <list>       comma-separated topic prefixes, e.g. telemetry/gps,event (default all)
  --device <id>       send every row as this device (overrides the device_id column)
  --speed <n>         time multiplier, 10 = ten times faster (default 1)
  --loop              start over after the last row
  --skip-invalid      don't publish rows that fail validation (default: publish and warn,
                      so you can test how the backend rejects them)
  --check             validate all files and exit without connecting
  --url <url>         broker (default $SIM_MQTT_URL or wss://broker.hivemq.com:8884/mqtt)

Credentials come from $SIM_MQTT_USERNAME / $SIM_MQTT_PASSWORD (empty = anonymous).`;

interface Scheduled {
  spec: TopicSpec;
  file: string;
  row: ReplayRow;
}

async function csvFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".csv"))
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

async function load(dir: string, only: string[], device: string | null): Promise<Scheduled[]> {
  const out: Scheduled[] = [];
  for (const file of await csvFiles(dir)) {
    const spec = topicFromFile(file);
    if (typeof spec === "string") throw new Error(`${file}: ${spec}`);
    if (only.length && !only.some((p) => spec.path.startsWith(p))) continue;
    let rows: ReplayRow[];
    try {
      rows = parseReplayFile(await readFile(join(dir, file), "utf8"));
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`, { cause: err });
    }
    for (const row of rows) {
      const deviceId = device ?? row.deviceId;
      if (!deviceId || !isValidDeviceId(deviceId)) {
        throw new Error(`${file} line ${row.line}: invalid or missing device_id "${deviceId}"`);
      }
      out.push({ spec, file, row: { ...row, deviceId } });
    }
  }
  return out.sort((a, b) => a.row.offsetS - b.row.offsetS);
}

/**
 * Adds what a real sender adds: a device timestamp and, for commands, a request_id.
 * The timestamp follows the CSV timeline (`base + offset_s`), not the wall clock, so a sped-up
 * replay keeps rows seconds apart instead of collapsing them onto the same second.
 */
function finalise(s: Scheduled, baseS: number): Record<string, unknown> {
  const payload = { ...s.row.payload };
  payload.timestamp ??= Math.floor(baseS + s.row.offsetS);
  if (s.spec.direction === "device") payload.request_id ??= randomUUID();
  return payload;
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string", default: DEFAULT_DIR },
      only: { type: "string", default: "" },
      device: { type: "string" },
      speed: { type: "string", default: "1" },
      loop: { type: "boolean", default: false },
      "skip-invalid": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      url: {
        type: "string",
        default: process.env.SIM_MQTT_URL ?? "wss://broker.hivemq.com:8884/mqtt",
      },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return console.log(HELP);

  const speed = Number(values.speed);
  if (!(speed > 0)) throw new Error("--speed must be > 0");
  if (values.device !== undefined && !isValidDeviceId(values.device)) {
    throw new Error(`--device "${values.device}" is not a valid device id`);
  }
  const only = values.only
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // pnpm runs this from tools/simulator; resolve --dir against the caller's folder.
  const dir = resolve(process.env.INIT_CWD ?? process.cwd(), values.dir);
  const items = await load(dir, only, values.device ?? null);
  if (items.length === 0) throw new Error("no rows to replay (check --dir / --only)");

  // Validate up front so problems show before anything is sent.
  let invalid = 0;
  for (const item of items) {
    const issues = validatePayload(
      item.spec,
      item.row.deviceId!,
      finalise(item, Date.now() / 1000),
    );
    if (issues.length) {
      invalid++;
      console.warn(`invalid ${item.file} line ${item.row.line}: ${issues.join("; ")}`);
    }
  }
  const files = new Set(items.map((i) => i.file)).size;
  const span = items.at(-1)!.row.offsetS / speed;
  console.log(
    `${items.length} row(s) from ${files} file(s), ${invalid} invalid, ~${span.toFixed(0)} s`,
  );
  if (values.check) {
    process.exitCode = invalid ? 1 : 0;
    return;
  }

  const client = mqtt.connect(values.url, {
    clientId: `replay-${Math.random().toString(16).slice(2, 10)}`,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 5_000,
    ...(process.env.SIM_MQTT_USERNAME ? { username: process.env.SIM_MQTT_USERNAME } : {}),
    ...(process.env.SIM_MQTT_PASSWORD ? { password: process.env.SIM_MQTT_PASSWORD } : {}),
  });
  client.on("error", (err) => console.error(`mqtt: ${err.message}`));
  await new Promise<void>((ok) => client.once("connect", () => ok()));
  console.log(`connected to ${values.url}${values.loop ? " (looping, Ctrl+C to stop)" : ""}`);

  let timers: ReturnType<typeof setTimeout>[] = [];
  process.on("SIGINT", () => {
    timers.forEach(clearTimeout);
    void client.endAsync().then(() => process.exit(0));
  });

  // Timeline start: chosen so the last row's timestamp is about "now" when it is sent, and no
  // timestamp is ever in the future: ts - sendTime = (offset - span)(1 - 1/speed) <= 0.
  const spanS = items.at(-1)!.row.offsetS;
  let baseS = Date.now() / 1000 - spanS * (1 - 1 / speed);

  const runOnce = () =>
    new Promise<void>((done) => {
      let remaining = items.length;
      timers = items.map((item) =>
        setTimeout(
          () => {
            const payload = finalise(item, baseS);
            const skip =
              values["skip-invalid"] &&
              validatePayload(item.spec, item.row.deviceId!, payload).length > 0;
            if (!skip) {
              const topic = `pettracker/${item.spec.direction}/${item.row.deviceId}/${item.spec.path}`;
              client.publish(topic, JSON.stringify(payload), {
                qos: item.spec.qos,
                retain: item.spec.retain,
              });
              console.log(`→ ${topic}`);
            }
            if (--remaining === 0) done();
          },
          (item.row.offsetS * 1000) / speed,
        ),
      );
    });

  do {
    await runOnce();
    // Next loop continues the timeline instead of overwriting it.
    baseS += spanS + 1;
  } while (values.loop);
  await client.endAsync();
  console.log("replay finished");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
