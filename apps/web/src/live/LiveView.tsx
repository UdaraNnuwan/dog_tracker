import { useEffect, useMemo, useState } from "react";
import { DeviceMap } from "./DeviceMap.js";
import { ago, clock, formatField } from "./format.js";
import { asPayload, batteryPercent, connectivity, sortDevices, type DeviceView } from "./model.js";
import { TopicLog } from "./TopicLog.js";
import { useLiveFeed, type FeedStatus } from "./useLiveFeed.js";

const CATEGORY_ORDER = ["telemetry", "status", "event", "response", "settings", "diagnostic"];

const FEED_LABEL: Record<FeedStatus, string> = {
  connecting: "connecting…",
  live: "live",
  reconnecting: "reconnecting…",
  disabled: "disabled",
};

function useNowSeconds(everyMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function useBridgeState(): string {
  const [state, setState] = useState("…");
  useEffect(() => {
    const load = () =>
      fetch("/api/health")
        .then((r) => r.json() as Promise<{ bridge: { state: string } }>)
        .then((h) => setState(h.bridge.state))
        .catch(() => setState("unreachable"));
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, []);
  return state;
}

/**
 * Development live view (ADR 0004): every validated MQTT message as it arrives.
 * Replaced by the real dashboard in phase 7.
 */
export function LiveView() {
  const { model, status } = useLiveFeed();
  const bridge = useBridgeState();
  const now = useNowSeconds();
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [onlySelectedLog, setOnlySelectedLog] = useState(false);

  const devices = useMemo(() => sortDevices(Object.values(model.devices)), [model.devices]);
  const visible = devices.filter((d) => d.deviceId.includes(filter.trim().toLowerCase()));
  const selected = (selectedId && model.devices[selectedId]) || null;

  // Select the first device once data arrives.
  useEffect(() => {
    if (!selectedId && devices[0]) setSelectedId(devices[0].deviceId);
  }, [devices, selectedId]);

  const log = onlySelectedLog ? model.log.filter((e) => e.deviceId === selectedId) : model.log;

  return (
    <div className="live">
      <header className="topbar">
        <h1>Smart Dog Collar</h1>
        <span className={`pill ${bridge === "ready" ? "ok" : "warn"}`}>MQTT bridge: {bridge}</span>
        <span className={`pill ${status === "live" ? "ok" : "warn"}`}>
          Live feed: {FEED_LABEL[status]}
        </span>
        <span className="muted">
          {devices.length} device(s) · {model.rejected} rejected message(s)
        </span>
        <span className="dev-badge" title="ADR 0004">
          dev live view · no login
        </span>
      </header>

      {status === "disabled" ? (
        <main className="notice">
          <h2>Live view is disabled</h2>
          <p>
            It only runs locally until login exists (phase 5). Set{" "}
            <code>LIVE_VIEW_UNAUTHENTICATED=true</code> in <code>apps/worker/.dev.vars</code>,
            restart <code>pnpm dev</code> and open the app on <code>localhost</code>.
          </p>
        </main>
      ) : (
        <main className="grid">
          <aside className="panel devices">
            <input
              className="search"
              placeholder="Filter devices…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {visible.length === 0 && (
              <p className="muted small">
                No devices yet. Start fake collars with <code>pnpm sim --devices 3</code>.
              </p>
            )}
            <ul>
              {visible.map((d) => (
                <DeviceRow
                  key={d.deviceId}
                  device={d}
                  now={now}
                  selected={d.deviceId === selectedId}
                  onSelect={setSelectedId}
                />
              ))}
            </ul>
          </aside>

          <section className="panel map-panel">
            <DeviceMap devices={devices} selectedId={selectedId} onSelect={setSelectedId} />
          </section>

          <section className="panel readings">
            {selected ? (
              <Readings device={selected} now={now} />
            ) : (
              <p className="muted">Select a device to see its latest data.</p>
            )}
          </section>

          <section className="panel log">
            <div className="log-head">
              <h2>Messages</h2>
              <label className="small">
                <input
                  type="checkbox"
                  checked={onlySelectedLog}
                  onChange={(e) => setOnlySelectedLog(e.target.checked)}
                />{" "}
                selected device only
              </label>
            </div>
            <ol>
              {log.map((e) => (
                <li key={e.seq} className={e.ok ? "" : "rejected"}>
                  <span className="muted">{clock(e.at)}</span> <b>{e.label}</b>
                  <code>{e.body}</code>
                </li>
              ))}
            </ol>
          </section>

          <TopicLog byTopic={model.byTopic} deviceFilter={onlySelectedLog ? selectedId : null} />
        </main>
      )}
    </div>
  );
}

