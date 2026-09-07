#!/usr/bin/env node
/**
 * Nitro bundles `@electric-sql/pglite` JS into the Vercel function but not the
 * sibling WASM/data files. Production deploys use Neon (`DATABASE_URL`) and
 * never load PGLite. Sandbox `vite preview` of the built output has no
 * DATABASE_URL, so those files must sit where the bundled module resolves them.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "node_modules/@electric-sql/pglite/dist");
const functionDir = join(root, ".vercel/output/functions/__server.func");
const libsDir = join(functionDir, "_libs");

if (!existsSync(join(libsDir, "electric-sql__pglite.mjs"))) {
  console.log("[pglite-assets] bundled pglite module not found — skipping");
  process.exit(0);
}

const files = ["pglite.data", "pglite.wasm", "initdb.wasm", "btree_gist.tar.gz"];
const dests = [libsDir, functionDir];

for (const dest of dests) {
  mkdirSync(dest, { recursive: true });
  for (const name of files) {
    const from = join(srcDir, name);
    if (!existsSync(from)) {
      console.warn(`[pglite-assets] missing ${name}`);
      continue;
    }
    copyFileSync(from, join(dest, name));
    console.log(`[pglite-assets] copied ${name} -> ${dest}`);
  }
}
