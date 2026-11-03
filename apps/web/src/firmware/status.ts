import { needsUpdate } from "@udara/contracts";

/** `1536` → `1.5 KiB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** `collar-v1.2.0.bin` → `1.2.0`, `fw_1.3.0-rc.1.bin` → `1.3.0-rc.1`; null when none. */
export function versionFromFileName(name: string): string | null {
  const base = name.replace(/\.(bin|hex|img|ota|zip)$/i, "");
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(base)?.[1] ?? null;
}

export type CollarFirmwareState =
  | "current"
  | "update"
  | "downloading"
  | "downloaded"
  | "unknown"
  | "none";

/** The collar's last download, as the Worker records it on `devices`. */
export interface CollarDownload {
  version: string | null;
  state: string | null;
}

/**
 * Where a collar is with the active release (ADR 0012): `current` once it reports that
 * version; `downloading` / `downloaded` while it fetches it and until it reports it
 * installed; `update` when it will fetch it on its next check; `unknown` before it has
 * reported a version; `none` with no release.
 */
export function collarFirmwareState(
  reported: string | null,
  active: string | null,
  download: CollarDownload = { version: null, state: null },
): CollarFirmwareState {
  if (active === null) return "none";
  if (reported && !needsUpdate(reported, active)) return "current";
  if (download.version === active && download.state === "downloaded") return "downloaded";
  if (download.version === active && download.state === "downloading") return "downloading";
  if (!reported) return "unknown";
  return "update";
}
