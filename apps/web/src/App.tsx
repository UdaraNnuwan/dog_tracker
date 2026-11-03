import { lazy, Suspense, useEffect, useState } from "react";
import { AuthGate } from "./auth/AuthGate.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { HistoryView } from "./history/HistoryView.js";
import { LiveView } from "./live/LiveView.js";
import { LogsView } from "./logs/LogsView.js";
import "./live/live.css";
import "./history/history.css";
import "./logs/logs.css";
import "./topics/topics.css";
import "./device/device.css";
import "./auth/auth.css";
import "./firmware/firmware.css";

const TABS = [
  { id: "live", label: "Live", adminOnly: false },
  { id: "device", label: "Device", adminOnly: false },
  { id: "history", label: "History", adminOnly: false },
  { id: "logs", label: "Logs", adminOnly: false },
  { id: "topics", label: "Topics", adminOnly: false },
  // The firmware API is admin-only (ADR 0012).
  { id: "firmware", label: "Firmware", adminOnly: true },
] as const;
type Tab = (typeof TABS)[number]["id"];

// Loaded on demand: they pull in the Zod schemas (topic formats, send forms).
const DeviceView = lazy(() =>
  import("./device/DeviceView.js").then((m) => ({ default: m.DeviceView })),
);
const TopicsView = lazy(() =>
  import("./topics/TopicsView.js").then((m) => ({ default: m.TopicsView })),
);
const FirmwareView = lazy(() =>
  import("./firmware/FirmwareView.js").then((m) => ({ default: m.FirmwareView })),
);

const fromHash = (): Tab => TABS.find((t) => `#${t.id}` === location.hash)?.id ?? "live";

// Until the real dashboard (phase 7): live view (ADR 0004), per-device data and controls
// (ADR 0009), stored history (ADR 0006), saved processing logs and the topic catalogue
// (ADR 0008), and firmware releases for admins (ADR 0012).
export function App() {
  const [tab, setTab] = useState<Tab>(fromHash);
  // Links such as `#device` switch tabs too.
  useEffect(() => {
    const onHash = () => setTab(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const select = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };
  return (
    <ErrorBoundary>
      <AuthGate>
        {(me, signOut) => (
          <>
            <nav className="tabs main">
              {TABS.filter((t) => !t.adminOnly || me.user.role === "admin").map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={tab === t.id ? "active" : ""}
                  onClick={() => select(t.id)}
                >
                  {t.label}
                </button>
              ))}
              <span className="account">
                {me.user.username}
                {me.user.role === "admin" && <span className="pill ok">admin</span>}
                {!me.dev && (
                  <button type="button" className="ghost" onClick={signOut}>
                    Log out
                  </button>
                )}
              </span>
            </nav>
            {tab === "live" && <LiveView />}
            {tab === "history" && <HistoryView />}
            {tab === "logs" && <LogsView />}
            {(tab === "device" || tab === "topics") && (
              <Suspense fallback={<p className="muted notice">Loading…</p>}>
                {tab === "device" ? <DeviceView /> : <TopicsView />}
              </Suspense>
            )}
            {tab === "firmware" && me.user.role === "admin" && (
              <Suspense fallback={<p className="muted notice">Loading…</p>}>
                <FirmwareView />
              </Suspense>
            )}
          </>
        )}
      </AuthGate>
    </ErrorBoundary>
  );
}
