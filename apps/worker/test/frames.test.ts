import { describe, expect, it } from "vitest";
import { describeFrame, frameToBytes } from "../src/mqtt/frames.js";

describe("frameToBytes", () => {
  it("accepts ArrayBuffer and typed-array views", () => {
    expect([...(frameToBytes(Uint8Array.of(1, 2).buffer) ?? [])]).toEqual([1, 2]);
    const view = Uint8Array.of(9, 1, 2, 9).subarray(1, 3);
    expect([...(frameToBytes(view) ?? [])]).toEqual([1, 2]);
  });

  it("rejects text frames and other values", () => {
    expect(frameToBytes("hello")).toBeNull();
    expect(frameToBytes(null)).toBeNull();
    expect(frameToBytes({})).toBeNull();
  });

  it("describes frames without their content", () => {
    expect(describeFrame("secret")).toBe("string");
    expect(describeFrame(new ArrayBuffer(1))).toBe("[object ArrayBuffer]");
  });
});
