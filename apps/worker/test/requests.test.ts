import type { RequestStatus } from "@udara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestTracker, responsePathFor, type TrackerEvent } from "../src/bridge/requests.js";

function setup(send: (r: RequestStatus) => Promise<void> = () => Promise.resolve()) {
  const events: [TrackerEvent, RequestStatus][] = [];
  const sent: RequestStatus[] = [];
  const tracker = new RequestTracker({
    send: (r) => {
      sent.push({ ...r });
      return send(r);
    },
    onUpdate: (r, e) => events.push([e, r]),
    now: () => Math.floor(Date.now() / 1000),
    random: () => 0, // backoff = 5 s
  });
  return { tracker, events, sent };
}

const req = {
  requestId: "11111111-2222-3333-4444-555555555555",
  deviceId: "demo01",
  path: "command/buzzer",
  responsePath: "response/buzzer",
  payload:
    '{"timestamp":1,"request_id":"11111111-2222-3333-4444-555555555555","enabled":true,"duration":3}',
};

describe("responsePathFor", () => {
  it("maps commands and settings to their response topics", () => {
    expect(responsePathFor("command/reboot")).toBe("response/reboot");
    expect(responsePathFor("settings/set/gps_interval")).toBe("settings/response/gps_interval");
    expect(responsePathFor("settings/get/gps_interval")).toBe("settings/response/gps_interval");
    expect(responsePathFor("telemetry/gps")).toBeNull();
  });
});

describe("RequestTracker (rule 3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("completes on the matching response and ignores duplicates", async () => {
    const { tracker, events } = setup();
    expect(await tracker.start(req)).toMatchObject({ state: "pending", attempts: 1 });
    const answer = { timestamp: 2, request_id: req.requestId, status: "success" };
    // Wrong device or wrong topic doesn't match.
    expect(tracker.handleResponse("demo02", "response/buzzer", answer)).toBe(false);
    expect(tracker.handleResponse("demo01", "response/reboot", answer)).toBe(false);
    expect(tracker.handleResponse("demo01", "response/buzzer", answer)).toBe(true);
    expect(tracker.handleResponse("demo01", "response/buzzer", answer)).toBe(true);
    expect(events.map(([e, r]) => `${e}:${r.state}`)).toEqual([
      "sent:pending",
      "response:success",
      "duplicate:success",
    ]);
    expect(tracker.list()[0]).toMatchObject({ state: "success", response: JSON.stringify(answer) });
    vi.advanceTimersByTime(60_000); // no retries after success
    expect(events).toHaveLength(3);
  });

  it("retries twice with the same request_id, then times out", async () => {
    const { tracker, events, sent } = setup();
    await tracker.start(req);
    await vi.advanceTimersByTimeAsync(10_000 + 5_000); // ack timeout + backoff → retry 1
    await vi.advanceTimersByTimeAsync(10_000 + 5_000); // → retry 2
    await vi.advanceTimersByTimeAsync(10_000); // → timeout
    expect(sent.map((s) => s.requestId)).toEqual([req.requestId, req.requestId, req.requestId]);
    expect(events.map(([e, r]) => `${e}:${r.state}:${r.attempts}`)).toEqual([
      "sent:pending:1",
      "retry:pending:2",
      "retry:pending:3",
      "timeout:timeout:3",
    ]);
  });

  it("reports failed sends as error", async () => {
    const { tracker } = setup(() => Promise.reject(new Error("mqtt not connected")));
    expect(await tracker.start(req)).toMatchObject({ state: "error", error: "mqtt not connected" });
  });

  it("treats a device's failure answer as final", async () => {
    const { tracker } = setup();
    await tracker.start(req);
    tracker.handleResponse("demo01", "response/buzzer", {
      request_id: req.requestId,
      status: "failed",
      error_code: "busy",
    });
    expect(tracker.list()[0]!.state).toBe("failed");
  });
});
