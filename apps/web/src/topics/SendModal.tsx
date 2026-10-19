import type { RequestStatus, TopicDoc } from "@udara/contracts";
import { useEffect, useMemo, useState } from "react";
import { ApiError, sendToDevice } from "../api.js";
import { clock } from "../live/format.js";
import { prettyJson } from "../logs/lines.js";
import { schemaVariants, type FieldRow } from "./fields.js";
import {
  answerPath,
  editableFields,
  initialValues,
  previewPayload,
  toFields,
  type FormValue,
} from "./sendForm.js";

interface Props {
  doc: TopicDoc;
  /** Devices seen live, offered in the device picker. */
  devices: string[];
  /** Device to start with (the Device tab passes the selected one). */
  initialDevice?: string;
  /** Live request states by request_id (from `/api/live`). */
  requests: Record<string, RequestStatus>;
  onClose: () => void;
}

const OTHER = "__other";

export const STATE_CLASS: Record<RequestStatus["state"], string> = {
  pending: "warn",
  success: "ok",
  failed: "offline",
  rejected: "offline",
  unsupported: "offline",
  timeout: "offline",
  error: "offline",
};

/**
 * Popup to publish a command or settings request (ADR 0009): device + payload fields from
 * the topic's schema, a preview of the JSON, then the request's live state until the device
 * answers or it times out (rule 3).
 */
export function SendModal({ doc, devices, initialDevice, requests, onClose }: Props) {
  const fields: FieldRow[] = useMemo(() => schemaVariants(doc.schema)[0]?.fields ?? [], [doc]);
  const editable = editableFields(fields);
  const [deviceId, setDeviceId] = useState(initialDevice ?? devices[0] ?? "");
  // A device not seen live yet: typed by hand.
  const [otherDevice, setOtherDevice] = useState(
    initialDevice !== undefined && !devices.includes(initialDevice),
  );
  const example = doc.examples[0] ?? {};
  const [values, setValues] = useState<Record<string, FormValue>>(() => initialValues(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<{ message: string; issues: string[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const [firstStatus, setFirstStatus] = useState<RequestStatus | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const preview = previewPayload(toFields(fields, values).fields);
  const status = (sentId && requests[sentId]) || firstStatus;

  const submit = () => {
    const built = toFields(fields, values);
    setErrors(built.errors);
    setServerError(null);
    if (!deviceId.trim()) {
      setServerError({ message: "Pick or type a device id.", issues: [] });
      return;
    }
    if (Object.keys(built.errors).length) return;
    setBusy(true);
    sendToDevice(deviceId.trim().toLowerCase(), doc.path, built.fields)
      .then((s) => {
        setSentId(s.requestId);
        setFirstStatus(s);
      })
      .catch((err: unknown) =>
        setServerError(
          err instanceof ApiError
            ? { message: err.code, issues: err.issues }
            : { message: String(err), issues: [] },
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Send ${doc.path}`}>
        <header className="modal-head">
          <div>
            <h2>Send {doc.path}</h2>
            <code className="muted small">
              pettracker/device/{deviceId || "{device_id}"}/{doc.path}
            </code>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {status ? (
          <RequestView
            status={status}
            onAgain={() => {
              setSentId(null);
              setFirstStatus(null);
            }}
          />
        ) : (
          <>
            <div className="modal-body">
              <div className="form">
                <label>
                  Device
                  <select
                    value={otherDevice ? OTHER : deviceId}
                    onChange={(e) => {
                      const v = e.target.value;
                      setOtherDevice(v === OTHER);
                      setDeviceId(v === OTHER ? "" : v);
                    }}
                  >
                    {devices.length === 0 && !otherDevice && (
                      <option value="">no devices seen yet</option>
                    )}
                    {devices.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                    <option value={OTHER}>Other id…</option>
                  </select>
                  {otherDevice && (
                    <input
                      className="text"
                      placeholder="type a device id, e.g. sim01"
                      autoFocus
                      value={deviceId}
                      onChange={(e) => setDeviceId(e.target.value)}
                    />
                  )}
                </label>
                {editable.length === 0 && (
                  <p className="muted small">No fields: this request only carries the envelope.</p>
                )}
                {editable.map((f) => (
                  <FieldInput
                    key={f.name}
                    field={f}
                    example={example[f.name]}
                    value={values[f.name] ?? ""}
                    error={errors[f.name]}
                    onChange={(v) => setValues((old) => ({ ...old, [f.name]: v }))}
                  />
                ))}
              </div>
              <div>
                <div className="detail-label">JSON to publish (QoS 1, retain=false)</div>
                <pre className="json-preview">{JSON.stringify(preview, null, 2)}</pre>
              </div>
            </div>
            {serverError && (
              <div className="error small">
                <b>Not sent: {serverError.message}</b>
                {serverError.issues.length > 0 && (
                  <ul>
                    {serverError.issues.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <footer className="modal-foot">
              <span className="muted small">
                Answer expected on <code>{answerPath(doc.path)}</code> · 10 s timeout, 2 retries
                with the same request_id
              </span>
              <button type="button" className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={submit}>
                {busy ? "Sending…" : "Send"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function FieldInput(props: {
  field: FieldRow;
  /** Value from the spec example, shown as the placeholder. */
  example: unknown;
  value: FormValue;
  error: string | undefined;
  onChange: (v: FormValue) => void;
}) {
  const { field: f, example, value, error, onChange } = props;
  const label = (
    <span>
      {f.name}
      {f.required ? " *" : ""} <span className="muted">{f.rules}</span>
    </span>
  );
  if (f.input.kind === "boolean") {
    return (
      <label className="inline">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <label>
      {label}
      {f.input.kind === "enum" ? (
        <select value={text} onChange={(e) => onChange(e.target.value)}>
          {f.input.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="text"
          type={f.input.kind === "integer" || f.input.kind === "number" ? "number" : "text"}
          step={f.input.kind === "integer" ? 1 : "any"}
          min={"min" in f.input && f.input.min !== null ? f.input.min : undefined}
          max={"max" in f.input && f.input.max !== null ? f.input.max : undefined}
          placeholder={
            example !== undefined
              ? `e.g. ${typeof example === "string" ? example : JSON.stringify(example)}`
              : f.input.kind === "json"
                ? "JSON value"
                : f.type
          }
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error && <span className="error small">{error}</span>}
    </label>
  );
}

function RequestView({ status, onAgain }: { status: RequestStatus; onAgain: () => void }) {
  return (
    <>
      <div className="modal-body single">
        <div className="request-state">
          <span className={`pill ${STATE_CLASS[status.state]}`}>{status.state}</span>
          <span className="muted small">
            {status.deviceId} · attempt {status.attempts}/3 · sent {clock(status.sentAt)}
          </span>
        </div>
        <div className="muted small">
          request_id <code>{status.requestId}</code>
        </div>
        {status.state === "pending" && (
          <p className="muted small">Waiting for {status.responsePath}…</p>
        )}
        {status.error && <p className="error small">{status.error}</p>}
        <div className="json-columns">
          <div>
            <div className="detail-label">Published</div>
            <pre className="json-preview">{prettyJson(status.payload)}</pre>
          </div>
          <div>
            <div className="detail-label">Answer ({status.responsePath})</div>
            <pre className="json-preview">
              {status.response ? prettyJson(status.response) : "—"}
            </pre>
          </div>
        </div>
      </div>
      <footer className="modal-foot">
        <button type="button" className="ghost" onClick={onAgain}>
          Send another
        </button>
      </footer>
    </>
  );
}
