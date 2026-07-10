// Bumps the patch version in extension/manifest.json. Runs via the npm
// `version` lifecycle hook, so the extension version advances in lockstep
// with every `npm version patch` (it keeps its own 1.x line, independent of
// the package version).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../extension/manifest.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const parts = manifest.version.split(".").map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
  throw new Error(`Unexpected extension version: ${manifest.version}`);
}
parts[2] += 1;
manifest.version = parts.join(".");

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`extension/manifest.json → ${manifest.version}`);
