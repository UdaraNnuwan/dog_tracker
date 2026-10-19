import type { PipelineLog, PipelineLogLevel } from "@udara/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, fetchLogs, type LogRow, type SavedLevel } from "../api.js";
import { fromLive, fromRow, matches } from "../logs/lines.js";
import { LogTable } from "../logs/LogTable.js";

interface Props {
  logs: PipelineLog[];
  /** Selected device, or null when the panel shows every device. */
  deviceId: string | null;
  /** Topic whose table is shown; the panel follows it unless "all topics" is picked. */
  selectedTopic: string | null;
}

type Mode = "live" | "saved";

const LEVEL_CHIPS: { id: PipelineLogLevel; label: string }[] = [
  { id: "debug", label: "All" },
  { id: "info", label: "Info+" },
  { id: "warn", label: "Warn+" },
  { id: "error", label: "Errors" },
];

/** Shown at once in live mode; the browser keeps up to 1000 lines. */
const LIVE_ROWS = 300;
const PAGE = 100;

/**
 * Right-hand column of the Live view (ADR 0008): processing log lines for the selected
 * device and topic. "Live" streams from the bridge; "Saved" reads `pipeline_logs`.
 */
export function LogPanel({ logs, deviceId, selectedTopic }: Props) {
  const [mode, setMode] = useState<Mode>("live");
  const [followTopic, setFollowTopic] = useState(true);
  const topic = followTopic ? selectedTopic : null;
  // IMU lines are debug: one per tick per device, so they are hidden unless asked for.
  const [minLevel, setMinLevel] = useState<PipelineLogLevel>("info");

  const live = useMemo(
    () =>
      logs
        .map(fromLive)
        .filter((l) => matches(l, { deviceId, topic, minLevel }))
        .slice(0, LIVE_ROWS),
    [logs, deviceId, topic, minLevel],
  );

  return (
    <section className="panel log-panel">
      <div className="log-head">
        <h2>
          Logs
          <span className="muted small">
            {deviceId ?? "all devices"} · {topic ?? "all topics"}
          </span>
        </h2>
        <div className="tabs mini">
          <button
            type="button"
            className={mode === "live" ? "active" : ""}
            onClick={() => setMode("live")}
          >
            Live
          </button>
          <button
            type="button"
            className={mode === "saved" ? "active" : ""}
            onClick={() => setMode("saved")}
          >
            Saved
          </button>
        </div>
      </div>

      <div className="chips">
        {LEVEL_CHIPS.filter((c) => mode === "live" || c.id !== "debug").map((c) => (
          <button
            key={c.id}
            type="button"
            className={`chip ${minLevel === c.id ? "active" : ""}`}
            onClick={() => setMinLevel(c.id)}
          >
            {c.label}
          </button>
        ))}
        {selectedTopic && (
          <button
            type="button"
            className={`chip ${followTopic ? "active" : ""}`}
            title="Only lines of the topic whose table is shown"
            onClick={() => setFollowTopic((f) => !f)}
          >
            {followTopic ? `only ${selectedTopic}` : "all topics"}
          </button>
        )}
      </div>

      <div className="table-wrap log-scroll">
        {mode === "live" ? (
          <LogTable
            lines={live}
            hideDevice={deviceId !== null}
            hideTopic={topic !== null}
            empty="No log lines yet. Press Demo or start pnpm sim."
          />
        ) : (
          <SavedLogs
            deviceId={deviceId}
            topic={topic}
            level={minLevel === "debug" ? "info" : minLevel}
          />
        )}
      </div>
    </section>
  );
}

function SavedLogs(props: { deviceId: string | null; topic: string | null; level: SavedLevel }) {
  const { deviceId, topic, level } = props;
  const [rows, setRows] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(
    (beforeId: number | null) => {
      setLoading(true);
      fetchLogs({ deviceId, topic, level, beforeId, limit: PAGE })
        .then((page) => {
          setRows((r) => (beforeId === null ? page : [...r, ...page]));
          setMore(page.length === PAGE);
          setError(null);
        })
        .catch((err: unknown) =>
          setError(
            err instanceof ApiError && err.code === "storage_not_configured"
              ? "Storage is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY in .dev.vars)."
              : String(err),
          ),
        )
        .finally(() => setLoading(false));
    },
    [deviceId, topic, level],
  );

  useEffect(() => load(null), [load]);

  return (
    <>
      <div className="toolbar compact">
        <span className="muted small">
          {rows.length} saved line(s){loading ? " · loading…" : ""}
        </span>
        <button type="button" className="ghost" onClick={() => load(null)}>
          Refresh
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      <LogTable
        lines={rows.map(fromRow)}
        hideDevice={deviceId !== null}
        hideTopic={topic !== null}
        withDate
        empty={loading ? "Loading…" : "No saved lines for this filter."}
      />
      {more && (
        <button
          type="button"
          className="ghost more"
          disabled={loading}
          onClick={() => load(rows.at(-1)?.id ?? null)}
        >
          Load older
        </button>
      )}
    </>
  );
}
