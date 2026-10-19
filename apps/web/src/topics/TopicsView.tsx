import {
  INGEST_SUBSCRIPTION,
  topicDocs,
  type RequestStatus,
  type TopicDoc,
} from "@udara/contracts";
import { useMemo, useState } from "react";
import { clock } from "../live/format.js";
import { useLiveFeed } from "../live/useLiveFeed.js";
import { prettyJson } from "../logs/lines.js";
import { schemaVariants } from "./fields.js";
import { SendModal, STATE_CLASS } from "./SendModal.js";

const keyOf = (d: TopicDoc) => `${d.direction}/${d.path}`;

const DIRECTIONS = [
  {
    id: "backend",
    title: "Subscribed",
    hint: `device → cloud · the bridge subscribes to ${INGEST_SUBSCRIPTION}`,
  },
  {
    id: "device",
    title: "Published",
    hint: "cloud → device · only the bridge publishes, QoS 1, retain=false",
  },
] as const;

interface LastSeen {
  count: number;
  at: number;
  deviceId: string | null;
  json: string | null;
}

/**
 * Every MQTT topic of the spec (from `@udara/contracts`): what the backend subscribes to and
 * what it publishes, with the JSON format, spec example and JSON Schema of each payload, plus
 * the last message seen live on subscribed topics (ADR 0008).
 */
