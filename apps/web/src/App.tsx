import { useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { HistoryView } from "./history/HistoryView.js";
import { LiveView } from "./live/LiveView.js";
import "./live/live.css";
import "./history/history.css";

type Tab = "live" | "history";

// Until the real dashboard (phase 7): live view (ADR 0004) and stored history (ADR 0006).
export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash === "#history" ? "history" : "live"));
  const select = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };
  return (
    <ErrorBoundary>
      <nav className="tabs main">
        <button
          type="button"
          className={tab === "live" ? "active" : ""}
          onClick={() => select("live")}
        >
          Live
        </button>
        <button
          type="button"
          className={tab === "history" ? "active" : ""}
          onClick={() => select("history")}
        >
          History
        </button>
      </nav>
      {tab === "live" ? <LiveView /> : <HistoryView />}
    </ErrorBoundary>
  );
}
