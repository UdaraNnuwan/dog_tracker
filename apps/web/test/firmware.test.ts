import { describe, expect, it } from "vitest";
import { collarFirmwareState, formatBytes, versionFromFileName } from "../src/firmware/status.js";

describe("firmware tab", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(32 * 1024 * 1024)).toBe("32.00 MiB");
  });

  it("guesses the version from a dropped file's name", () => {
    expect(versionFromFileName("collar-v1.2.0.bin")).toBe("1.2.0");
    expect(versionFromFileName("fw_1.3.0-rc.1.bin")).toBe("1.3.0-rc.1");
    expect(versionFromFileName("firmware.bin")).toBeNull();
    expect(versionFromFileName("build-12.bin")).toBeNull();
  });

  it("predicts each collar's next check", () => {
    expect(collarFirmwareState("1.0.0", "1.1.0")).toBe("update");
    expect(collarFirmwareState("1.1.0", "1.1.0")).toBe("current");
    expect(collarFirmwareState(null, "1.1.0")).toBe("unknown");
    expect(collarFirmwareState("1.0.0", null)).toBe("none");
  });

  it("follows the collar's download until it reports the new version", () => {
    const dl = (version: string, state: string) => ({ version, state });
    expect(collarFirmwareState("1.0.0", "1.1.0", dl("1.1.0", "downloading"))).toBe("downloading");
    expect(collarFirmwareState("1.0.0", "1.1.0", dl("1.1.0", "downloaded"))).toBe("downloaded");
    expect(collarFirmwareState(null, "1.1.0", dl("1.1.0", "downloaded"))).toBe("downloaded");
    expect(collarFirmwareState("1.1.0", "1.1.0", dl("1.1.0", "downloaded"))).toBe("current");
    // A download of another release doesn't count.
    expect(collarFirmwareState("1.0.0", "1.1.0", dl("1.0.5", "downloaded"))).toBe("update");
  });
});
