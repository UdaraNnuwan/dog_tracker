/**
 * CSV → MQTT payloads for `pnpm replay` (ADR 0007).
 *
 * Columns:
 *   offset_s   seconds after replay start (required)
 *   device_id  target device (required unless --device is given)
 *   anything else becomes a payload field; dots nest (`accelerometer.x`).
 *
 * Cell types are inferred: `true`/`false` → boolean, numbers → number, empty → field omitted,
 * otherwise string. Force a type with a header suffix: `error_code:string`, `value:number`,
 * `detected:boolean`, `extra:json`.
 * Without a `timestamp` column the replayer stamps each message with the current time.
 */

export type CellType = "auto" | "string" | "number" | "boolean" | "json";

export interface Column {
  path: string[];
  type: CellType;
}

export interface ReplayRow {
  offsetS: number;
  deviceId: string | null;
  payload: Record<string, unknown>;
  /** 1-based line number in the file, for error messages. */
  line: number;
}

/** RFC 4180 parser: quoted fields, escaped quotes, commas/newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Skip blank lines and `#` comment lines.
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === "") && !r[0]?.startsWith("#"));
}

export function parseHeader(cell: string): Column {
  const [name = "", type = "auto"] = cell.trim().split(":");
  if (!["auto", "string", "number", "boolean", "json"].includes(type)) {
    throw new Error(`unknown column type "${type}" in "${cell}"`);
  }
  return { path: name.split("."), type: type as CellType };
}

export function convertCell(raw: string, type: CellType): unknown {
  switch (type) {
    case "string":
      return raw;
    case "json":
      return JSON.parse(raw) as unknown;
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || Number.isNaN(n)) throw new Error(`"${raw}" is not a number`);
      return n;
    }
    case "boolean":
      if (raw !== "true" && raw !== "false") throw new Error(`"${raw}" is not true/false`);
      return raw === "true";
    case "auto":
      if (raw === "true" || raw === "false") return raw === "true";
      if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw.trim())) return Number(raw);
      return raw;
  }
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (next === null || typeof next !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path.at(-1)!] = value;
}

/** Parses one topic file into rows, sorted by offset. Throws with the line number on bad input. */
export function parseReplayFile(text: string): ReplayRow[] {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  const columns = header.map(parseHeader);
  const offsetIdx = columns.findIndex((c) => c.path.join(".") === "offset_s");
  if (offsetIdx < 0) throw new Error("missing offset_s column");
  const deviceIdx = columns.findIndex((c) => c.path.join(".") === "device_id");

  return body
    .map((cells, i) => {
      const line = i + 2;
      const offsetS = Number(cells[offsetIdx]);
      if (!Number.isFinite(offsetS) || offsetS < 0) {
        throw new Error(`line ${line}: offset_s must be a number >= 0`);
      }
      const payload: Record<string, unknown> = {};
      columns.forEach((col, c) => {
        if (c === offsetIdx || c === deviceIdx) return;
        const raw = cells[c] ?? "";
        if (raw === "") return;
        try {
          setPath(payload, col.path, convertCell(raw, col.type));
        } catch (err) {
          throw new Error(`line ${line}, column ${col.path.join(".")}: ${(err as Error).message}`, {
            cause: err,
          });
        }
      });
      const deviceId = deviceIdx >= 0 ? (cells[deviceIdx] ?? "").trim() || null : null;
      return { offsetS, deviceId, payload, line };
    })
    .sort((a, b) => a.offsetS - b.offsetS);
}
