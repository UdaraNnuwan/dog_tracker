import { describe, expect, it } from "vitest";
import {
  MqttProtocolError,
  PacketReader,
  encodeConnect,
  encodePuback,
  encodePublish,
  encodeRemainingLength,
  encodeSubscribe,
} from "../src/mqtt/codec.js";

const bytes = (...xs: number[]) => Uint8Array.from(xs);
const text = (s: string) => new TextEncoder().encode(s);

describe("remaining length", () => {
  it.each([
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [16_383, [0xff, 0x7f]],
    [16_384, [0x80, 0x80, 0x01]],
    [268_435_455, [0xff, 0xff, 0xff, 0x7f]],
  ])("encodes %i", (n, expected) => {
    expect([...encodeRemainingLength(n)]).toEqual(expected);
  });

  it("rejects out-of-range lengths", () => {
    expect(() => encodeRemainingLength(268_435_456)).toThrow(MqttProtocolError);
  });
});

describe("encode", () => {
  it("CONNECT matches the 3.1.1 wire format", () => {
    const pkt = encodeConnect({
      clientId: "c",
      keepAliveSeconds: 60,
      cleanSession: false,
      username: "u",
      password: "p",
    });
    expect([...pkt]).toEqual([
      0x10,
      19, // CONNECT, remaining length
      0x00,
      0x04,
      ...text("MQTT"),
      0x04, // protocol name + level 4
      0xc0, // username + password, clean session off
      0x00,
      60, // keep alive
      0x00,
      0x01,
      ...text("c"),
      0x00,
      0x01,
      ...text("u"),
      0x00,
      0x01,
      ...text("p"),
    ]);
  });

  it("CONNECT refuses a password without username", () => {
    expect(() =>
      encodeConnect({ clientId: "c", keepAliveSeconds: 60, cleanSession: true, password: "p" }),
    ).toThrow(MqttProtocolError);
  });

  it("PUBLISH QoS 1 without retain", () => {
    const pkt = encodePublish({
      topic: "a/b",
      payload: text("{}"),
      qos: 1,
      retain: false,
      packetId: 10,
    });
    expect([...pkt]).toEqual([0x32, 9, 0x00, 0x03, ...text("a/b"), 0x00, 0x0a, ...text("{}")]);
  });

  it("PUBLISH QoS 1 requires a packet id", () => {
    expect(() => encodePublish({ topic: "a", payload: bytes(), qos: 1, retain: false })).toThrow(
      MqttProtocolError,
    );
  });

  it("SUBSCRIBE uses reserved flags 0b0010", () => {
    const pkt = encodeSubscribe(1, [{ filter: "a/#", qos: 1 }]);
    expect([...pkt]).toEqual([0x82, 8, 0x00, 0x01, 0x00, 0x03, ...text("a/#"), 0x01]);
  });

  it("PUBACK", () => {
    expect([...encodePuback(0x1234)]).toEqual([0x40, 0x02, 0x12, 0x34]);
  });
});

describe("PacketReader", () => {
  const publishQos1 = bytes(0x32, 8, 0x00, 0x03, ...text("a/b"), 0x00, 0x07, ...text("x"));

  it("decodes CONNACK and SUBACK", () => {
    const r = new PacketReader(1024);
    expect(r.push(bytes(0x20, 0x02, 0x01, 0x00))).toEqual([
      { type: "connack", sessionPresent: true, returnCode: 0 },
    ]);
    expect(r.push(bytes(0x90, 0x03, 0x00, 0x01, 0x01))).toEqual([
      { type: "suback", packetId: 1, returnCodes: [1] },
    ]);
  });

  it("decodes a QoS 1 retained duplicate PUBLISH", () => {
    const r = new PacketReader(1024);
    const [p] = r.push(bytes(0x3b, 8, 0x00, 0x03, ...text("a/b"), 0x00, 0x07, ...text("x")));
    expect(p).toMatchObject({
      type: "publish",
      topic: "a/b",
      qos: 1,
      packetId: 7,
      retain: true,
      dup: true,
    });
    expect(p?.type === "publish" && new TextDecoder().decode(p.payload)).toBe("x");
  });

  it("reassembles packets split across chunks", () => {
    const r = new PacketReader(1024);
    expect(r.push(publishQos1.subarray(0, 1))).toEqual([]);
    expect(r.push(publishQos1.subarray(1, 6))).toEqual([]);
    expect(r.push(publishQos1.subarray(6))).toHaveLength(1);
  });

  it("splits several packets in one chunk", () => {
    const r = new PacketReader(1024);
    const chunk = new Uint8Array([...publishQos1, 0xd0, 0x00, ...publishQos1]);
    expect(r.push(chunk).map((p) => p.type)).toEqual(["publish", "pingresp", "publish"]);
  });

  it("rejects packets above the size limit before buffering them", () => {
    const r = new PacketReader(100);
    expect(() => r.push(bytes(0x30, 0x80, 0x01))).toThrow(/exceeds/);
  });

  it("rejects QoS 2 and unexpected packet types", () => {
    expect(() => new PacketReader(1024).push(bytes(0x34, 0x05, 0, 1, 0x61, 0, 1))).toThrow(/QoS 2/);
    expect(() => new PacketReader(1024).push(bytes(0x10, 0x00))).toThrow(/unexpected packet type/);
  });

  it("rejects a malformed remaining length", () => {
    expect(() => new PacketReader(1 << 30).push(bytes(0x30, 0xff, 0xff, 0xff, 0xff, 0x01))).toThrow(
      /malformed/,
    );
  });
});
