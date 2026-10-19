import { beforeEach, describe, expect, it, vi } from "vitest";
import { PacketReader, encodePublish } from "../src/mqtt/codec.js";
import { MqttSession, type InboundMessage, type SessionOptions } from "../src/mqtt/session.js";

/** Records what the session sends; `types()` returns the MQTT packet type of each frame. */
class FakeTransport {
  sent: Uint8Array[] = [];
  closed = false;
  send(bytes: Uint8Array) {
    this.sent.push(bytes);
  }
  close() {
    this.closed = true;
  }
  types(): number[] {
    return this.sent.map((b) => (b[0] ?? 0) >> 4);
  }
  last(): Uint8Array {
    const b = this.sent.at(-1);
    if (!b) throw new Error("nothing sent");
    return b;
  }
}

const CONNACK_OK = Uint8Array.of(0x20, 2, 0, 0);
const SUBACK_OK = Uint8Array.of(0x90, 3, 0, 1, 1);
const PINGRESP = Uint8Array.of(0xd0, 0);
const text = (s: string) => new TextEncoder().encode(s);

describe("MqttSession", () => {
  let clock: number;
  let transport: FakeTransport;
  let messages: InboundMessage[];
  let closedWith: string[];
  let ready: number;
  let opts: SessionOptions;

  beforeEach(() => {
    clock = 1_000_000;
    transport = new FakeTransport();
    messages = [];
    closedWith = [];
    ready = 0;
    opts = {
      clientId: "bridge",
      username: "u",
      password: "p",
      keepAliveSeconds: 60,
      cleanSession: false,
      subscriptions: [{ filter: "pettracker/backend/#", qos: 1 }],
      maxPacketBytes: 1024,
      now: () => clock,
      log: vi.fn(),
      onMessage: (m) => messages.push(m),
      onReady: () => ready++,
      onClosed: (r) => closedWith.push(r),
    };
  });

  function readySession(): MqttSession {
    const s = new MqttSession(transport, opts);
    s.start();
    s.receive(CONNACK_OK);
    s.receive(SUBACK_OK);
    return s;
  }

  /** A ready session with the handshake bytes cleared from the transport. */
  let current: MqttSession;
  beforeEach(() => {
    current = readySession();
    transport.sent = [];
    ready = 0;
  });

  it("delivers QoS 1 messages and acknowledges them", () => {
    current.receive(
      encodePublish({
        topic: "pettracker/backend/dog001/event/tamper",
        payload: text("{}"),
        qos: 1,
        retain: false,
        packetId: 42,
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.topic).toBe("pettracker/backend/dog001/event/tamper");
    expect([...transport.last()]).toEqual([0x40, 2, 0, 42]); // PUBACK
  });

  it("connects, subscribes, then becomes ready", () => {
    const s = new MqttSession(transport, opts);
    s.start();
    expect(transport.types()).toEqual([1]); // CONNECT
    s.receive(CONNACK_OK);
    expect(s.state).toBe("subscribing");
    expect(transport.types()).toEqual([1, 8]); // + SUBSCRIBE
    s.receive(SUBACK_OK);
    expect(s.state).toBe("ready");
    expect(ready).toBe(1);
  });

  it("closes when the broker refuses the connection", () => {
    const s = new MqttSession(transport, opts);
    s.start();
    s.receive(Uint8Array.of(0x20, 2, 0, 5));
    expect(s.state).toBe("closed");
    expect(closedWith).toEqual(["connect refused: not authorized"]);
    expect(transport.closed).toBe(true);
  });

  it("closes when the subscription is refused", () => {
    const s = new MqttSession(transport, opts);
    s.start();
    s.receive(CONNACK_OK);
    s.receive(Uint8Array.of(0x90, 3, 0, 1, 0x80));
    expect(closedWith).toEqual(["subscription refused"]);
  });

  it("still acknowledges when the handler throws (rule 4)", () => {
    opts.onMessage = () => {
      throw new Error("boom");
    };
    const s = readySession();
    transport.sent = [];
    s.receive(
      encodePublish({ topic: "t", payload: text("x"), qos: 1, retain: false, packetId: 3 }),
    );
    expect([...transport.last()]).toEqual([0x40, 2, 0, 3]);
    expect(s.state).toBe("ready");
    expect(opts.log).toHaveBeenCalledWith("error", "mqtt message handler threw", expect.anything());
  });

  it("does not acknowledge QoS 0 messages", () => {
    current.receive(encodePublish({ topic: "t", payload: text("x"), qos: 0, retain: false }));
    expect(messages).toHaveLength(1);
    expect(transport.sent).toHaveLength(0);
  });

  it("publishes with QoS 1 and retain=false, resolving on PUBACK", async () => {
    const done = current.publish("pettracker/device/dog001/command/reboot", text("{}"));
    const pkt = transport.last();
    expect((pkt[0] ?? 0) & 0x0f).toBe(0x02); // QoS 1, no retain, no dup
    const decoded = new PacketReader(1024).push(pkt);
    const packetId = decoded[0]?.type === "publish" ? decoded[0].packetId : undefined;
    expect(packetId).toBeTypeOf("number");
    current.receive(Uint8Array.of(0x40, 2, 0, packetId ?? 0));
    await expect(done).resolves.toBeUndefined();
  });

  it("rejects in-flight publishes when the connection drops", async () => {
    const done = current.publish("pettracker/device/dog001/command/reboot", text("{}"));
    current.close("socket closed (1006)");
    await expect(done).rejects.toThrow(/socket closed/);
    expect(closedWith).toEqual(["socket closed (1006)"]);
  });

  it("refuses to publish before ready", async () => {
    const s = new MqttSession(new FakeTransport(), opts);
    s.start();
    await expect(s.publish("t", text("x"))).rejects.toThrow(/not connected/);
  });

  it("pings after half the keep-alive and closes when PINGRESP never arrives", () => {
    clock += 29_000;
    current.tick();
    expect(transport.sent).toHaveLength(0);
    clock += 1_000;
    current.tick();
    expect(transport.types()).toEqual([12]); // PINGREQ
    current.receive(PINGRESP);
    clock += 30_000;
    current.tick();
    expect(transport.types()).toEqual([12, 12]);
    clock += 61_000;
    current.tick();
    expect(current.state).toBe("closed");
    expect(closedWith).toEqual(["ping timeout"]);
  });

  it("times out waiting for CONNACK", () => {
    const s = new MqttSession(transport, opts);
    s.start();
    clock += 31_000;
    s.tick();
    expect(closedWith).toEqual(["connack timeout"]);
  });

  it("closes on a protocol error and reports once", () => {
    current.receive(Uint8Array.of(0x10, 0)); // CONNECT from the broker is illegal
    current.receive(PINGRESP);
    current.close("again");
    expect(closedWith).toHaveLength(1);
    expect(closedWith[0]).toMatch(/unexpected packet type/);
  });

  it("sends DISCONNECT on graceful close", () => {
    current.close("shutdown", true);
    expect(transport.types()).toEqual([14]);
  });
});
