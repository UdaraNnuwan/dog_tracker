import { describe, expect, it } from "vitest";
import { MAX_BACKOFF_ATTEMPT, reconnectDelayMs } from "../src/bridge/backoff.js";

describe("reconnectDelayMs", () => {
  it("grows and caps at 60 s", () => {
    const mid = () => 0.5; // no jitter
    expect(reconnectDelayMs(0, mid)).toBe(1_000);
    expect(reconnectDelayMs(3, mid)).toBe(10_000);
    expect(reconnectDelayMs(MAX_BACKOFF_ATTEMPT, mid)).toBe(60_000);
    expect(reconnectDelayMs(99, mid)).toBe(60_000);
  });

  it("applies ±20 % jitter", () => {
    expect(reconnectDelayMs(5, () => 0)).toBe(48_000);
    expect(reconnectDelayMs(5, () => 1)).toBe(72_000);
  });
});
