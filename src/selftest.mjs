// selftest.mjs — one command that proves the editorial pipeline works offline,
// with no network and no credentials. Runs processManifest over a committed
// golden manifest into a temp dir and diffs the output against committed golden
// files. Regenerate the golden with SCOUT_SELFTEST_UPDATE=1 after intended changes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./config.mjs";
import { processManifest } from "./process.mjs";

const GOLDEN_DIR = path.join(repoRoot, "test/fixtures/golden");

// The one path-dependent line in the rendered output — normalize before diffing.
function normalize(text) {
  return text.replace(/- \*\*Manifest:\*\* `[^`]*`/g, "- **Manifest:** `<MANIFEST>`");
}

export function runSelftest(config, { update = process.env.SCOUT_SELFTEST_UPDATE === "1" } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, "manifest.json"), "utf8"));
  const date = manifest.date_utc;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scout-selftest-"));
  const signalsDir = path.join(tmp, "Signals");
  fs.mkdirSync(signalsDir, { recursive: true });
  manifest.signals_dir = signalsDir;
  const manifestPath = path.join(tmp, `manifest-${date}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const derived = { ...config, signalsDir, manifestDir: tmp, stateDir: path.join(tmp, "state") };
  processManifest(derived, manifestPath);

  const mismatches = [];
  for (const name of [`${date}.md`, `${date}_filtered.md`]) {
    const produced = normalize(fs.readFileSync(path.join(signalsDir, name), "utf8"));
    const goldenFile = path.join(GOLDEN_DIR, name);
    if (update) {
      fs.writeFileSync(goldenFile, produced);
      continue;
    }
    const golden = fs.existsSync(goldenFile) ? fs.readFileSync(goldenFile, "utf8") : null;
    if (golden !== produced) mismatches.push(name);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return { command: "selftest", ok: mismatches.length === 0, updated: update, mismatches };
}
