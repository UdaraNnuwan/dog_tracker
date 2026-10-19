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

const TABS = [
  { id: "live", label: "Live" },
  { id: "device", label: "Device" },
  { id: "history", label: "History" },
  { id: "logs", label: "Logs" },
  { id: "topics", label: "Topics" },
] as const;
type Tab = (typeof TABS)[number]["id"];

// Loaded on demand: they pull in the Zod schemas (topic formats, send forms).
const DeviceView = lazy(() =>
  import("./device/DeviceView.js").then((m) => ({ default: m.DeviceView })),
);
const TopicsView = lazy(() =>
  import("./topics/TopicsView.js").then((m) => ({ default: m.TopicsView })),
);

const fromHash = (): Tab => TABS.find((t) => `#${t.id}` === location.hash)?.id ?? "live";

// Until the real dashboard (phase 7): live view (ADR 0004), per-device data and controls
// (ADR 0009), stored history (ADR 0006), saved processing logs and the topic catalogue
// (ADR 0008).
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
              {TABS.map((t) => (
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
          </>
        )}
      </AuthGate>
    </ErrorBoundary>
  );
}
