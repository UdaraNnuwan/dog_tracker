import { describe, expect, it } from "vitest";
import {
  firmwareCheckQuery,
  firmwareCheckResponse,
  firmwareLatestResponse,
  needsUpdate,
} from "../src/firmware.js";

describe("firmware check (ADR 0012)", () => {
  it("validates the collar's query", () => {
    expect(firmwareCheckQuery.safeParse({ device_id: "collar-01", version: "1.0.0" }).success).toBe(
      true,
    );
    expect(firmwareCheckQuery.safeParse({ device_id: "Collar 1", version: "1.0.0" }).success).toBe(
      false,
    );
    expect(firmwareCheckQuery.safeParse({ device_id: "collar-01", version: "1.0" }).success).toBe(
      false,
    );
  });

  it("offers the active release whenever the version differs, rollbacks included", () => {
    expect(needsUpdate("1.0.0", "1.1.0")).toBe(true);
    expect(needsUpdate("1.2.0", "1.1.0")).toBe(true);
    expect(needsUpdate("1.1.0", "1.1.0")).toBe(false);
    expect(needsUpdate(" 1.1.0 ", "1.1.0")).toBe(false);
    expect(needsUpdate("1.0.0", null)).toBe(false);
  });

  it("describes both answers", () => {
    expect(firmwareCheckResponse.safeParse({ update: false, version: null }).success).toBe(true);
    expect(
      firmwareCheckResponse.safeParse({
        update: true,
        version: "1.1.0",
        size_bytes: 1024,
        sha256: "a".repeat(64),
        download_url: "https://dogtracker.example.com/api/firmware/download/1.1.0",
      }).success,
    ).toBe(true);
    expect(firmwareCheckResponse.safeParse({ update: true, version: "1.1.0" }).success).toBe(false);
  });

  it("describes the latest release", () => {
    expect(firmwareLatestResponse.safeParse({ version: null }).success).toBe(true);
    expect(
      firmwareLatestResponse.safeParse({
        version: "1.1.0",
        size_bytes: 1024,
        sha256: "a".repeat(64),
        uploaded_at: "2026-11-03T06:40:41.315+00:00",
        download_url: "https://dogtracker.example.com/api/firmware/download/1.1.0",
      }).success,
    ).toBe(true);
    expect(firmwareLatestResponse.safeParse({ version: "1.1.0" }).success).toBe(false);
  });
});
