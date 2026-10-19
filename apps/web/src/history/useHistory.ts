import { useEffect, useState } from "react";
import {
  fetchHistory,
  type HistoryKind,
  type HistoryRows,
  type MessageCategory,
  type Range,
} from "../api.js";

export interface HistoryState<T> {
  rows: T[];
  loading: boolean;
  error: string | null;
}

/** Loads one history section; refetches when the device, range or category changes. */
export function useHistory<K extends HistoryKind>(
  deviceId: string | null,
  kind: K,
  range: Range,
  category: MessageCategory | null = null,
): HistoryState<HistoryRows[K]> {
  const [state, setState] = useState<HistoryState<HistoryRows[K]>>({
    rows: [],
    loading: false,
    error: null,
  });
  const from = range.from.getTime();
  const to = range.to.getTime();

  useEffect(() => {
    if (!deviceId) {
      setState({ rows: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchHistory(deviceId, kind, { from: new Date(from), to: new Date(to) }, { category })
      .then((rows) => !cancelled && setState({ rows, loading: false, error: null }))
      .catch(
        (err: unknown) => !cancelled && setState({ rows: [], loading: false, error: String(err) }),
      );
    return () => {
      cancelled = true;
    };
  }, [deviceId, kind, from, to, category]);

  return state;
}
