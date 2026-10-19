import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clock, formatField } from "./format.js";
import { REJECTED_KEY, type TopicEntry } from "./model.js";

const CATEGORY_ORDER = ["telemetry", "status", "event", "response", "settings", "diagnostic"];
/** Envelope fields shown elsewhere (time column) or not useful per row. */
const HIDDEN_FIELDS = new Set(["timestamp", "protocol_version"]);

interface Props {
  byTopic: Record<string, TopicEntry[]>;
  /** When set, only this device's rows are shown. */
  deviceFilter: string | null;
  /** Topic whose table is shown (and whose log lines the log column follows, ADR 0008). */
  selectedTopic: string | null;
  onSelectTopic: (key: string) => void;
  /** Extra content under the selected topic's table (the Device tab's controls). */
  renderExtra?: (key: string) => ReactNode;
  /** Topics listed even before any data arrived (the Device tab lists the whole catalogue). */
  alwaysShow?: readonly string[];
}

const categoryOf = (key: string) => (key === REJECTED_KEY ? "rejected" : (key.split("/")[0] ?? ""));

function rank(key: string): number {
  if (key === REJECTED_KEY) return CATEGORY_ORDER.length + 1;
  const i = CATEGORY_ORDER.indexOf(categoryOf(key));
  return i < 0 ? CATEGORY_ORDER.length : i;
}

/** Union of payload fields across rows, in first-seen order: the table's columns. */
function columnsOf(rows: TopicEntry[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.data)) if (!HIDDEN_FIELDS.has(k)) seen.add(k);
  return [...seen];
}

/**
 * Live data per topic (ADR 0004): a side list of topics grouped by category, and the table of
 * the selected topic only (columns = its payload fields, newest row first).
 */
export function TopicLog({
  byTopic,
  deviceFilter,
  selectedTopic,
  onSelectTopic,
  renderExtra,
  alwaysShow,
}: Props) {
  const [paused, setPaused] = useState(false);
  // While paused, keep showing what was on screen when Pause was pressed.
  const frozen = useRef(byTopic);
  if (!paused) frozen.current = byTopic;
  const shown = frozen.current;

  const sections = useMemo(() => {
    const keys = new Set([...(alwaysShow ?? []), ...Object.keys(shown)]);
    return [...keys]
      .map((key) => {
        const rows = shown[key] ?? [];
        return { key, rows: deviceFilter ? rows.filter((r) => r.deviceId === deviceFilter) : rows };
      })
      .filter((s) => s.rows.length > 0 || alwaysShow?.includes(s.key))
      .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
  }, [shown, deviceFilter, alwaysShow]);

  const current = sections.find((s) => s.key === selectedTopic) ?? sections[0] ?? null;

  // Keep the parent's selection (which drives the log column) in step with what is shown.
  useEffect(() => {
    if (current && current.key !== selectedTopic) onSelectTopic(current.key);
  }, [current, selectedTopic, onSelectTopic]);

  const groups = useMemo(() => {
    const out: { category: string; items: typeof sections }[] = [];
    for (const s of sections) {
      const category = categoryOf(s.key);
      const last = out.at(-1);
      if (last?.category === category) last.items.push(s);
      else out.push({ category, items: [s] });
    }
    return out;
  }, [sections]);

  return (
    <section className="panel topic-log">
      <div className="log-head">
        <h2>
          Telemetry data
          <span className="muted small">
            {deviceFilter ? `device ${deviceFilter}` : "all devices"} · last 100 per topic
          </span>
        </h2>
        <button
          type="button"
          className={paused ? "" : "ghost"}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>

      {sections.length === 0 ? (
        <p className="muted">No messages yet. Press ▶ Demo or start pnpm sim.</p>
      ) : (
        <div className="topic-split">
          <nav className="topic-list" aria-label="Topics">
            {groups.map((g) => (
              <div key={g.category} className="topic-group">
                <div className="topic-group-title">{g.category}</div>
                {g.items.map(({ key, rows }) => (
                  <button
                    key={key}
                    type="button"
                    className={`topic-item ${g.category} ${current?.key === key ? "active" : ""} ${rows.length ? "" : "empty"}`}
                    onClick={() => onSelectTopic(key)}
                  >
                    <span className="name">
                      {key === REJECTED_KEY ? key : key.slice(key.indexOf("/") + 1)}
                    </span>
                    <span className="muted small">
                      {rows[0] ? `${rows.length} · ${clock(rows[0].at)}` : "no data yet"}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          {current && (
            <div className="topic-main">
              <article className={`topic-card ${categoryOf(current.key)}`}>
                <div className="topic-title">
                  <b>{current.key}</b>
                  <span className="muted small">
                    {current.rows[0]
                      ? `${current.rows.length} row(s) · newest ${clock(current.rows[0].at)}`
                      : "no data yet"}
                  </span>
                </div>
                {current.rows.length > 0 ? (
                  <TopicTable rows={current.rows} showDevice={!deviceFilter} />
                ) : (
                  <p className="muted small empty-topic">
                    No messages on this topic yet{deviceFilter ? ` from ${deviceFilter}` : ""}.
                  </p>
                )}
              </article>
              {renderExtra?.(current.key)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TopicTable({ rows, showDevice }: { rows: TopicEntry[]; showDevice: boolean }) {
  const columns = columnsOf(rows);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Time</th>
            {showDevice && <th>Device</th>}
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
              {showDevice && <td>{r.deviceId ?? "—"}</td>}
              {columns.map((c) => (
                <td key={c}>{c in r.data ? formatField(c, r.data[c]) : ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