function DeviceRow(props: {
  device: DeviceView;
  now: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { device, now, selected, onSelect } = props;
  const battery = batteryPercent(device);
  return (
    <li>
      <button
        type="button"
        className={`device ${selected ? "selected" : ""}`}
        onClick={() => onSelect(device.deviceId)}
      >
        <span className={`dot ${connectivity(device)}`} title={connectivity(device)} />
        <span className="id">{device.deviceId}</span>
        <span className="muted small">
          {battery !== null ? `${battery}% · ` : ""}
          {ago(device.lastSeen, now)}
        </span>
      </button>
    </li>
  );
}

function Readings({ device, now }: { device: DeviceView; now: number }) {
  const keys = Object.keys(device.latest).sort((a, b) => {
    const rank = (k: string) => {
      const i = CATEGORY_ORDER.indexOf(k.split("/")[0] ?? "");
      return i < 0 ? CATEGORY_ORDER.length : i;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return (
    <>
      <h2>
        {device.deviceId}{" "}
        <span className={`pill ${connectivity(device)}`}>{connectivity(device)}</span>
      </h2>
      <Summary device={device} now={now} />
      <div className="cards">
        {keys.map((key) => {
          const reading = device.latest[key]!;
          const fields = Object.entries(asPayload(reading.data)).filter(
            ([k]) => k !== "protocol_version",
          );
          return (
            <article key={key} className={`card ${key.split("/")[0]}`}>
              <header>
                <b>{key}</b>
                <span className="muted small">{ago(reading.receivedAt, now)}</span>
              </header>
              <table>
                <tbody>
                  {fields.map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{formatField(k, v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          );
        })}
      </div>
    </>
  );
}

/** The values people look for first: where the dog is and how the collar is doing. */
function Summary({ device, now }: { device: DeviceView; now: number }) {
  const gps = device.latest["telemetry/gps"];
  const pos = asPayload(gps?.data);
  const battery = asPayload(device.latest["telemetry/battery"]?.data);
  const signal = asPayload(device.latest["telemetry/signal_strength"]?.data);
  const geofence = asPayload(device.latest["event/geofence"]?.data);
  const num = (v: unknown) => (typeof v === "number" ? v : null);

  const lat = num(pos.latitude);
  const lon = num(pos.longitude);
  const speed = num(pos.speed);
  const temperature = num(battery.temperature);
  const percent = num(battery.percentage);
  const rssi = num(signal.rssi);

  return (
    <dl className="summary">
      <div className="wide">
        <dt>Location</dt>
        <dd>
          {lat !== null && lon !== null ? (
            <>
              <a
                href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`}
                target="_blank"
                rel="noreferrer"
              >
                {lat.toFixed(6)}, {lon.toFixed(6)}
              </a>
              <span className="muted small"> · {ago(gps!.receivedAt, now)}</span>
            </>
          ) : (
            "no fix yet"
          )}
        </dd>
      </div>
      <div>
        <dt>Temperature</dt>
        <dd>{temperature !== null ? `${temperature.toFixed(1)} °C` : "—"}</dd>
      </div>
      <div>
        <dt>Battery</dt>
        <dd>
          {percent !== null ? `${percent}%` : "—"}
          {battery.charging === true && <span className="muted small"> charging</span>}
        </dd>
      </div>
      <div>
        <dt>Speed</dt>
        <dd>{speed !== null ? `${(speed * 3.6).toFixed(1)} km/h` : "—"}</dd>
      </div>
      <div>
        <dt>Signal</dt>
        <dd>{rssi !== null ? `${rssi} dBm` : "—"}</dd>
      </div>
      <div>
        <dt>Geofence</dt>
        <dd>
          {typeof geofence.event === "string"
            ? `${geofence.event} ${typeof geofence.geofence_id === "string" ? geofence.geofence_id : ""}`
            : "—"}
        </dd>
      </div>
    </dl>
  );
}
