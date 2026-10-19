import { useState } from "react";
import { clock } from "../live/format.js";
import { prettyJson, type LogLine } from "./lines.js";

interface Props {
  lines: LogLine[];
  /** Columns to hide when a filter already fixes them. */
  hideDevice?: boolean;
  hideTopic?: boolean;
  showSource?: boolean;
  /** Show the date too (saved logs span days). */
  withDate?: boolean;
  empty: string;
}

const dateTime = (epochS: number) => new Date(epochS * 1000).toLocaleString();

/** Log lines as a table with each message's JSON; clicking a row expands it. */
export function LogTable({ lines, hideDevice, hideTopic, showSource, withDate, empty }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  if (lines.length === 0) return <p className="muted small">{empty}</p>;
  const columns = 4 + (hideDevice ? 0 : 1) + (hideTopic ? 0 : 1) + (showSource ? 1 : 0);
  return (
    <table className="data logs-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Level</th>
          {showSource && <th>Source</th>}
          {!hideDevice && <th>Device</th>}
          {!hideTopic && <th>Topic</th>}
          <th>Message</th>
          <th>JSON</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <LogRowView
            key={l.key}
            line={l}
            columns={columns}
            open={open === l.key}
            onToggle={() => setOpen((k) => (k === l.key ? null : l.key))}
            hideDevice={!!hideDevice}
            hideTopic={!!hideTopic}
            showSource={!!showSource}
            withDate={!!withDate}
          />
        ))}
      </tbody>
    </table>
  );
}

function LogRowView(props: {
  line: LogLine;
  columns: number;
  open: boolean;
  onToggle: () => void;
  hideDevice: boolean;
  hideTopic: boolean;
  showSource: boolean;
  withDate: boolean;
}) {
  const { line: l, open } = props;
  return (
    <>
      <tr className={`lvl-${l.level} ${open ? "open" : ""}`} onClick={props.onToggle}>
        <td>{props.withDate ? dateTime(l.at) : clock(l.at)}</td>
        <td>
          <span className={`lvl lvl-${l.level}`}>{l.level}</span>
        </td>
        {props.showSource && <td>{l.source}</td>}
        {!props.hideDevice && <td>{l.deviceId ?? "—"}</td>}
        {!props.hideTopic && <td>{l.topic ?? "—"}</td>}
        <td className="msg">{l.message}</td>
        <td className="json">{l.json !== null ? <code>{l.json}</code> : "—"}</td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={props.columns}>
            {l.json !== null && (
              <>
                <div className="detail-label">JSON as received</div>
                <pre>{prettyJson(l.json)}</pre>
              </>
            )}
            <div className="detail-label">Detail</div>
            <pre>{l.detail === null ? "(none)" : JSON.stringify(restOf(l.detail), null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

/** Detail without the payload text (shown above it, pretty-printed). */
function restOf(detail: unknown): unknown {
  if (detail === null || typeof detail !== "object") return detail;
  return Object.fromEntries(Object.entries(detail).filter(([k]) => k !== "payload"));
}
