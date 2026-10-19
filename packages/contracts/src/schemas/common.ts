import { z } from "zod";

/**
 * Building blocks shared by every payload schema (spec §3).
 *
 * Objects use `z.object`, which strips unknown keys: extra fields from newer firmware are
 * ignored, never rejected (spec §15).
 */

/**
 * Integer epoch seconds, UTC (spec §3, rule 5). The upper bound (year ~5138) is a sanity
 * check that rejects epoch *milliseconds* sent by mistake.
 */
export const epochSeconds = z.number().int().min(0).max(99_999_999_999);

export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);
export const nonNegative = z.number().min(0);
export const nonNegativeInt = z.number().int().min(0);
export const percentage = z.number().int().min(0).max(100);
export const vector3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Correlates a command/setting with its response (spec §7). Backend generates a UUID. */
export const requestId = z.string().min(1).max(64);

/** Response `status` values (spec §3). */
export const responseStatus = z.enum(["success", "failed", "rejected", "unsupported"]);
export type ResponseStatus = z.infer<typeof responseStatus>;

/** Fields every timestamped message may carry (spec §3). */
export const envelope = {
  timestamp: epochSeconds,
  protocol_version: z.string().optional(),
};

/** Fields every command/settings response carries (spec §3, §7.2, §7.3). */
export const responseEnvelope = {
  ...envelope,
  request_id: requestId,
  status: responseStatus,
  // Spec §3 marks error_code "required on error". Not enforced: dropping a failed response
  // would leave the command hanging until timeout, which is worse than a missing code.
  error_code: z.string().optional(),
  message: z.string().optional(),
};

/** Fields every command/settings request carries (spec §7.1). */
export const commandEnvelope = {
  ...envelope,
  request_id: requestId,
};
