import { env } from "cloudflare:test";
import { FIRMWARE_MAX_BYTES } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import {
  collarFromCert,
  collarFromKey,
  commonName,
  type ClientCertInfo,
} from "../src/firmware/clientCert.js";
import {
  completionStream,
  contentRangeStart,
  parseUpload,
  safeFileName,
  sha256Hex,
} from "../src/firmware/releases.js";

const cert = (over: Partial<ClientCertInfo> = {}): ClientCertInfo => ({
  certPresented: "1",
  certVerified: "SUCCESS",
  certRevoked: "0",
  certSubjectDNRFC2253: "CN=collar-01,O=Udara",
  ...over,
});

describe("collar client certificates", () => {
  it("reads the CN", () => {
    expect(commonName("CN=collar-01,O=Udara")).toBe("collar-01");
    expect(commonName("O=Udara, CN=demo01")).toBe("demo01");
    expect(commonName("O=Udara")).toBeNull();
    expect(commonName("")).toBeNull();
  });

  it("accepts a verified certificate, with or without a matching device_id", () => {
    expect(collarFromCert(cert())).toEqual({ ok: true, deviceId: "collar-01" });
    expect(collarFromCert(cert(), "collar-01")).toEqual({ ok: true, deviceId: "collar-01" });
    expect(collarFromCert(cert({ certSubjectDNRFC2253: "CN=Collar-01" }))).toEqual({
      ok: true,
      deviceId: "collar-01",
    });
  });

  it.each<[string, ClientCertInfo | undefined, string | undefined, string]>([
    ["no certificate", undefined, undefined, "client_certificate_required"],
    [
      "placeholder",
      cert({ certPresented: "0", certVerified: "NONE" }),
      undefined,
      "client_certificate_required",
    ],
    [
      "failed verification",
      cert({ certVerified: "FAILED:certificate has expired" }),
      undefined,
      "client_certificate_invalid",
    ],
    ["revoked", cert({ certRevoked: "1" }), undefined, "client_certificate_invalid"],
    ["no CN", cert({ certSubjectDNRFC2253: "O=Udara" }), undefined, "client_certificate_no_device"],
    [
      "CN not a device id",
      cert({ certSubjectDNRFC2253: "CN=my collar" }),
      undefined,
      "client_certificate_no_device",
    ],
    ["another device's id", cert(), "collar-02", "device_mismatch"],
  ])("refuses %s", (_name, c, claimed, reason) => {
    expect(collarFromCert(c, claimed)).toEqual({ ok: false, reason });
  });
});

describe("collar key", () => {
  const key = "s".repeat(32);
  it("identifies the collar by device_id when the key matches", () => {
    expect(collarFromKey(key, key, "collar-01")).toEqual({ ok: true, deviceId: "collar-01" });
  });
  it("falls back to the certificate check without a key", () => {
    expect(collarFromKey(undefined, key, "collar-01")).toBeNull();
    expect(collarFromKey("", key, "collar-01")).toBeNull();
  });
  it.each<[string, string, string | undefined, string | undefined, string]>([
    ["a wrong key", "x", key, "collar-01", "invalid_collar_key"],
    ["a longer key", key + "x", key, "collar-01", "invalid_collar_key"],
    ["no key configured", key, undefined, "collar-01", "invalid_collar_key"],
    ["no device_id", key, key, undefined, "device_id_required"],
    ["an invalid device_id", key, key, "Collar 1", "device_id_required"],
  ])("refuses %s", (_name, sent, expected, claimed, reason) => {
    expect(collarFromKey(sent, expected, claimed)).toEqual({ ok: false, reason });
  });
});

