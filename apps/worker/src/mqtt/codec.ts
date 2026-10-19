/**
 * Minimal MQTT 3.1.1 packet codec (OASIS mqtt-v3.1.1, §2–§3).
 *
 * Covers only what the bridge needs: CONNECT/CONNACK, PUBLISH (QoS 0/1), PUBACK,
 * SUBSCRIBE/SUBACK, PINGREQ/PINGRESP, DISCONNECT. QoS 2 is not used (spec §10) and is
 * rejected as a protocol error. Pure functions only; see ADR 0001 for why this is not mqtt.js.
 */

export const PacketType = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
} as const;

/** Largest remaining length representable in 4 varint bytes. */
const MAX_REMAINING_LENGTH = 268_435_455;

export class MqttProtocolError extends Error {
  override name = "MqttProtocolError";
}

export type QoS = 0 | 1;

export interface ConnectOptions {
  clientId: string;
  keepAliveSeconds: number;
  cleanSession: boolean;
  username?: string;
  password?: string;
}

export type InboundPacket =
  | { type: "connack"; sessionPresent: boolean; returnCode: number }
  | {
      type: "publish";
      topic: string;
      payload: Uint8Array;
      qos: QoS;
      retain: boolean;
      dup: boolean;
      packetId?: number;
    }
  | { type: "puback"; packetId: number }
  | { type: "suback"; packetId: number; returnCodes: number[] }
  | { type: "pingresp" };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// ---------------------------------------------------------------- encoding

export function encodeRemainingLength(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > MAX_REMAINING_LENGTH) {
    throw new MqttProtocolError(`remaining length out of range: ${length}`);
  }
  const out: number[] = [];
  let x = length;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    out.push(byte);
  } while (x > 0);
  return Uint8Array.from(out);
}

function utf8String(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  if (bytes.length > 0xffff) throw new MqttProtocolError("string longer than 65535 bytes");
  return concat([u16(bytes.length), bytes]);
}

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function packet(firstByte: number, body: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(firstByte), encodeRemainingLength(body.length), body]);
}

function assertPacketId(packetId: number): void {
  if (!Number.isInteger(packetId) || packetId < 1 || packetId > 0xffff) {
    throw new MqttProtocolError(`invalid packet id: ${packetId}`);
  }
}

export function encodeConnect(opts: ConnectOptions): Uint8Array {
  if (opts.password !== undefined && opts.username === undefined) {
    // MQTT 3.1.1 §3.1.2.9: password flag requires username flag.
    throw new MqttProtocolError("password requires username");
  }
  let flags = 0;
  if (opts.cleanSession) flags |= 0x02;
  if (opts.password !== undefined) flags |= 0x40;
  if (opts.username !== undefined) flags |= 0x80;

  const parts = [
    utf8String("MQTT"),
    Uint8Array.of(4, flags), // protocol level 4 = 3.1.1
    u16(opts.keepAliveSeconds),
    utf8String(opts.clientId),
  ];
  if (opts.username !== undefined) parts.push(utf8String(opts.username));
  if (opts.password !== undefined) parts.push(utf8String(opts.password));
  return packet(PacketType.CONNECT << 4, concat(parts));
}

export interface PublishPacket {
  topic: string;
  payload: Uint8Array;
  qos: QoS;
  retain: boolean;
  dup?: boolean;
  packetId?: number;
}

export function encodePublish(p: PublishPacket): Uint8Array {
  let first = PacketType.PUBLISH << 4;
  if (p.dup) first |= 0x08;
  first |= p.qos << 1;
  if (p.retain) first |= 0x01;

  const parts = [utf8String(p.topic)];
  if (p.qos > 0) {
    if (p.packetId === undefined) throw new MqttProtocolError("QoS 1 publish needs a packet id");
    assertPacketId(p.packetId);
    parts.push(u16(p.packetId));
  }
  parts.push(p.payload);
  return packet(first, concat(parts));
}

export function encodePuback(packetId: number): Uint8Array {
  assertPacketId(packetId);
  return packet(PacketType.PUBACK << 4, u16(packetId));
}

