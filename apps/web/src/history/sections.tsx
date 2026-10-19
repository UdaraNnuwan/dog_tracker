import { useMemo, useState, type ReactNode } from "react";
import {
  MESSAGE_CATEGORIES,
  clearHistory,
  toEpoch,
  type GpsRow,
  type MessageCategory,
  type Range,
} from "../api.js";
import { downloadCsv } from "./csv.js";
import { TimeSeriesChart } from "./TimeSeriesChart.js";
import { TrackMap } from "./TrackMap.js";
import { useHistory, type HistoryState } from "./useHistory.js";

interface SectionProps {
  deviceId: string;
  range: Range;
}

const dateTime = (iso: string) => new Date(iso).toLocaleString();
const fixed = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined ? "—" : v.toFixed(digits);

/**
 * Loading / error / empty states shared by all sections. `children` is a function so the
 * content is only built once there are rows.
 */
function Status({ state, children }: { state: HistoryState<unknown>; children: () => ReactNode }) {
  if (state.error) return <p className="error">Could not load: {state.error}</p>;
  if (state.loading && state.rows.length === 0) return <p className="muted">Loading…</p>;
  if (state.rows.length === 0) return <p className="muted">No data in this time range.</p>;
  return <>{children()}</>;
}

function Toolbar({ count, onCsv }: { count: number; onCsv: () => void }) {
  return (
    <div className="toolbar">
      <span className="muted small">{count} row(s)</span>
      <button type="button" className="ghost" onClick={onCsv} disabled={count === 0}>
        Download CSV
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ location

function trackStats(points: GpsRow[]) {
  let meters = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
    const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.latitude * Math.PI) / 180) *
        Math.cos((b.latitude * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    meters += 2 * 6_371_000 * Math.asin(Math.sqrt(h));
  }
  const maxSpeed = Math.max(0, ...points.map((p) => p.speed ?? 0));
  return { km: meters / 1000, maxKmh: maxSpeed * 3.6 };
}

export function LocationSection({ deviceId, range }: SectionProps) {
  const state = useHistory(deviceId, "gps", range);
  const [focus, setFocus] = useState<number | null>(null);
  const stats = useMemo(() => trackStats(state.rows), [state.rows]);
  return (
    <>
      <TrackMap points={state.rows} focus={focus} />
      <Status state={state}>
        {() => (
          <>
            <div className="stats">
              <span>
                Distance <b>{stats.km.toFixed(2)} km</b>
              </span>
              <span>
                Max speed <b>{stats.maxKmh.toFixed(1)} km/h</b>
              </span>
              <span>
                From <b>{dateTime(state.rows[0]!.ts)}</b> to{" "}
                <b>{dateTime(state.rows.at(-1)!.ts)}</b>
              </span>
            </div>
            <Toolbar
              count={state.rows.length}
              onCsv={() => downloadCsv(`${deviceId}-location.csv`, state.rows)}
            />
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Device time</th>
                    <th>Latitude</th>
                    <th>Longitude</th>
                    <th>Speed</th>
                    <th>Accuracy</th>
                    <th>Sats</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {[...state.rows].reverse().map((p, i) => {
                    const index = state.rows.length - 1 - i;
                    return (
                      <tr
                        key={p.ts}
                        onMouseEnter={() => setFocus(index)}
                        onMouseLeave={() => setFocus(null)}
                      >
                        <td>{dateTime(p.ts)}</td>
                        <td>{p.latitude.toFixed(6)}</td>
                        <td>{p.longitude.toFixed(6)}</td>
                        <td>{p.speed === null ? "—" : `${(p.speed * 3.6).toFixed(1)} km/h`}</td>
                        <td>{p.accuracy === null ? "—" : `${p.accuracy} m`}</td>
                        <td>{p.satellites ?? "—"}</td>
                        <td className="muted">{dateTime(p.received_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Status>
    </>
  );
}

// ------------------------------------------------------------------ battery & temperature

export function BatterySection({ deviceId, range }: SectionProps) {
  const state = useHistory(deviceId, "battery", range);
  const chart = useMemo(
    () => ({
      x: state.rows.map((r) => toEpoch(r.ts)),
      series: [
        {
          label: "Battery",
          unit: "%",
          color: "#15803d",
          values: state.rows.map((r) => r.percentage),
        },
        {
          label: "Temperature",
          unit: "°C",
          color: "#dc2626",
          values: state.rows.map((r) => r.temperature),
        },
      ],
    }),
    [state.rows],
  );
  return (
    <Status state={state}>
      {() => (
        <>
          <TimeSeriesChart x={chart.x} series={chart.series} />
          <Toolbar
            count={state.rows.length}
            onCsv={() => downloadCsv(`${deviceId}-battery.csv`, state.rows)}
          />
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Device time</th>
                  <th>Battery</th>
                  <th>Temperature</th>
                  <th>Voltage</th>
                  <th>Charging</th>
                </tr>
              </thead>
              <tbody>
                {[...state.rows].reverse().map((r) => (
                  <tr key={r.ts}>
                    <td>{dateTime(r.ts)}</td>
                    <td>{r.percentage}%</td>
                    <td>{r.temperature === null ? "—" : `${fixed(r.temperature, 1)} °C`}</td>
                    <td>{fixed(r.voltage, 2)} V</td>
                    <td>{r.charging ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Status>
  );
}

// ------------------------------------------------------------------ signal

export function SignalSection({ deviceId, range }: SectionProps) {
  const state = useHistory(deviceId, "signal", range);
  const chart = useMemo(
    () => ({
      x: state.rows.map((r) => toEpoch(r.ts)),
      series: [
        { label: "RSSI", unit: "dBm", color: "#2563eb", values: state.rows.map((r) => r.rssi) },
        { label: "RSRP", unit: "dBm", color: "#7c3aed", values: state.rows.map((r) => r.rsrp) },
        { label: "SINR", unit: "dB", color: "#d97706", values: state.rows.map((r) => r.sinr) },
      ],
    }),
    [state.rows],
  );
  return (
    <Status state={state}>
      {() => (
        <>
          <TimeSeriesChart x={chart.x} series={chart.series} />
          <Toolbar
            count={state.rows.length}
            onCsv={() => downloadCsv(`${deviceId}-signal.csv`, state.rows)}
          />
        </>
      )}
    </Status>
  );
}

// ------------------------------------------------------------------ events & status

function summarise(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return String(payload);
  return Object.entries(payload)
    .filter(([k]) => k !== "timestamp" && k !== "protocol_version")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export function MessagesSection({ deviceId, range }: SectionProps) {
  const [category, setCategory] = useState<MessageCategory | null>(null);
  const state = useHistory(deviceId, "messages", range, category);
  return (
    <>
      <div className="chips">
        {[null, ...MESSAGE_CATEGORIES].map((c) => (
          <button
            key={c ?? "all"}
            type="button"
            className={`chip ${category === c ? "active" : ""}`}
            onClick={() => setCategory(c)}
          >
            {c ?? "all"}
          </button>
        ))}
      </div>
      <Status state={state}>
        {() => (
          <>
            <Toolbar
              count={state.rows.length}
              onCsv={() => downloadCsv(`${deviceId}-${category ?? "messages"}.csv`, state.rows)}
            />
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Device time</th>
                    <th>Topic</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {state.rows.map((m) => (
                    <tr key={m.id} className={`cat-${m.category ?? ""}`}>
                      <td>{dateTime(m.ts)}</td>
                      <td>
                        <b>{m.topic}</b>
                      </td>
                      <td className="details">{summarise(m.payload)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Status>
    </>
  );
}

// ------------------------------------------------------------------ data management

export function DataSection({
  deviceId,
  onCleared,
}: {
  deviceId: string | null;
  onCleared: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const clear = async (target: string | null) => {
    const what = target ? `all stored data of ${target}` : "ALL stored data of EVERY device";
    if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
    setBusy(true);
    setResult(null);
    try {
      const deleted = await clearHistory(target);
      setResult(`Deleted ${deleted} row(s).`);
      onCleared();
    } catch (err) {
      setResult(`Failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="danger-zone">
      <h3>Clear stored data</h3>
      <p className="muted small">
        Removes history (location, battery, signal, events, rejected messages) from the database and
        the live view. Devices nobody is a member of are removed too. New messages are stored again
        as they arrive.
      </p>
      <div className="row">
        <button
          type="button"
          className="danger"
          disabled={!deviceId || busy}
          onClick={() => void clear(deviceId)}
        >
          Clear {deviceId ?? "selected device"}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void clear(null)}>
          Clear all devices
        </button>
      </div>
      {result && <p className="small">{result}</p>}
    </div>
  );
}
