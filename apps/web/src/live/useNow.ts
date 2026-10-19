import { useEffect, useState } from "react";

/** Current epoch seconds, refreshed every `everyMs`. */
export function useNowSeconds(everyMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
