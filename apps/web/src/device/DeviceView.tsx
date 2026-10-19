import { topicDocs, type RequestStatus, type TopicDoc } from "@udara/contracts";
import { useEffect, useMemo, useState } from "react";
import { DemoControl } from "../live/DemoControl.js";
import { ago, clock, formatField } from "../live/format.js";
import { DeviceMap } from "../live/DeviceMap.js";
import { LogPanel } from "../live/LogPanel.js";
import {
  asPayload,
  batteryPercent,
  connectivity,
  sortDevices,
  type DeviceView as Device,
} from "../live/model.js";
import { TopicLog } from "../live/TopicLog.js";
import { useLiveFeed } from "../live/useLiveFeed.js";
import { useNowSeconds } from "../live/useNow.js";
import { SendModal, STATE_CLASS } from "../topics/SendModal.js";
import { controlsFor, type Control } from "./controls.js";
import { pinsFor } from "./pins.js";

/** Topics whose section shows the map: the trail, plus their own points as pins. */
const MAP_TOPICS = new Set(["telemetry/gps", "response/location", "event/geofence"]);

const ALL = "__all";
const OTHER = "__other";

/**
 * One device at a time (ADR 0009): a side list of every subscribed topic, the selected
 * topic's table with the settings and commands that belong to it, and that topic's log
 * lines. Works before any device exists: pick one from the list or type an id.
 */
export function DeviceView() {
  const { model, status } = useLiveFeed();
  const now = useNowSeconds();
  const catalogue = useMemo(topicDocs, []);
  const docs = useMemo(
    () => new Map(catalogue.map((d) => [`${d.direction}/${d.path}`, d])),
    [catalogue],
  );
  // Every subscribed topic gets a tab, data or not.
  const allTopics = useMemo(
    () => catalogue.filter((d) => d.direction === "backend").map((d) => d.path),
    [catalogue],
  );
  const devices = useMemo(() => sortDevices(Object.values(model.devices)), [model.devices]);
  const [deviceId, setDeviceId] = useState("");
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [sending, setSending] = useState<TopicDoc | null>(null);

  // Start on the first device that shows up, unless the user already typed one.
  const [touched, setTouched] = useState(false);
  // "Other id…": a device that hasn't sent anything yet (e.g. before sending it a command).
  const [other, setOther] = useState(false);
  useEffect(() => {
    if (!touched && !deviceId && devices[0]) setDeviceId(devices[0].deviceId);
  }, [devices, deviceId, touched]);

  const id = deviceId.trim().toLowerCase();
  const device = (id && model.devices[id]) || null;
  const known = devices.some((d) => d.deviceId === id);
  const showOther = other || (id !== "" && !known);
  const selectValue = showOther ? OTHER : id === "" ? ALL : id;
  const docFor = (path: string) => docs.get(`device/${path}`);

  if (status === "disabled") {
    return (
      <main className="notice">
        <h2>Device view is disabled</h2>
        <p>
          Set <code>LIVE_VIEW_UNAUTHENTICATED=true</code> in <code>.env</code>,
          restart <code>pnpm dev</code> and open the app on <code>localhost</code>.
        </p>
      </main>
    );
  }

  return (
    <div className="device-view">
      <header className="topbar">
        <label className="device-pick">
          Device
          <select
            value={selectValue}
            onChange={(e) => {
              setTouched(true);
              const v = e.target.value;
              setOther(v === OTHER);
              if (v !== OTHER) setDeviceId(v === ALL ? "" : v);
            }}
          >
            <option value={ALL}>All devices</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.deviceId} · {connectivity(d)}
              </option>
            ))}
            <option value={OTHER}>Other id…</option>
          </select>
          {showOther && (
            <input
              className="text"
              placeholder="type a device id"
              autoFocus
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            />
          )}
        </label>
        {device ? (
          <DeviceSummary device={device} now={now} />
        ) : (
          <span className="muted small">
            {id ? `no data from ${id} yet` : "showing all devices"}
            {devices.length === 0 && " · press ▶ Demo or start pnpm sim"}
          </span>
        )}
        <DemoControl demo={model.demo} />
      </header>

      <div className="split device-split">
        <div className="split-main">
          <TopicLog
            byTopic={model.byTopic}
            deviceFilter={id || null}
            selectedTopic={selectedTopic}
            onSelectTopic={setSelectedTopic}
            alwaysShow={allTopics}
            renderExtra={(key) => (
              <>
                {MAP_TOPICS.has(key) && (
                  <section className="device-map">
                    <DeviceMap
                      devices={device ? [device] : devices}
                      selectedId={device?.deviceId ?? null}
                      onSelect={(d) => setDeviceId(d)}
                      pins={pinsFor(
                        key,
                        model.byTopic[key] ?? [],
                        model.byTopic["telemetry/gps"] ?? [],
                        id,
                      )}
                    />
                  </section>
                )}
                <ControlsCard
                  topicKey={key}
                  deviceId={id}
                  device={device}
                  requests={model.requests}
                  onOpen={(path) => {
                    const doc = docFor(path);
                    if (doc) setSending(doc);
                  }}
                />
              </>
            )}
          />
        </div>
        <LogPanel logs={model.logs} deviceId={id || null} selectedTopic={selectedTopic} />
      </div>

      {sending && (
        <SendModal
          doc={sending}
          devices={devices.map((d) => d.deviceId)}
          {...(id ? { initialDevice: id } : {})}
          requests={model.requests}
          onClose={() => setSending(null)}
        />
      )}
    </div>
  );
}

