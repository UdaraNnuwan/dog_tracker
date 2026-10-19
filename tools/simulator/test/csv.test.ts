import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { convertCell, parseCsv, parseReplayFile } from "../src/csv.js";
import { topicFromFile, validatePayload } from "../src/topics.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded commas/newlines, CRLF and comments", () => {
    const text = 'a,b\r\n1,"x, ""y""\nz"\n# comment\n\n2,\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["1", 'x, "y"\nz'],
      ["2", ""],
    ]);
  });
});

describe("convertCell", () => {
  it.each([
    ["true", "auto", true],
    ["42", "auto", 42],
    ["-3.5e2", "auto", -350],
    ["400004", "string", "400004"],
    ["0x08", "auto", "0x08"],
    ["7", "number", 7],
    ['{"a":1}', "json", { a: 1 }],
  ] as const)("%s as %s", (raw, type, expected) => {
    expect(convertCell(raw, type)).toEqual(expected);
  });

  it.each([
    ["abc", "number"],
    ["yes", "boolean"],
  ] as const)("rejects %s as %s", (raw, type) => {
    expect(() => convertCell(raw, type)).toThrow();
  });
});

describe("parseReplayFile", () => {
  it("builds nested payloads, omits empty cells and sorts by offset", () => {
    const rows = parseReplayFile(
      "offset_s,device_id,accelerometer.x,accelerometer.y,error_code:string,note\n" +
        "5,dog1,0.1,0.2,400004,\n" +
        "1,dog2,1,2,,hi\n",
    );
    expect(rows).toEqual([
      {
        offsetS: 1,
        deviceId: "dog2",
        payload: { accelerometer: { x: 1, y: 2 }, note: "hi" },
        line: 3,
      },
      {
        offsetS: 5,
        deviceId: "dog1",
        payload: { accelerometer: { x: 0.1, y: 0.2 }, error_code: "400004" },
        line: 2,
      },
    ]);
  });

  it("reports the line of a bad cell", () => {
    expect(() => parseReplayFile("offset_s,value:number\n0,abc\n")).toThrow(/line 2, column value/);
    expect(() => parseReplayFile("device_id\ndog\n")).toThrow(/offset_s/);
  });
});

describe("topicFromFile", () => {
  it.each([
    [
      "backend/telemetry/gps.csv",
      { direction: "backend", path: "telemetry/gps", qos: 0, retain: false },
    ],
    [
      "backend/status/connectivity.csv",
      { direction: "backend", path: "status/connectivity", qos: 1, retain: true },
    ],
    [
      "backend/settings/response/gps_interval.csv",
      { direction: "backend", path: "settings/response/gps_interval", qos: 1, retain: false },
    ],
    [
      "device/command/buzzer.csv",
      { direction: "device", path: "command/buzzer", qos: 1, retain: false },
    ],
  ])("%s", (file, spec) => {
    expect(topicFromFile(file)).toEqual(spec);
  });

  it.each(["backend/telemetry/temp.csv", "device/command/dance.csv", "other/x.csv"])(
    "rejects %s",
    (file) => {
      expect(typeof topicFromFile(file)).toBe("string");
    },
  );
});

describe("bundled test data", () => {
  const root = join(import.meta.dirname, "..");
  async function load(dir: string) {
    const base = join(root, dir);
    const entries = await readdir(base, { withFileTypes: true, recursive: true });
    const files = entries
      .filter((e) => e.name.endsWith(".csv"))
      .map((e) => relative(base, join(e.parentPath, e.name)));
    return Promise.all(
      files.map(async (f) => ({
        file: f,
        rows: parseReplayFile(await readFile(join(base, f), "utf8")),
      })),
    );
  }
  const issuesOf = (file: string, deviceId: string, payload: Record<string, unknown>) => {
    const spec = topicFromFile(file);
    if (typeof spec === "string") return [spec];
    return validatePayload(spec, deviceId, { timestamp: 1792380000, request_id: "r", ...payload });
  };

  it("test-data covers every topic in the catalogue and is valid", async () => {
    const sets = await load("test-data");
    expect(sets.length).toBe(27);
    for (const { file, rows } of sets) {
      for (const r of rows)
        expect(issuesOf(file, r.deviceId!, r.payload), `${file}:${r.line}`).toEqual([]);
    }
  });

  it("every row in test-data-invalid is rejected", async () => {
    for (const { file, rows } of await load("test-data-invalid")) {
      for (const r of rows) {
        expect(issuesOf(file, r.deviceId!, r.payload).length, `${file}:${r.line}`).toBeGreaterThan(
          0,
        );
      }
    }
  });
});
