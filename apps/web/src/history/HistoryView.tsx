import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchDevices, type DeviceRow, type Range } from "../api.js";
import {
  BatterySection,
  DataSection,
  LocationSection,
  MessagesSection,
  SignalSection,
} from "./sections.js";

const PRESETS = [
  { label: "1 hour", ms: 3600_000 },
  { label: "6 hours", ms: 6 * 3600_000 },
  { label: "24 hours", ms: 24 * 3600_000 },
  { label: "7 days", ms: 7 * 24 * 3600_000 },
  { label: "30 days", ms: 30 * 24 * 3600_000 },
] as const;

const SECTIONS = [
  { id: "location", label: "Location" },
  { id: "battery", label: "Battery & temperature" },
  { id: "signal", label: "Signal" },
  { id: "messages", label: "Events & status" },
  { id: "data", label: "Data" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** `<input type="datetime-local">` value in local time. */
const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

const lastMs = (ms: number): Range => {
  const to = new Date();
  return { from: new Date(to.getTime() - ms), to };
};

/** Stored data per device: pick a device and a time range, then a section (ADR 0006). */
export function HistoryView() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [presetMs, setPresetMs] = useState<number | null>(PRESETS[2].ms);
  const [range, setRange] = useState<Range>(() => lastMs(PRESETS[2].ms));
  const [section, setSection] = useState<SectionId>("location");

  const loadDevices = useCallback(() => {
    fetchDevices()
      .then((list) => {
        setDevices(list);
        setDevicesError(null);
        setDeviceId((current) =>
          current && list.some((d) => d.id === current) ? current : (list[0]?.id ?? null),
        );
      })
      .catch((err: unknown) =>
        setDevicesError(
          err instanceof ApiError && err.code === "storage_not_configured"
            ? "Storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY in .env and restart pnpm dev."
            : String(err),
        ),
      );
  }, []);

  useEffect(loadDevices, [loadDevices]);

  /** Re-runs the current preset up to "now", or keeps a custom range. */
  const refresh = () => {
    if (presetMs !== null) setRange(lastMs(presetMs));
    else setRange((r) => ({ ...r }));
    loadDevices();
  };

  return (
    <div className="history">
      <div className="panel filters">
        <label>
          Device
          <select value={deviceId ?? ""} onChange={(e) => setDeviceId(e.target.value || null)}>
            {devices.length === 0 && <option value="">no devices stored</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}
                {d.connectivity ? ` (${d.connectivity})` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="chips">
          {PRESETS.map((p) => (
            <button
              key={p.ms}
              type="button"
              className={`chip ${presetMs === p.ms ? "active" : ""}`}
              onClick={() => {
                setPresetMs(p.ms);
                setRange(lastMs(p.ms));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label>
          From
          <input
            type="datetime-local"
            value={toLocalInput(range.from)}
            onChange={(e) => {
              const from = new Date(e.target.value);
              if (Number.isNaN(from.getTime())) return;
              setPresetMs(null);
              setRange((r) => ({ ...r, from }));
            }}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={toLocalInput(range.to)}
            onChange={(e) => {
              const to = new Date(e.target.value);
              if (Number.isNaN(to.getTime())) return;
              setPresetMs(null);
              setRange((r) => ({ ...r, to }));
            }}
          />
        </label>
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </div>

      {devicesError && <p className="error panel">{devicesError}</p>}

      <nav className="tabs sub">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={section === s.id ? "active" : ""}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <section className="panel">
        {section === "data" ? (
          <DataSection deviceId={deviceId} onCleared={loadDevices} />
        ) : !deviceId ? (
          <p className="muted">
            No stored devices yet. Start the bridge and run <code>pnpm sim</code> or{" "}
            <code>pnpm replay</code>.
          </p>
        ) : section === "location" ? (
          <LocationSection deviceId={deviceId} range={range} />
        ) : section === "battery" ? (
          <BatterySection deviceId={deviceId} range={range} />
        ) : section === "signal" ? (
          <SignalSection deviceId={deviceId} range={range} />
        ) : (
          <MessagesSection deviceId={deviceId} range={range} />
        )}
      </section>
    </div>
  );
}
