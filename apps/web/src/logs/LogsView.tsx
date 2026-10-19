// Subpath without Zod: keeps the schemas out of the main bundle.
import { PIPELINE_LOG_SOURCES } from "@udara/contracts/live";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchLogs, type LogFilters, type LogRow, type SavedLevel } from "../api.js";
import { downloadCsv } from "../history/csv.js";
import { fromRow } from "./lines.js";
import { LogTable } from "./LogTable.js";

const PAGE = 200;
const TAIL_MS = 5_000;

const PRESETS = [
  { label: "15 min", ms: 15 * 60_000 },
  { label: "1 h", ms: 3600_000 },
  { label: "24 h", ms: 24 * 3600_000 },
  { label: "3 days", ms: 3 * 24 * 3600_000 },
  { label: "14 days", ms: 14 * 24 * 3600_000 },
] as const;

const LEVELS: { id: SavedLevel; label: string }[] = [
  { id: "info", label: "All" },
  { id: "warn", label: "Warn+" },
  { id: "error", label: "Errors" },
];

/**
 * Every saved processing-log line from `pipeline_logs` (ADR 0008), newest first, with
 * filters, paging and an optional live tail. Info lines are kept 3 days, warnings and
 * errors 14 days.
 */
export function LogsView() {
  const [presetMs, setPresetMs] = useState<number>(PRESETS[1].ms);
  const [level, setLevel] = useState<SavedLevel>("info");
  const [source, setSource] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [topic, setTopic] = useState("");
  const [search, setSearch] = useState("");
  const [tail, setTail] = useState(true);

  const [rows, setRows] = useState<LogRow[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Text inputs apply after a short pause instead of on every keystroke.
  const [applied, setApplied] = useState({ deviceId, topic, search });
  useEffect(() => {
    const id = setTimeout(() => setApplied({ deviceId, topic, search }), 400);
    return () => clearTimeout(id);
  }, [deviceId, topic, search]);

  const filters = useCallback(
    (extra: Partial<LogFilters> = {}): LogFilters => ({
      from: new Date(Date.now() - presetMs),
      level,
      source: source || null,
      deviceId: applied.deviceId.trim().toLowerCase() || null,
      topic: applied.topic.trim() || null,
      search: applied.search,
      limit: PAGE,
      ...extra,
    }),
    [presetMs, level, source, applied],
  );

  const fail = (err: unknown) =>
    setError(
      err instanceof ApiError && err.code === "storage_not_configured"
        ? "Storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY in apps/worker/.dev.vars and restart pnpm dev."
        : String(err),
    );

  const load = useCallback(() => {
    setLoading(true);
    fetchLogs(filters())
      .then((page) => {
        setRows(page);
        setMore(page.length === PAGE);
        setError(null);
      })
      .catch(fail)
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(load, [load]);

  const loadOlder = () => {
    const last = rows.at(-1);
    if (!last) return;
    setLoading(true);
    fetchLogs(filters({ beforeId: last.id }))
      .then((page) => {
        setRows((r) => [...r, ...page]);
        setMore(page.length === PAGE);
      })
      .catch(fail)
      .finally(() => setLoading(false));
  };

  // Live tail: poll for lines newer than the newest shown (the bridge flushes every ~5 s).
  const newest = useRef<number | null>(null);
  newest.current = rows[0]?.id ?? null;
  useEffect(() => {
    if (!tail) return;
    const id = setInterval(() => {
      if (newest.current === null) return load();
      fetchLogs(filters({ afterId: newest.current, from: null, limit: 1_000 }))
        .then((page) => {
          if (page.length) setRows((r) => [...page, ...r]);
        })
        .catch(() => {});
    }, TAIL_MS);
    return () => clearInterval(id);
  }, [tail, filters, load]);

  return (
    <div className="history logs-view">
      <div className="panel filters">
        <div className="chips">
          {PRESETS.map((p) => (
            <button
              key={p.ms}
              type="button"
              className={`chip ${presetMs === p.ms ? "active" : ""}`}
              onClick={() => setPresetMs(p.ms)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="chips">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`chip ${level === l.id ? "active" : ""}`}
              onClick={() => setLevel(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <label>
          Source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">all</option>
            {PIPELINE_LOG_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Device
          <input
            className="text"
            placeholder="e.g. demo01"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
          />
        </label>
        <label>
          Topic
          <input
            className="text"
            placeholder="e.g. telemetry/gps"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        <label>
          Search
          <input
            className="text"
            placeholder="message text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="inline">
          <input type="checkbox" checked={tail} onChange={(e) => setTail(e.target.checked)} /> live
          tail
        </label>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </div>

      {error && <p className="error panel">{error}</p>}

      <section className="panel">
        <div className="toolbar">
          <span className="muted small">
            {rows.length} line(s){more ? "+" : ""} · saved in Supabase (info 3 days, warn/error 14
            days){loading ? " · loading…" : ""}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={rows.length === 0}
            onClick={() => downloadCsv(`logs-${new Date().toISOString()}.csv`, rows)}
          >
            Download CSV
          </button>
        </div>
        <div className="table-wrap logs-scroll">
          <LogTable
            lines={rows.map(fromRow)}
            showSource
            withDate
            empty={loading ? "Loading…" : "No saved log lines for these filters."}
          />
        </div>
        {more && (
          <button type="button" className="ghost more" disabled={loading} onClick={loadOlder}>
            Load older
          </button>
        )}
      </section>
    </div>
  );
}
