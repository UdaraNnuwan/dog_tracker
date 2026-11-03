import { z } from "zod";
import { semver } from "./schemas/common.js";
import { isValidDeviceId } from "./topics.js";

/**
 * Over-the-air firmware updates over HTTPS (ADR 0012). Not an MQTT topic: the collar asks
 * `GET /api/firmware/check?device_id=…&version=…` with its client certificate and, when the
 * answer has `update: true`, downloads `download_url` and verifies it against `sha256`.
 */

/** Largest firmware file the dashboard accepts (the Storage bucket has the same limit). */
export const FIRMWARE_MAX_BYTES = 32 * 1024 * 1024;

/** Collar images are raw `.bin` files. */
export const FIRMWARE_FILE_EXTENSION = ".bin";

export const isFirmwareFileName = (name: string): boolean =>
  name.toLowerCase().endsWith(FIRMWARE_FILE_EXTENSION) &&
  name.length > FIRMWARE_FILE_EXTENSION.length;

export const firmwareVersion = semver;

export const firmwareCheckQuery = z.object({
  device_id: z.string().refine(isValidDeviceId, "invalid device id"),
  /** The version the collar runs now (`status/system.firmware_version`). */
  version: firmwareVersion,
});
export type FirmwareCheckQuery = z.infer<typeof firmwareCheckQuery>;

export const firmwareCheckResponse = z.discriminatedUnion("update", [
  z.object({
    update: z.literal(false),
    /** The active release, or null when none is active. */
    version: firmwareVersion.nullable(),
  }),
  z.object({
    update: z.literal(true),
    version: firmwareVersion,
    size_bytes: z.number().int().positive(),
    /** Lowercase hex SHA-256 of the file. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Absolute HTTPS URL; needs the same client certificate as the check. */
    download_url: z.string().url(),
  }),
]);
export type FirmwareCheckResponse = z.infer<typeof firmwareCheckResponse>;

/**
 * `GET /api/firmware/latest?device_id=…`: the release offered to collars (the active one),
 * without comparing versions. `{version: null}` when none is active.
 */
export const firmwareLatestResponse = z.union([
  z.object({
    version: firmwareVersion,
    size_bytes: z.number().int().positive(),
    /** Lowercase hex SHA-256 of the file. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** ISO 8601 upload time. */
    uploaded_at: z.string().datetime({ offset: true }),
    /** Absolute HTTPS URL; needs the same client certificate as this request. */
    download_url: z.string().url(),
  }),
  z.object({ version: z.null() }),
]);
export type FirmwareLatestResponse = z.infer<typeof firmwareLatestResponse>;

/** Update rule: any difference from the active release, so a rollback is an update too. */
export const needsUpdate = (current: string, active: string | null): boolean =>
  active !== null && current.trim() !== active;
