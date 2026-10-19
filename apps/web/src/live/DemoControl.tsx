import type { DemoStatus } from "@udara/contracts";
import { useState } from "react";
import { startDemo, stopDemo } from "../api.js";
import { useNowSeconds } from "./useNow.js";

/** Starts/stops the Demo run (ADR 0008); state comes live from the bridge. */
export function DemoControl({ demo }: { demo: DemoStatus }) {
  const now = useNowSeconds(1_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<DemoStatus>) => {
    setBusy(true);
    setError(null);
    action()
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false));
  };
  const left = demo.endsAt !== null ? Math.max(0, Math.ceil(demo.endsAt - now)) : 0;
  return (
    <span className="demo">
      {demo.running ? (
        <>
          <span className="pill ok">
            Demo: {demo.devices.join(", ")} · {left} s
          </span>
          <button type="button" className="ghost" disabled={busy} onClick={() => run(stopDemo)}>
            Stop demo
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy}
          title="Two fake collars for 60 s through the real pipeline: validation, live view, storage, logs"
          onClick={() => run(() => startDemo())}
        >
          ▶ Demo
        </button>
      )}
      {error && <span className="error small">{error}</span>}
    </span>
  );
}
