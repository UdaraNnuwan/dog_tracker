import {
  FIRMWARE_FILE_EXTENSION,
  FIRMWARE_MAX_BYTES,
  firmwareVersion,
  isFirmwareFileName,
} from "@udara/contracts";
import type { Tables } from "@udara/db-types";
import type { Db } from "../storage/supabase.js";

/** Firmware releases: the private `firmware` bucket + `firmware_releases` (ADR 0012). */
export const FIRMWARE_BUCKET = "firmware";

export type FirmwareRelease = Tables<"firmware_releases">;

/** The firmware migration hasn't been applied to this Supabase project yet. */
export class FirmwareNotSetUp extends Error {
  constructor() {
    super("firmware storage is not set up: apply migration 20261102100000_firmware_releases.sql");
  }
}

// PostgREST: table / function not in the schema cache; Postgres: undefined table.
const MISSING_CODES = new Set(["PGRST205", "PGRST202", "42P01", "42883"]);

const dbError = (error: { code?: string; message: string }) =>
  error.code && MISSING_CODES.has(error.code) ? new FirmwareNotSetUp() : new Error(error.message);

export interface FirmwareUpload {
  version: string;
  notes: string | null;
  activate: boolean;
  file: File;
  fileName: string;
}

const MAX_NOTES = 2_000;

/** Keeps a file name safe as a Storage path segment: `fw v1.bin` → `fw_v1.bin`. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 100);
  return clean || "firmware.bin";
}

/**
 * Validates the dashboard's multipart form (`version`, `file`, optional `notes` and
 * `activate`); returns an error message for a 400 instead of throwing.
 */
export function parseUpload(form: FormData): FirmwareUpload | string {
  const rawVersion = form.get("version");
  const version = typeof rawVersion === "string" ? rawVersion.trim() : "";
  if (!firmwareVersion.safeParse(version).success) {
    return "version must be SemVer, e.g. 1.2.0";
  }
  const file = form.get("file");
  if (!(file instanceof File)) return "file is required";
  if (!isFirmwareFileName(file.name)) return `file must be a ${FIRMWARE_FILE_EXTENSION} file`;
  if (file.size === 0) return "file is empty";
  if (file.size > FIRMWARE_MAX_BYTES) {
    return `file is larger than ${FIRMWARE_MAX_BYTES / 1024 / 1024} MiB`;
  }
  const rawNotes = form.get("notes");
  const notes = typeof rawNotes === "string" ? rawNotes.trim() : "";
  if (notes.length > MAX_NOTES) return `notes are longer than ${MAX_NOTES} characters`;
  return {
    version,
    notes: notes || null,
    activate: form.get("activate") === "true",
    file,
    fileName: safeFileName(file.name),
  };
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listReleases(db: Db): Promise<FirmwareRelease[]> {
  const { data, error } = await db
    .from("firmware_releases")
    .select("*")
    .order("uploaded_at", { ascending: false });
  if (error) throw dbError(error);
  return data;
}

export async function activeRelease(db: Db): Promise<FirmwareRelease | null> {
  const { data, error } = await db
    .from("firmware_releases")
    .select("*")
    .eq("active", true)
    .maybeSingle();
  if (error) throw dbError(error);
  return data;
}

export async function releaseByVersion(db: Db, version: string): Promise<FirmwareRelease | null> {
  const { data, error } = await db
    .from("firmware_releases")
    .select("*")
    .eq("version", version)
    .maybeSingle();
  if (error) throw dbError(error);
  return data;
}

/** Stores the file, then the row; returns null when the version already exists. */
export async function createRelease(
  db: Db,
  upload: FirmwareUpload,
  uploadedBy: string,
): Promise<FirmwareRelease | null> {
  if (await releaseByVersion(db, upload.version)) return null;

  const bytes = await upload.file.arrayBuffer();
  const storagePath = `${upload.version}/${upload.fileName}`;
  const bucket = db.storage.from(FIRMWARE_BUCKET);
  const stored = await bucket.upload(storagePath, bytes, {
    contentType: "application/octet-stream",
    upsert: false,
  });
  if (stored.error) {
    if (/bucket not found/i.test(stored.error.message)) throw new FirmwareNotSetUp();
    throw new Error(`firmware upload failed: ${stored.error.message}`);
  }

  const { data, error } = await db
    .from("firmware_releases")
    .insert({
      version: upload.version,
      file_name: upload.fileName,
      storage_path: storagePath,
      size_bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      notes: upload.notes,
      uploaded_by: uploadedBy,
    })
    .select("*")
    .single();
  if (error) {
    // Don't leave an orphaned file behind (e.g. a concurrent upload of the same version).
    await bucket.remove([storagePath]);
    if (error.code === "23505") return null;
    throw dbError(error);
  }
  if (!upload.activate) return data;
  await activateRelease(db, data.id);
  return { ...data, active: true };
}

/** Makes one release active, or none with null; false when there is no such release. */
export async function activateRelease(db: Db, id: string | null): Promise<boolean> {
  const { error } = await db.rpc("activate_firmware", id === null ? {} : { p_id: id });
  if (error?.code === "P0002") return false;
  if (error) throw dbError(error);
  return true;
}

/** Deletes the row and its file; false when there is no such release. */
export async function deleteRelease(db: Db, id: string): Promise<boolean> {
  const { data, error } = await db
    .from("firmware_releases")
    .delete()
    .eq("id", id)
    .select("storage_path")
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) return false;
  const removed = await db.storage.from(FIRMWARE_BUCKET).remove([data.storage_path]);
  if (removed.error) throw new Error(`firmware file not removed: ${removed.error.message}`);
  return true;
}

/** Short-lived URL the Worker fetches to stream a download to the collar. */
export async function signedFileUrl(db: Db, release: FirmwareRelease): Promise<string> {
  const { data, error } = await db.storage
    .from(FIRMWARE_BUCKET)
    .createSignedUrl(release.storage_path, 60);
  if (error) throw dbError(error);
  return data.signedUrl;
}
