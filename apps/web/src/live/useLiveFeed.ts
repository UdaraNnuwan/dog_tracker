import type { LiveEvent } from "@udara/contracts";
import { useEffect, useReducer, useState } from "react";
import { authHeaders } from "../api.js";
import { accessToken } from "../auth/session.js";
import { emptyModel, reduce } from "./model.js";

export type FeedStatus = "connecting" | "live" | "reconnecting" | "disabled";

const RETRY_MS = 3_000;

/**
 * Subscribes to `/api/live` and folds its events into a `LiveModel`. Reconnects after drops.
 * A plain GET first tells "disabled" (401: dev flag off / not localhost, ADR 0004) apart from
 * "temporarily unreachable", which a failed WebSocket can't.
 */
export function useLiveFeed() {
  const [model, dispatch] = useReducer(reduce, emptyModel);
  const [status, setStatus] = useState<FeedStatus>("connecting");

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const scheduleRetry = () => {
      if (closed) return;
      setStatus("reconnecting");
      retry = setTimeout(() => void connect(), RETRY_MS);
    };

    const connect = async () => {
      try {
        const probe = await fetch("/api/live", { headers: await authHeaders() });
        if (probe.status === 401) {
          setStatus("disabled");
          return;
        }
      } catch {
        scheduleRetry();
        return;
      }
      if (closed) return;

      const scheme = location.protocol === "https:" ? "wss" : "ws";
      // Browsers can't set headers on a WebSocket: the token goes in the subprotocol (ADR 0010).
      const token = await accessToken();
      if (closed) return;
      ws = new WebSocket(
        `${scheme}://${location.host}/api/live`,
        token ? ["dogtracker.bearer", token] : undefined,
      );
      ws.onopen = () => setStatus("live");
      ws.onmessage = (e) => {
        try {
          dispatch(JSON.parse(String(e.data)) as LiveEvent);
        } catch {
          // Ignore malformed frames; the next snapshot/message resyncs.
        }
      };
      ws.onclose = scheduleRetry;
    };

    void connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { model, status };
}
