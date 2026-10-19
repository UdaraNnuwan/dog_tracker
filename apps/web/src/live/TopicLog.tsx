import { useMemo, useRef, useState } from "react";
import { clock, formatField } from "./format.js";
import { REJECTED_KEY, type TopicEntry } from "./model.js";

const CATEGORY_ORDER = ["telemetry", "status", "event", "response", "settings", "diagnostic"];
/** Envelope fields shown elsewhere (time column) or not useful per row. */
const HIDDEN_FIELDS = new Set(["timestamp", "protocol_version"]);

interface Props {
  byTopic: Record<string, TopicEntry[]>;
  /** When set, only this device's rows are shown. */
  deviceFilter: string | null;
}

function rank(key: string): number {
  if (key === REJECTED_KEY) return CATEGORY_ORDER.length + 1;
  const i = CATEGORY_ORDER.indexOf(key.split("/")[0] ?? "");
  return i < 0 ? CATEGORY_ORDER.length : i;
}

/** Union of payload fields across rows, in first-seen order: the section's columns. */
function columnsOf(rows: TopicEntry[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.data)) if (!HIDDEN_FIELDS.has(k)) seen.add(k);
  return [...seen];
}

/**
 * Live messages as a log, one section per topic (ADR 0004): each section is a table whose
 * columns are that topic's payload fields, newest row first.
 */
export function TopicLog({ byTopic, deviceFilter }: Props) {
  const [paused, setPaused] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // While paused, keep showing what was on screen when Pause was pressed.
  const frozen = useRef(byTopic);
  if (!paused) frozen.current = byTopic;
  const shown = frozen.current;

  const sections = useMemo(
    () =>
      Object.entries(shown)
        .map(([key, rows]) => ({
          key,
          rows: deviceFilter ? rows.filter((r) => r.deviceId === deviceFilter) : rows,
        }))
        .filter((s) => s.rows.length > 0)
        .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)),
    [shown, deviceFilter],
  );

  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="panel topic-log">
      <div className="log-head">
        <h2>
          Live log by topic
          <span className="muted small">
            {deviceFilter ? `device ${deviceFilter}` : "all devices"} · last 100 per topic
          </span>
        </h2>
        <div className="row">
          <button type="button" className="ghost" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setCollapsed(new Set(sections.map((s) => s.key)))}
          >
            Collapse all
          </button>
          <button
            type="button"
            className={paused ? "" : "ghost"}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>
      {sections.length === 0 && <p className="muted">No messages yet.</p>}
      <div className="topic-grid">
        {sections.map(({ key, rows }) => {
          const columns = columnsOf(rows);
          const open = !collapsed.has(key);
          return (
            <article
              key={key}
              className={`topic-card ${key.split("/")[0]} ${open ? "" : "closed"}`}
            >
              <button type="button" className="topic-title" onClick={() => toggle(key)}>
                <span>
                  {open ? "▾" : "▸"} <b>{key}</b>
                </span>
                <span className="muted small">
                  {rows.length} · {clock(rows[0]!.at)}
                </span>
              </button>
              {open && (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Time</th>
                        {!deviceFilter && <th>Device</th>}
                        {columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.seq}>
                          <td>
                            {clock(typeof r.data.timestamp === "number" ? r.data.timestamp : r.at)}
                            {r.retained && <span className="muted"> (retained)</span>}
                          </td>
                          {!deviceFilter && <td>{r.deviceId ?? "—"}</td>}
                          {columns.map((c) => (
                            <td key={c}>{c in r.data ? formatField(c, r.data[c]) : ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
