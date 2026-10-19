/**
 * Regenerates `packages/contracts/json-schema/` from the Zod schemas.
 * Run with `pnpm --filter @udara/contracts gen:schema` after changing any schema.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJsonSchemas, serialiseSchema } from "../src/jsonSchema.js";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "json-schema");

await rm(outDir, { recursive: true, force: true });
const docs = buildJsonSchemas();
for (const [rel, doc] of docs) {
  const file = join(outDir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serialiseSchema(doc));
}
console.log(`wrote ${docs.size} schemas to ${outDir}`);
