/**
 * Converts a WebSocket message payload to bytes. MQTT over WebSocket is binary-only
 * (MQTT 3.1.1 §6), so text frames yield null. Blob frames also yield null: the bridge sets
 * `binaryType = "arraybuffer"`, and a Blob would need an async read that breaks packet order.
 */
export function frameToBytes(data: unknown): Uint8Array | null {
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/** Short description of an unexpected frame for logs (never the content). */
export function describeFrame(data: unknown): string {
  return typeof data === "object" && data !== null
    ? Object.prototype.toString.call(data)
    : typeof data;
}
