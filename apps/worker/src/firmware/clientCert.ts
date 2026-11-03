import { isValidDeviceId } from "@udara/contracts";

/**
 * Collar identity for the firmware API (ADR 0012): a client certificate issued by our CA,
 * checked by Cloudflare mTLS on the custom hostname. Cloudflare passes the result in
 * `request.cf.tlsClientAuth`; the certificate's subject CN is the device_id.
 */
export type CollarAuth = { ok: true; deviceId: string } | { ok: false; reason: CollarAuthError };

export type CollarAuthError =
  | "invalid_collar_key"
  | "device_id_required"
  | "client_certificate_required"
  | "client_certificate_invalid"
  | "client_certificate_no_device"
  | "device_mismatch";

/** The fields of `cf.tlsClientAuth` this check reads. */
export interface ClientCertInfo {
  certPresented: string;
  certVerified: string;
  certRevoked: string;
  certSubjectDNRFC2253?: string;
}

/** `CN=collar-01,O=Udara` → `collar-01`. RFC 2253 escapes (`\,`) never occur in a device id. */
export function commonName(subjectDn: string): string | null {
  for (const part of subjectDn.split(",")) {
    const [key, ...rest] = part.split("=");
    if (key?.trim().toUpperCase() === "CN") return rest.join("=").trim() || null;
  }
  return null;
}

/**
 * The device a verified, unrevoked client certificate belongs to. `claimed` is the
 * `device_id` the request names, if any: it must be the certificate's own.
 */
export function collarFromCert(cert: ClientCertInfo | undefined, claimed?: string): CollarAuth {
  if (!cert || cert.certPresented !== "1") {
    return { ok: false, reason: "client_certificate_required" };
  }
  if (cert.certVerified !== "SUCCESS" || cert.certRevoked !== "0") {
    return { ok: false, reason: "client_certificate_invalid" };
  }
  const deviceId = commonName(cert.certSubjectDNRFC2253 ?? "")?.toLowerCase();
  if (!deviceId || !isValidDeviceId(deviceId)) {
    return { ok: false, reason: "client_certificate_no_device" };
  }
  if (claimed !== undefined && claimed !== "" && claimed !== deviceId) {
    return { ok: false, reason: "device_mismatch" };
  }
  return { ok: true, deviceId };
}

/**
 * The shared collar key (`X-Collar-Key`), for hosts without mTLS such as workers.dev. The
 * device is the one the request names; it can't be proven, unlike a certificate's CN.
 * `null` when the request sends no key, so the certificate check applies instead.
 */
export function collarFromKey(
  sent: string | undefined,
  expected: string | undefined,
  claimed: string | undefined,
): CollarAuth | null {
  if (!sent) return null;
  if (!expected || !timingSafeEqual(sent, expected)) {
    return { ok: false, reason: "invalid_collar_key" };
  }
  if (!claimed || !isValidDeviceId(claimed)) return { ok: false, reason: "device_id_required" };
  return { ok: true, deviceId: claimed };
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** `cf.tlsClientAuth` of an incoming request (absent in tests and on workers.dev). */
export function clientCertOf(req: Request): ClientCertInfo | undefined {
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  return cf?.tlsClientAuth;
}
