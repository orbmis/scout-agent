#!/usr/bin/env node
// live-e2e.mjs — full live end-to-end smoke test (`npm run live`).
//
// Runs the REAL pipeline (collect → process) against live sources in an isolated
// sandbox, asserts the run report, prints a verdict, and cleans up. Side-effects
// never touch the real vault or the rolling dedup state.
//
//   npm run live            # run and tear down the sandbox
//   npm run live -- --keep  # keep the sandbox for inspection

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canaryVerdict } from "../src/report.mjs";

// Pure verdict logic — unit-testable without network. Decides pass/fail from the
// preflight, the run report, and what credentials were available.
export function evaluateLiveRun({ diagnostics, report, dailyPath, filteredPath, hasXToken }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add(
    "preflight",
    diagnostics.summary?.ready_to_collect === true,
    `ready_to_collect=${diagnostics.summary?.ready_to_collect}`
  );

  const verdict = canaryVerdict(report);
  add(
    "public_sources",
    verdict.pass,
    verdict.pass ? "rss/github/arxiv reachable with items" : verdict.failures.join("; ")
  );

  if (hasXToken) {
    const x = report.collectors?.x_seed;
    add("x_collector", x?.status === "ok", `status=${x?.status}`);
  } else {
    add("x_collector", true, "skipped (no X_BEARER_TOKEN)");
  }

  const errors = (report.warnings || []).filter((w) => w.severity === "error");
  add(
    "no_errors",
    errors.length === 0 && report.ok === true,
    errors.length ? errors.map((e) => e.code).join(",") : "ok"
  );

  add("outputs", fs.existsSync(dailyPath) && fs.existsSync(filteredPath), `${path.basename(dailyPath)} + filtered`);

  return { pass: checks.every((c) => c.ok), checks };
}

async function main() {
  const keep = process.argv.includes("--keep");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "scout-live-"));

  // Isolate ALL writes so the real Obsidian vault and the 14-day dedup state are untouched.
  process.env.SCOUT_SIGNALS_DIR = path.join(sandbox, "Signals");
  process.env.SCOUT_MANIFEST_DIR = path.join(sandbox, "manifest");
  process.env.SCOUT_STATE_DIR = path.join(sandbox, "state");
  // Widen windows so a quiet hour still yields material (caller overrides win).
  for (const [k, v] of Object.entries({
    RSS_HOURS: "168",
    GITHUB_HOURS: "168",
    ARXIV_HOURS: "168",
    SEED_HOURS: "48",
  })) {
    if (!process.env[k]) process.env[k] = v;
  }

  const { loadConfig } = await import("../src/config.mjs");
  const { collect } = await import("../src/collect.mjs");
  const { processManifest } = await import("../src/process.mjs");
  const { runDiagnostics } = await import("../src/diagnose.mjs");

  const config = loadConfig();
  const hasXToken = Boolean(config.secrets.X_BEARER_TOKEN);

  console.error(`[live] sandbox: ${sandbox}`);
  console.error("[live] preflight (diagnose)…");
  const diagnostics = await runDiagnostics(config);
  console.error("[live] collecting from live sources…");
  const { manifestFile, report } = await collect(config, {});
  console.error("[live] processing…");
  const result = processManifest(config, manifestFile);

  const verdict = evaluateLiveRun({
    diagnostics,
    report,
    dailyPath: result.dailyPath,
    filteredPath: result.filteredPath,
    hasXToken,
  });

  console.log(
    JSON.stringify(
      {
        sandbox,
        collectors: report.collectors,
        warnings: report.warnings,
        editorial: { kept: result.keptCount, filtered: result.filteredCount },
        checks: verdict.checks,
        pass: verdict.pass,
      },
      null,
      2
    )
  );

  if (keep) console.error(`[live] sandbox kept at ${sandbox}`);
  else fs.rmSync(sandbox, { recursive: true, force: true });

  process.exitCode = verdict.pass ? 0 : 1;
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(String(err?.stack || err));
    process.exit(1);
  });
}
