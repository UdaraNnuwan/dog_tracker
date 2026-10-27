import { z } from "zod";

/**
 * Building blocks shared by every payload schema (spec V3).
 *
 * Objects use `z.object`, which strips unknown keys: extra fields from newer firmware are
 * ignored, never rejected.
 */

/**
 * Integer epoch seconds, UTC (rule 5). The upper bound (year ~5138) is a sanity check that
 * rejects epoch *milliseconds* sent by mistake.
 */
export const epochSeconds = z.number().int().min(0).max(99_999_999_999);

export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);
export const nonNegative = z.number().min(0);
export const nonNegativeInt = z.number().int().min(0);
export const positiveInt = z.number().int().positive();
export const percentage = z.number().int().min(0).max(100);
export const vector3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Correlates a command with its response. The backend generates a UUID (rule 3). */
export const requestId = z.string().min(1).max(64);

/** Most command responses: `success` or `error` (spec V3 §5). */
export const responseStatus = z.enum(["success", "error"]);
export type ResponseStatus = z.infer<typeof responseStatus>;

export const envelope = { timestamp: epochSeconds };

/** Fields every command carries (spec V3 §4). */
export const commandEnvelope = { ...envelope, request_id: requestId };

/** Fields every command response carries (spec V3 §5); `status` differs per command. */
export const responseEnvelope = { ...envelope, request_id: requestId };

// ------------------------------------------------------------------ settings values

/**
 * The spec's settings examples send numbers and booleans as strings ("60", "true") while its
 * tables say integer / bool. Settings fields accept both and always yield the typed value, so
 * the backend publishes typed JSON and reads either form (ADR 0011).
 */
export const intSetting = <S extends z.ZodType<number, number>>(schema: S) =>
  z.union([
    schema,
    z
      .string()
      .regex(/^-?\d+$/)
      .transform(Number)
      .pipe(schema),
  ]);

export const boolSetting = z.union([
  z.boolean(),
  z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .pipe(z.boolean()),
]);
