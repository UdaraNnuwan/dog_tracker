import {
  FIRMWARE_FILE_EXTENSION,
  FIRMWARE_MAX_BYTES,
  firmwareVersion,
  isFirmwareFileName,
} from "@udara/contracts";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  ApiError,
  deleteFirmware,
  fetchDevices,
  fetchFirmware,
  setActiveFirmware,
  uploadFirmware,
  type DeviceRow,
  type FirmwareRelease,
} from "../api.js";
import { collarFirmwareState, formatBytes, versionFromFileName } from "./status.js";

const STATE_LABEL = {
  current: { text: "up to date", pill: "ok" },
  update: { text: "will update", pill: "warn" },
  downloading: { text: "downloading", pill: "warn" },
  downloaded: { text: "downloaded, waiting to install", pill: "warn" },
  unknown: { text: "version not reported yet", pill: "unknown" },
  none: { text: "no active release", pill: "unknown" },
} as const;

const SECTIONS = [
  { id: "upload", label: "Upload" },
  { id: "releases", label: "Releases" },
  { id: "collars", label: "Collars" },
  { id: "api", label: "How collars update" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const errorText = (err: unknown) =>
  err instanceof ApiError && err.code === "storage_not_configured"
    ? "Storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY in .env and restart pnpm dev."
    : err instanceof ApiError && err.code === "forbidden"
      ? "Only admins can manage firmware."
      : err instanceof ApiError && err.code.startsWith("firmware storage is not set up")
        ? "Firmware storage is not set up in Supabase yet: run supabase/migrations/20261102100000_firmware_releases.sql in the Supabase SQL Editor (or `npx supabase db push --linked`), then Refresh."
        : err instanceof Error
          ? err.message.replace(/^\d+ /, "")
          : String(err);

/**
 * Firmware releases for over-the-air updates (ADR 0012): upload a file with its version,
 * choose the release offered to collars, and see which collars will update on their next
 * `GET /api/firmware/check`.
 */
export function FirmwareView() {
  const [releases, setReleases] = useState<FirmwareRelease[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<SectionId>("upload");

  const load = useCallback(() => {
    Promise.all([fetchFirmware(), fetchDevices()])
      .then(([r, d]) => {
        setReleases(r);
        setDevices(d);
        setError(null);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  /** Runs an action, then reloads; resolves to whether it succeeded. */
  const run = (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    return action()
      .then(() => {
        load();
        return true;
      })
      .catch((err: unknown) => {
        setError(errorText(err));
        return false;
      })
      .finally(() => setBusy(false));
  };

  const active = releases.find((r) => r.active) ?? null;

  return (
    <div className="history firmware-view">
      <nav className="tabs sub">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={section === s.id ? "active" : ""}
            onClick={() => setSection(s.id)}
          >
            {s.label}
            {s.id === "releases" && releases.length > 0 && ` (${releases.length})`}
            {s.id === "collars" && devices.length > 0 && ` (${devices.length})`}
          </button>
        ))}
      </nav>

      {error && (
        <p className="error panel">
          {error}{" "}
          <button type="button" className="ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}

      {section === "upload" && (
        <UploadForm
          busy={busy}
          onUpload={async (input) => {
            const ok = await run(() => uploadFirmware(input));
            // Show the new release in the list.
            if (ok) setSection("releases");
            return ok;
          }}
        />
      )}

      {section === "releases" && (
        <section className="panel">
          <div className="toolbar">
            <h3>Releases</h3>
            <span className="muted small">
              {active
                ? `Offered to collars: ${active.version}`
                : "No release is offered to collars."}
            </span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>File</th>
                  <th>Size</th>
                  <th>SHA-256</th>
                  <th>Uploaded</th>
                  <th>Notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {releases.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      No firmware uploaded yet.
                    </td>
                  </tr>
                )}
                {releases.map((r) => (
                  <tr key={r.id} className={r.active ? "active-release" : ""}>
                    <td>
                      <b>{r.version}</b> {r.active && <span className="pill ok">active</span>}
                    </td>
                    <td>{r.file_name}</td>
                    <td>{formatBytes(r.size_bytes)}</td>
                    <td>
                      <code title={r.sha256}>{r.sha256.slice(0, 12)}…</code>
                    </td>
                    <td>
                      {new Date(r.uploaded_at).toLocaleString()}
                      <span className="muted"> · {r.uploaded_by}</span>
                    </td>
                    <td className="details">{r.notes}</td>
                    <td className="actions">
                      {r.active ? (
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => void run(() => setActiveFirmware(null))}
                        >
                          Stop offering
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => setActiveFirmware(r.id))}
                        >
                          Make active
                        </button>
                      )}{" "}
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Delete firmware ${r.version} and its file?`)) {
                            void run(() => deleteFirmware(r.id));
                          }
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {section === "collars" && (
        <section className="panel">
          <div className="toolbar">
            <h3>Collars</h3>
            <button type="button" className="ghost" onClick={load}>
              Refresh
            </button>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Reported firmware</th>
                  <th>Update</th>
                  <th>Last download</th>
                </tr>
              </thead>
              <tbody>
                {devices.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No collars stored yet.
                    </td>
                  </tr>
                )}
                {devices.map((d) => {
                  const state = collarFirmwareState(d.firmware_version, active?.version ?? null, {
                    version: d.firmware_download_version,
                    state: d.firmware_download_state,
                  });
                  const label = STATE_LABEL[state];
                  return (
                    <tr key={d.id}>
                      <td>{d.name ?? d.id}</td>
                      <td>{d.firmware_version ?? "—"}</td>
                      <td>
                        <span className={`pill ${label.pill}`}>{label.text}</span>
                        {(state === "update" ||
                          state === "downloading" ||
                          state === "downloaded") &&
                          active && <span className="muted"> → {active.version}</span>}
                      </td>
                      <td>
                        {d.firmware_download_version && d.firmware_download_at ? (
                          <>
                            {d.firmware_download_version} · {d.firmware_download_state}
                            <span className="muted">
                              {" "}
                              · {new Date(d.firmware_download_at).toLocaleString()}
                            </span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {section === "api" && (
        <section className="panel collar-api">
          <h3>How collars update</h3>
          <p className="muted small">
            The collar calls the API below with its current version, over HTTPS with its client
            certificate (subject CN = device_id). When the version differs from the active release
            it gets <code>update: true</code>, downloads <code>download_url</code> with the same
            certificate and checks the file against <code>sha256</code> before flashing.
          </p>
          <pre>
            {`GET /api/firmware/check?device_id=collar-01&version=1.0.0

{ "update": false, "version": "1.0.0" }
{ "update": true, "version": "1.1.0", "size_bytes": 1048576,
  "sha256": "9f86d0…", "download_url": "https://…/api/firmware/download/1.1.0?device_id=collar-01" }`}
          </pre>
        </section>
      )}
    </div>
  );
}

interface UploadInput {
  version: string;
  file: File;
  notes: string;
  activate: boolean;
}

function UploadForm({
  busy,
  onUpload,
}: {
  busy: boolean;
  onUpload: (i: UploadInput) => Promise<boolean>;
}) {
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [activate, setActivate] = useState(true);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const choose = (f: File | null) => {
    setFile(f);
    // `collar-1.2.0.bin` fills in 1.2.0 unless a version was typed already.
    const guess = f && versionFromFileName(f.name);
    if (guess && !version.trim()) setVersion(guess);
  };
  const clearFile = () => {
    setFile(null);
    if (input.current) input.current.value = "";
  };

  // A file dropped next to the zone would otherwise make the browser open it.
  useEffect(() => {
    const block = (e: globalThis.DragEvent) => e.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files;
    if (dropped.length) choose(dropped[0] ?? null);
  };

  const versionOk = firmwareVersion.safeParse(version.trim()).success;
  const wrongType = file !== null && !isFirmwareFileName(file.name);
  const tooBig = file !== null && file.size > FIRMWARE_MAX_BYTES;
  const fileProblem = wrongType
    ? `Only ${FIRMWARE_FILE_EXTENSION} files can be uploaded`
    : tooBig
      ? `File is larger than ${formatBytes(FIRMWARE_MAX_BYTES)}`
      : null;
  const problem = version && !versionOk ? "Version must be SemVer, e.g. 1.2.0" : fileProblem;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || !versionOk || fileProblem) return;
    void onUpload({ version: version.trim(), file, notes, activate }).then((ok) => {
      if (!ok) return;
      setVersion("");
      setNotes("");
      clearFile();
    });
  };

  return (
    <form className="panel firmware-upload" onSubmit={submit}>
      <h3>Upload firmware</h3>
      <div
        className={`dropzone${dragging ? " dragging" : ""}${file ? " has-file" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Choose a firmware file"
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          // Ignore leaving into a child element.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <input
          ref={input}
          type="file"
          accept={FIRMWARE_FILE_EXTENSION}
          hidden
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <>
            <span className="file-name">{file.name}</span>
            <span className={fileProblem ? "error small" : "muted small"}>
              {fileProblem ?? formatBytes(file.size)}
            </span>
            <button
              type="button"
              className="ghost"
              onClick={(e) => {
                e.stopPropagation();
                clearFile();
              }}
            >
              Remove
            </button>
          </>
        ) : (
          <>
            <span className="drop-title">
              {dragging
                ? "Drop the file here"
                : `Drag & drop the firmware ${FIRMWARE_FILE_EXTENSION} file here`}
            </span>
            <span className="muted small">
              or click to browse · {FIRMWARE_FILE_EXTENSION} only · max{" "}
              {formatBytes(FIRMWARE_MAX_BYTES)}
            </span>
          </>
        )}
      </div>

      <div className="filters">
        <label>
          Version
          <input
            className="text"
            placeholder="e.g. 1.2.0"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />
        </label>
        <label className="grow">
          Notes
          <input
            className="text"
            placeholder="what changed (optional)"
            value={notes}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={activate}
            onChange={(e) => setActivate(e.target.checked)}
          />{" "}
          offer to collars now
        </label>
        <button type="submit" disabled={busy || !file || !versionOk || fileProblem !== null}>
          {busy ? "Uploading…" : "Upload"}
        </button>
        {problem && <span className="error small">{problem}</span>}
      </div>
    </form>
  );
}