function DeviceSummary({ device, now }: { device: Device; now: number }) {
  const battery = batteryPercent(device);
  const fw = asPayload(device.latest["status/system"]?.data).firmware_version;
  return (
    <>
      <span className={`pill ${connectivity(device)}`}>{connectivity(device)}</span>
      <span className="muted small">
        {battery !== null ? `battery ${battery}% · ` : ""}
        {typeof fw === "string" ? `firmware ${fw} · ` : ""}
        last seen {ago(device.lastSeen, now)}
      </span>
    </>
  );
}

/** Settings and commands for the selected topic, with the last request's state. */
function ControlsCard(props: {
  topicKey: string;
  /** Typed or picked id; may be empty (the popup then asks for one). */
  deviceId: string;
  device: Device | null;
  requests: Record<string, RequestStatus>;
  onOpen: (path: string) => void;
}) {
  const { topicKey, deviceId, device, requests, onOpen } = props;
  const controls = controlsFor(topicKey);
  if (controls.length === 0) return null;
  return (
    <section className="controls-card">
      <h3>
        Settings &amp; commands <span className="muted small">for {topicKey}</span>
      </h3>
      <table className="data">
        <tbody>
          {controls.map((c) => (
            <ControlRow
              key={c.path}
              control={c}
              device={device}
              last={deviceId ? lastRequest(requests, deviceId, c.path) : null}
              onOpen={onOpen}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ControlRow(props: {
  control: Control;
  device: Device | null;
  last: RequestStatus | null;
  onOpen: (path: string) => void;
}) {
  const { control: c, device, last, onOpen } = props;
  const setting = c.path.match(/^settings\/(?:set|get)\/(.+)$/)?.[1];
  const reported = setting
    ? asPayload(device?.latest[`settings/response/${setting}`]?.data).value
    : undefined;
  return (
    <tr>
      <td>
        <b>{c.label}</b>
        <div className="muted small">{c.hint}</div>
      </td>
      <td className="small">
        {setting && (
          <div>
            current: <b>{reported === undefined ? "unknown" : formatField("value", reported)}</b>
          </div>
        )}
        {last ? (
          <div title={`request_id ${last.requestId}`}>
            last: <span className={`pill ${STATE_CLASS[last.state]}`}>{last.state}</span>{" "}
            <span className="muted">{clock(last.sentAt)}</span>
          </div>
        ) : (
          <span className="muted">not sent yet</span>
        )}
      </td>
      <td className="actions">
        <button type="button" onClick={() => onOpen(c.path)}>
          {c.path.startsWith("settings/get/")
            ? "Get…"
            : c.path.startsWith("settings/set/")
              ? "Set…"
              : "Send…"}
        </button>
      </td>
    </tr>
  );
}

function lastRequest(
  requests: Record<string, RequestStatus>,
  deviceId: string,
  path: string,
): RequestStatus | null {
  let last: RequestStatus | null = null;
  for (const r of Object.values(requests)) {
    if (r.deviceId === deviceId && r.path === path && (!last || r.sentAt >= last.sentAt)) last = r;
  }
  return last;
}
