import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildJsonSchemas, serialiseSchema } from "../src/jsonSchema.js";

const dir = join(import.meta.dirname, "..", "json-schema");

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name)));
}

describe("committed JSON Schemas", () => {
  const generated = buildJsonSchemas();
  const hint = "run `pnpm --filter @udara/contracts gen:schema` and commit the result";

  it("has exactly one file per generated schema", async () => {
    expect((await listFiles(dir)).sort(), hint).toEqual([...generated.keys()].sort());
  });

  it.each([...generated.keys()])("%s is up to date", async (rel) => {
    const onDisk = await readFile(join(dir, rel), "utf8");
    expect(onDisk, hint).toBe(serialiseSchema(generated.get(rel)!));
  });

  it("does not forbid unknown fields (spec §15)", () => {
    for (const [rel, doc] of generated)
      expect(JSON.stringify(doc), rel).not.toContain('"additionalProperties":false');
  });
});