describe("firmware upload form", () => {
  const form = (fields: Record<string, string | File>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const bin = (size: number, name = "fw.bin") => new File([new Uint8Array(size)], name);

  it("accepts version + file, optional notes and activate", () => {
    const up = parseUpload(
      form({ version: " 1.2.0 ", file: bin(10, "my fw v1.bin"), notes: "fix", activate: "true" }),
    );
    expect(up).toMatchObject({
      version: "1.2.0",
      notes: "fix",
      activate: true,
      fileName: "my_fw_v1.bin",
    });
    expect(parseUpload(form({ version: "1.2.0-rc.1", file: bin(1) }))).toMatchObject({
      notes: null,
      activate: false,
    });
  });

  it.each<[string, Record<string, string | File>]>([
    ["missing version", { file: bin(1) }],
    ["non-SemVer version", { version: "v1.2", file: bin(1) }],
    ["missing file", { version: "1.2.0" }],
    ["file as text", { version: "1.2.0", file: "abc" }],
    ["not a .bin file", { version: "1.2.0", file: bin(1, "fw.hex") }],
    ["only an extension", { version: "1.2.0", file: bin(1, ".bin") }],
    ["empty file", { version: "1.2.0", file: bin(0) }],
    ["file too large", { version: "1.2.0", file: bin(FIRMWARE_MAX_BYTES + 1) }],
    ["notes too long", { version: "1.2.0", file: bin(1), notes: "x".repeat(2001) }],
  ])("rejects %s", (_name, fields) => {
    expect(typeof parseUpload(form(fields))).toBe("string");
  });

  it("keeps file names safe as storage paths", () => {
    expect(safeFileName("C:\\builds\\collar fw.bin")).toBe("collar_fw.bin");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..")).toBe("firmware.bin");
    expect(safeFileName("")).toBe("firmware.bin");
  });

  it("hashes with SHA-256 (lowercase hex)", async () => {
    const abc = new TextEncoder().encode("abc").buffer as ArrayBuffer;
    expect(await sha256Hex(abc)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("firmware download state", () => {
  it("reads where a resumed download starts", () => {
    expect(contentRangeStart(null)).toBe(0);
    expect(contentRangeStart("bytes 100-199/200")).toBe(100);
    expect(contentRangeStart("bytes 0-99/*")).toBe(0);
    expect(contentRangeStart("garbage")).toBe(0);
  });

  const stream = async (offset: number, size: number, chunks: number[], abort = false) => {
    let completed = false;
    const t = completionStream(offset, size, () => (completed = true));
    const writer = t.writable.getWriter();
    const reading = new Response(t.readable).arrayBuffer().catch(() => null);
    for (const n of chunks) await writer.write(new Uint8Array(n));
    if (abort) await writer.abort("collar went away");
    else await writer.close();
    await reading;
    return completed;
  };

  it("completes only after the file's last byte", async () => {
    expect(await stream(0, 10, [4, 6])).toBe(true);
    expect(await stream(0, 10, [4])).toBe(false);
    // Resumed with Range: bytes 6-9.
    expect(await stream(6, 10, [4])).toBe(true);
    expect(await stream(0, 10, [4, 6], true)).toBe(false);
  });
});

describe("firmware api", () => {
  const remote = "https://dogtracker.example.com";

  it("release management needs a signed-in user", async () => {
    const { app } = await import("../src/index.js");
    for (const [method, path] of [
      ["GET", "/api/firmware/releases"],
      ["POST", "/api/firmware/releases"],
      ["DELETE", "/api/firmware/releases/00000000-0000-0000-0000-000000000000"],
      ["PUT", "/api/firmware/active"],
    ] as const) {
      const res = await app.request(`${remote}${path}`, { method }, env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  const collarPaths = [
    "/api/firmware/check?device_id=collar-01&version=1.0.0",
    "/api/firmware/download/1.0.0?device_id=collar-01",
  ];

  it("collar endpoints need a client certificate or the collar key on a deployed hostname", async () => {
    const { app } = await import("../src/index.js");
    for (const path of collarPaths) {
      const res = await app.request(`${remote}${path}`, {}, env);
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: "client_certificate_required" });
    }
  });

  it("accepts the collar key instead of a certificate", async () => {
    const { app } = await import("../src/index.js");
    const keyed = { ...env, COLLAR_API_KEY: "k".repeat(32) };
    const get = (path: string, key: string) =>
      app.request(`${remote}${path}`, { headers: { "X-Collar-Key": key } }, keyed);
    for (const path of collarPaths) {
      const wrong = await get(path, "nope");
      expect(wrong.status, path).toBe(401);
      expect(await wrong.json()).toEqual({ error: "invalid_collar_key" });
      // Accepted; storage is off in tests.
      expect((await get(path, "k".repeat(32))).status, path).toBe(503);
    }
    const noDevice = await get("/api/firmware/download/1.0.0", "k".repeat(32));
    expect(await noDevice.json()).toEqual({ error: "device_id_required" });
  });

  it("the latest version is public", async () => {
    const { app } = await import("../src/index.js");
    // No credentials: reaches storage (off in tests).
    expect((await app.request(`${remote}/api/firmware/latest`, {}, env)).status).toBe(503);
  });

  it("local development identifies the collar by device_id", async () => {
    const { app } = await import("../src/index.js");
    const dev = { ...env, LIVE_VIEW_UNAUTHENTICATED: "true" };
    const check = (q: string) => app.request(`http://localhost/api/firmware/check${q}`, {}, dev);
    expect((await check("?version=1.0.0")).status).toBe(401);
    expect((await check("?device_id=Not%20Valid&version=1.0.0")).status).toBe(401);
    // Identified, but storage is off in tests.
    expect((await check("?device_id=collar-01&version=1.0.0")).status).toBe(503);
    const latest = (q: string) => app.request(`http://localhost/api/firmware/latest${q}`, {}, dev);
    // Public: device_id is optional, and an invalid one is just left out of download_url.
    expect((await latest("")).status).toBe(503);
    expect((await latest("?device_id=Not%20Valid")).status).toBe(503);
    expect((await latest("?device_id=collar-01")).status).toBe(503);
  });
});