export function TopicsView() {
  const docs = useMemo(topicDocs, []);
  const { model } = useLiveFeed();
  const [selected, setSelected] = useState(() => keyOf(docs[0]!));
  const [filter, setFilter] = useState("");

  // Live counts and the newest raw JSON per subscribed topic, from the processing log.
  const seen = useMemo(() => {
    const out = new Map<string, LastSeen>();
    for (const l of model.logs) {
      if (l.source !== "ingest" || l.topic === null) continue;
      const key = `backend/${l.topic}`;
      const prev = out.get(key);
      if (prev) prev.count++;
      else {
        const payload = (l.detail as { payload?: unknown } | null)?.payload;
        out.set(key, {
          count: 1,
          at: l.at,
          deviceId: l.deviceId,
          json: typeof payload === "string" ? payload : null,
        });
      }
    }
    return out;
  }, [model.logs]);

  const q = filter.trim().toLowerCase();
  const current = docs.find((d) => keyOf(d) === selected) ?? docs[0]!;

  return (
    <div className="topics-view">
      <aside className="panel topics-nav">
        <input
          className="search"
          placeholder="Filter topics…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {DIRECTIONS.map((dir) => {
          const items = docs.filter((d) => d.direction === dir.id && d.path.includes(q));
          return (
            <div key={dir.id} className="topic-group">
              <div className="topics-dir">
                <b>{dir.title}</b> <span className="muted small">({items.length})</span>
                <div className="muted small">{dir.hint}</div>
              </div>
              {items.map((d) => {
                const live = seen.get(keyOf(d));
                return (
                  <button
                    key={keyOf(d)}
                    type="button"
                    className={`topic-item ${d.path.split("/")[0]} ${
                      keyOf(d) === keyOf(current) ? "active" : ""
                    }`}
                    onClick={() => setSelected(keyOf(d))}
                  >
                    <span className="name">{d.path}</span>
                    <span className="muted small">
                      QoS {d.qos}
                      {d.retain === true ? " · retained" : ""}
                      {live ? ` · ${live.count} live` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </aside>

      <TopicDetail
        doc={current}
        live={seen.get(keyOf(current)) ?? null}
        devices={Object.keys(model.devices).sort()}
        requests={model.requests}
      />
    </div>
  );
}

function TopicDetail(props: {
  doc: TopicDoc;
  live: LastSeen | null;
  devices: string[];
  requests: Record<string, RequestStatus>;
}) {
  const { doc, live, devices, requests } = props;
  const variants = schemaVariants(doc.schema);
  const subscribed = doc.direction === "backend";
  const [sending, setSending] = useState(false);
  // Requests sent on this topic, newest first.
  const sent = Object.values(requests)
    .filter((r) => r.path === doc.path)
    .sort((a, b) => b.sentAt - a.sentAt);
  return (
    <section className="panel topic-detail">
      <div className="topic-head">
        <span className={`pill ${subscribed ? "ok" : "warn"}`}>
          {subscribed ? "Subscribe · device → cloud" : "Publish · cloud → device"}
        </span>
        <code className="topic-name">{doc.topic}</code>
        <CopyButton text={doc.topic} />
        {!subscribed && (
          <button type="button" className="send-btn" onClick={() => setSending(true)}>
            Send…
          </button>
        )}
      </div>
      {sending && (
        <SendModal
          doc={doc}
          devices={devices}
          requests={requests}
          onClose={() => setSending(false)}
        />
      )}
      <dl className="summary">
        <div>
          <dt>QoS</dt>
          <dd>{doc.qos}</dd>
        </div>
        <div>
          <dt>Retain</dt>
          <dd>{doc.retain === "optional" ? "optional" : doc.retain ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Spec</dt>
          <dd>{doc.sections.length ? doc.sections.map((s) => `§${s}`).join(", ") : "—"}</dd>
        </div>
        <div>
          <dt>{subscribed ? "Seen live" : "Sent"}</dt>
          <dd>{subscribed ? (live?.count ?? 0) : sent.length}</dd>
        </div>
      </dl>

      <h3>JSON fields</h3>
      {variants.map((v, i) => (
        <div key={i} className="variant">
          {v.label && <div className="detail-label">{v.label}</div>}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Rules</th>
                </tr>
              </thead>
              <tbody>
                {v.fields.map((f) => (
                  <tr key={f.name}>
                    <td>
                      <code>{f.name}</code>
                    </td>
                    <td>
                      <code>{f.type}</code>
                    </td>
                    <td>{f.required ? "yes" : "no"}</td>
                    <td className="details">{f.rules}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {v.open && (
            <p className="muted small">Free-form: any other fields are accepted (spec §9).</p>
          )}
        </div>
      ))}
      <p className="muted small">
        Unknown extra fields are ignored (spec §15). <code>timestamp</code> is epoch seconds.
      </p>

      <div className="json-columns">
        <div>
          <h3>
            Example JSON <span className="muted small">from the spec</span>
          </h3>
          {doc.examples.length === 0 ? (
            <p className="muted small">The spec gives no example for this topic.</p>
          ) : (
            doc.examples.map((ex, i) => <JsonBlock key={i} text={JSON.stringify(ex, null, 2)} />)
          )}
        </div>
        <div>
          <h3>
            {subscribed ? "Last received" : "Sent requests"}{" "}
            <span className="muted small">live</span>
          </h3>
          {!subscribed ? (
            <SentList sent={sent} onSend={() => setSending(true)} />
          ) : live?.json ? (
            <>
              <p className="muted small">
                {live.deviceId ?? "unknown device"} · {clock(live.at)}
              </p>
              <JsonBlock text={prettyJson(live.json)} />
            </>
          ) : (
            <p className="muted small">
              No message on this topic since the page opened. Press ▶ Demo on the Live tab.
            </p>
          )}
        </div>
      </div>

      <details className="schema">
        <summary>JSON Schema (draft 2020-12)</summary>
        <JsonBlock text={JSON.stringify(doc.schema, null, 2)} />
      </details>
    </section>
  );
}

/** Requests on this topic: state, attempts and the device's answer. */
function SentList({ sent, onSend }: { sent: RequestStatus[]; onSend: () => void }) {
  if (sent.length === 0) {
    return (
      <p className="muted small">
        Nothing sent on this topic since the bridge started.{" "}
        <button type="button" className="ghost" onClick={onSend}>
          Send…
        </button>
      </p>
    );
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Sent</th>
            <th>Device</th>
            <th>State</th>
            <th>Tries</th>
            <th>Answer</th>
          </tr>
        </thead>
        <tbody>
          {sent.slice(0, 20).map((r) => (
            <tr key={r.requestId} title={`request_id ${r.requestId}`}>
              <td>{clock(r.sentAt)}</td>
              <td>{r.deviceId}</td>
              <td>
                <span className={`pill ${STATE_CLASS[r.state]}`}>{r.state}</span>
              </td>
              <td>{r.attempts}</td>
              <td className="json">
                <code>{r.response ?? r.error ?? "—"}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonBlock({ text }: { text: string }) {
  return (
    <div className="json-block">
      <CopyButton text={text} />
      <pre>{text}</pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ghost copy"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1_200);
        })
      }
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}
