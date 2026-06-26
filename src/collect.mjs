// collect.mjs — the collection orchestrator. Runs every collector, merges and
// dedups against rolling state, writes the manifest + marker + run report. This
// is the mechanical half; it makes no editorial judgements.

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildMetadata } from "./lib/metadata.mjs";
import { buildFilters } from "./lib/filters.mjs";
import { buildState } from "./lib/state.mjs";
import { utcDate } from "./lib/text.mjs";
import { validateManifest } from "./lib/manifest-schema.mjs";
import { buildCollectReport } from "./report.mjs";

import { collect as collectX } from "./collectors/x.mjs";
import { collect as collectRss } from "./collectors/rss.mjs";
import { collect as collectGithub } from "./collectors/github.mjs";
import { collect as collectArxiv } from "./collectors/arxiv.mjs";

const SCHEMA_VERSION = "1.1";

async function runSafe(name, fn) {
  const start = performance.now();
  try {
    const { items, diag } = await fn();
    return { name, items: Array.isArray(items) ? items : [], diag: diag || {}, ms: performance.now() - start };
  } catch (err) {
    return { name, items: [], diag: { status: "error", error: String(err) }, ms: performance.now() - start };
  }
}

// previous_signals_files: dated YYYY-MM-DD.md within the last `windowDays` days.
function previousSignalsFiles(signalsDir, windowDays, nowMs) {
  if (!fs.existsSync(signalsDir)) return [];
  const cutoff = nowMs - windowDays * 86400 * 1000;
  return fs
    .readdirSync(signalsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => path.join(signalsDir, f))
    .filter((p) => fs.statSync(p).mtimeMs >= cutoff)
    .sort();
}

export async function collect(config, { date, nowMs = Date.now() } = {}) {
  const { sources, secrets, windows, signalsDir, manifestDir, stateDir, seenWindowDays, editorial } = config;
  date = date || utcDate(new Date(nowMs));
  const totalStart = performance.now();

  const metadata = buildMetadata(editorial.tracked);
  const filters = buildFilters(editorial.negative);
  const state = buildState({ stateDir, seenWindowDays, nowMs });

  const ctx = (windowHours) => ({ windowHours, sources, secrets, filters, metadata, nowMs });

  const collectStart = performance.now();
  const results = await Promise.all([
    runSafe("x_seed", () => collectX(ctx(windows.x_seed))),
    runSafe("rss", () => collectRss(ctx(windows.rss))),
    runSafe("github", () => collectGithub(ctx(windows.github))),
    runSafe("arxiv", () => collectArxiv(ctx(windows.arxiv))),
  ]);
  const collectMs = performance.now() - collectStart;

  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  const merged = results.flatMap((r) => r.items);
  const newItems = state.filterNew(merged);

  const diagnostics = {
    x_seed: { items_kept: byName.x_seed.items.length, status: byName.x_seed.diag.status },
    rss: { items_kept: byName.rss.items.length },
    github: { items_kept: byName.github.items.length },
    arxiv: { items_kept: byName.arxiv.items.length },
    dedup: { total_before: merged.length, total_after: newItems.length },
  };

  const capturedAt = new Date(nowMs).toISOString().replace(/\.\d+Z$/, "Z");
  const isSunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    captured_at: capturedAt,
    date_utc: date,
    window_hours: { x_seed: windows.x_seed, rss: windows.rss, github: windows.github, arxiv: windows.arxiv },
    signals_dir: signalsDir,
    previous_signals_files: previousSignalsFiles(signalsDir, seenWindowDays, nowMs),
    weekly_report_due: isSunday,
    collection_diagnostics: diagnostics,
    items: newItems,
  };

  // Fail loudly rather than writing a malformed manifest downstream consumers trust.
  const invalid = validateManifest(manifest);
  if (invalid.length) throw new Error(`manifest failed validation: ${invalid.join("; ")}`);

  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(signalsDir, { recursive: true });
  const manifestFile = path.join(manifestDir, `manifest-${date}.json`);
  const markerFile = path.join(manifestDir, `ready-${date}.marker`);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(signalsDir, `manifest-${date}.md`),
    `# Manifest - ${date}\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n`
  );

  // Commit dedup state only after the manifest is safely written.
  state.markUrls(newItems);
  fs.writeFileSync(markerFile, "");

  const report = buildCollectReport({
    date,
    capturedAt,
    byName,
    dedup: diagnostics.dedup,
    collectMs,
    totalMs: performance.now() - totalStart,
  });

  return { manifestFile, markerFile, manifest, diagnostics, report };
}
