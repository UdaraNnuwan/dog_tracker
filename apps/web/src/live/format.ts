/** UI-edge formatting. Payload timestamps are epoch seconds (rule 5). */

export function ago(epochS: number, nowS: number): string {
  if (!epochS) return "never";
  const s = Math.max(0, Math.round(nowS - epochS));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export const clock = (epochS: number) => new Date(epochS * 1000).toLocaleTimeString();

/** Units from the spec field tables (§5); speed is shown in km/h (CLAUDE.md §18 defaults). */
const UNITS: Record<string, string> = {
  voltage: "V",
  percentage: "%",
  temperature: "°C",
  accuracy: "m",
  rssi: "dBm",
  rsrp: "dBm",
  rsrq: "dB",
  sinr: "dB",
  uptime: "s",
  free_memory: "B",
  value: "",
};

export function formatField(key: string, value: unknown): string {
  if (key === "timestamp" && typeof value === "number") return clock(value);
  if (key === "speed" && typeof value === "number") return `${(value * 3.6).toFixed(1)} km/h`;
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(2) : String(v)}`)
      .join("  ");
  }
  const unit = UNITS[key];
  return unit ? `${String(value)} ${unit}` : String(value);
}
