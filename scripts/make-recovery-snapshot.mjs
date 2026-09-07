#!/usr/bin/env node
/**
 * Create a complete restorable project snapshot (zip) for Aether Transfer.
 * Excludes node_modules, build output, nested snapshots, and secrets.
 * Never include .env files or credentials.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const checkpoint = process.argv[2] ?? "0";
const phaseSlug = process.argv[3] ?? "foundation";
const testStatus = process.argv[4] ?? "unverified";
const date = new Date().toISOString().slice(0, 10);
const name = `aether-transfer-checkpoint-${checkpoint}-phase-${phaseSlug}-${date}`;

const root = join(import.meta.dirname, "..");
const outDir = join(root, "recovery-snapshots");
const artifactsDir = join(root, "artifacts");
mkdirSync(outDir, { recursive: true });
try {
  mkdirSync(artifactsDir, { recursive: true });
} catch {
  /* artifacts/ may be an external mount */
}

const label = [
  "Aether Transfer",
  `Checkpoint ${checkpoint}`,
  `Phase ${phaseSlug}`,
  `Date ${date}`,
  `Test status: ${testStatus}`,
  "Complete restorable project snapshot. Extract into a new Grok Build workspace and follow docs/RESTORE.md.",
  "Contains no secrets.",
].join("\n");

writeFileSync(join(root, "docs/CHECKPOINT.md"), `${label}\n`);

const zipName = `${name}.zip`;
const zipPath = join(outDir, zipName);

const py = `
import os, zipfile
root = ${JSON.stringify(root)}
zip_path = ${JSON.stringify(zipPath)}
skip_dirs = {
  "node_modules", ".git", "screenshots", "recovery-snapshots", "artifacts",
  ".output", "dist", ".nitro", ".tanstack", ".vite", "coverage", ".vercel",
  "imagine_images", "imagine_videos",
}
skip_files = {".env", ".DS_Store"}
skip_prefixes = (".env.",)
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        parts = [] if rel_dir == "." else rel_dir.split(os.sep)
        if any(p in skip_dirs for p in parts):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for name in filenames:
            if name in skip_files or name.endswith(".log") or name.startswith(skip_prefixes):
                continue
            if rel_dir == ".grok" and name == "og-pending":
                continue
            full = os.path.join(dirpath, name)
            arc = os.path.relpath(full, root)
            z.write(full, arc)
print(zip_path)
`;

const result = spawnSync("python3", ["-c", py], { cwd: root, encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr || "snapshot failed\n");
  process.exit(result.status ?? 1);
}

const artifactPath = join(artifactsDir, zipName);
try {
  copyFileSync(zipPath, artifactPath);
  console.log(`artifact: ${artifactPath}`);
} catch (err) {
  console.log(`artifact copy skipped: ${err instanceof Error ? err.message : err}`);
}

console.log(`snapshot: ${zipPath}`);
console.log(result.stdout);