export function encodeSubscribe(
  packetId: number,
  subscriptions: { filter: string; qos: QoS }[],
): Uint8Array {
  assertPacketId(packetId);
  if (subscriptions.length === 0) throw new MqttProtocolError("SUBSCRIBE needs a filter");
  const parts = [u16(packetId)];
  for (const s of subscriptions) parts.push(utf8String(s.filter), Uint8Array.of(s.qos));
  // Fixed-header flags for SUBSCRIBE are reserved as 0b0010 (§3.8.1).
  return packet((PacketType.SUBSCRIBE << 4) | 0x02, concat(parts));
}

export const PINGREQ = Uint8Array.of(PacketType.PINGREQ << 4, 0);
export const DISCONNECT = Uint8Array.of(PacketType.DISCONNECT << 4, 0);

// ---------------------------------------------------------------- decoding

function readU16(buf: Uint8Array, offset: number): number {
  const hi = buf[offset];
  const lo = buf[offset + 1];
  if (hi === undefined || lo === undefined) throw new MqttProtocolError("truncated packet");
  return (hi << 8) | lo;
}

function decodeBody(first: number, body: Uint8Array): InboundPacket {
  const type = first >> 4;
  const flags = first & 0x0f;

  switch (type) {
    case PacketType.CONNACK: {
      if (body.length !== 2) throw new MqttProtocolError("bad CONNACK length");
      return {
        type: "connack",
        sessionPresent: ((body[0] ?? 0) & 0x01) === 1,
        returnCode: body[1] ?? 0,
      };
    }
    case PacketType.PUBLISH: {
      const qos = (flags >> 1) & 0x03;
      if (qos > 1) throw new MqttProtocolError(`unsupported QoS ${qos}`);
      const topicLen = readU16(body, 0);
      let offset = 2 + topicLen;
      if (offset > body.length) throw new MqttProtocolError("truncated topic");
      let topic: string;
      try {
        topic = decoder.decode(body.subarray(2, offset));
      } catch {
        throw new MqttProtocolError("topic is not valid UTF-8");
      }
      let packetId: number | undefined;
      if (qos === 1) {
        packetId = readU16(body, offset);
        offset += 2;
      }
      return {
        type: "publish",
        topic,
        payload: body.slice(offset),
        qos: qos as QoS,
        retain: (flags & 0x01) === 1,
        dup: (flags & 0x08) !== 0,
        ...(packetId !== undefined ? { packetId } : {}),
      };
    }
    case PacketType.PUBACK:
      if (body.length !== 2) throw new MqttProtocolError("bad PUBACK length");
      return { type: "puback", packetId: readU16(body, 0) };
    case PacketType.SUBACK:
      if (body.length < 3) throw new MqttProtocolError("bad SUBACK length");
      return { type: "suback", packetId: readU16(body, 0), returnCodes: [...body.subarray(2)] };
    case PacketType.PINGRESP:
      return { type: "pingresp" };
    default:
      throw new MqttProtocolError(`unexpected packet type ${type}`);
  }
}

/**
 * Incremental decoder. WebSocket frames may carry a partial packet or several packets,
 * so bytes are buffered until whole packets are available.
 */
export class PacketReader {
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(private readonly maxPacketBytes: number) {}

  /** Feeds bytes and returns every complete packet. Throws MqttProtocolError on bad input. */
  push(chunk: Uint8Array): InboundPacket[] {
    this.buffer = this.buffer.length === 0 ? chunk : concat([this.buffer, chunk]);
    const packets: InboundPacket[] = [];

    for (;;) {
      const header = this.readHeader();
      if (header === null) break;
      const { first, headerLength, remainingLength } = header;
      const total = headerLength + remainingLength;
      if (this.buffer.length < total) break;
      packets.push(decodeBody(first, this.buffer.subarray(headerLength, total)));
      this.buffer = this.buffer.slice(total);
    }
    return packets;
  }

  private readHeader(): { first: number; headerLength: number; remainingLength: number } | null {
    const first = this.buffer[0];
    if (first === undefined) return null;

    let multiplier = 1;
    let remainingLength = 0;
    for (let i = 1; i <= 4; i++) {
      const byte = this.buffer[i];
      if (byte === undefined) return null; // need more bytes
      remainingLength += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        if (i + 1 + remainingLength > this.maxPacketBytes) {
          throw new MqttProtocolError(`packet exceeds ${this.maxPacketBytes} bytes`);
        }
        return { first, headerLength: i + 1, remainingLength };
      }
      multiplier *= 128;
    }
    throw new MqttProtocolError("malformed remaining length");
  }
}
