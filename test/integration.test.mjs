// Orchestrator + golden integration, fully offline (HTTP replay with no fixtures
// makes every collector return empty) and on a pinned clock.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("collect orchestrates offline, writes a valid manifest, sets the weekly flag", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scout-collect-"));
  process.env.SCOUT_HTTP_MODE = "replay";
  process.env.SCOUT_HTTP_FIXTURES = path.join(tmp, "http"); // empty → all misses
  process.env.SCOUT_SIGNALS_DIR = path.join(tmp, "Signals");
  process.env.SCOUT_MANIFEST_DIR = path.join(tmp, "manifest");
  process.env.SCOUT_STATE_DIR = path.join(tmp, "state");
  process.env.SCOUT_NOW = "2026-06-28T12:00:00Z"; // a Sunday

  const { loadConfig } = await import("../src/config.mjs");
  const { collect } = await import("../src/collect.mjs");
  const { validateManifest } = await import("../src/lib/manifest-schema.mjs");

  const config = loadConfig();
  const { manifest, report } = await collect(config, { nowMs: config.nowMs });

  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.date_utc, "2026-06-28");
  assert.equal(manifest.weekly_report_due, true);
  assert.equal(report.ok, true); // no collector hard-errored
  assert.equal(report.dedup.total_before, 0);
  assert.ok(report.warnings.some((w) => w.code === "zero_items_all_sources"));

  for (const k of ["SCOUT_HTTP_MODE", "SCOUT_HTTP_FIXTURES", "SCOUT_SIGNALS_DIR", "SCOUT_MANIFEST_DIR", "SCOUT_STATE_DIR", "SCOUT_NOW"]) delete process.env[k];
});

test("selftest reproduces the committed golden editorial output", async () => {
  const { loadConfig } = await import("../src/config.mjs");
  const { runSelftest } = await import("../src/selftest.mjs");
  const result = runSelftest(loadConfig());
  assert.equal(result.ok, true, `selftest mismatches: ${result.mismatches.join(", ")}`);
});

test("diagnose and doctor return structured, deterministic results offline", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scout-diag-"));
  process.env.SCOUT_HTTP_MODE = "replay";
  process.env.SCOUT_HTTP_FIXTURES = path.join(tmp, "http"); // empty → connectivity checks fail fast
  process.env.SCOUT_STATE_DIR = path.join(tmp, "state");
  process.env.SCOUT_MANIFEST_DIR = path.join(tmp, "manifest");

  const { loadConfig } = await import("../src/config.mjs");
  const { runDiagnostics } = await import("../src/diagnose.mjs");
  const { runDoctor } = await import("../src/doctor.mjs");
  const config = loadConfig();

  const diag = await runDiagnostics(config);
  assert.equal(typeof diag.summary.ready_to_collect, "boolean");
  assert.equal(diag.config.seed_authors, 111);

  const doc = await runDoctor(config);
  assert.ok(Array.isArray(doc.checks));
  assert.ok(doc.checks.find((c) => c.name === "config"));

  for (const k of ["SCOUT_HTTP_MODE", "SCOUT_HTTP_FIXTURES", "SCOUT_STATE_DIR", "SCOUT_MANIFEST_DIR"]) delete process.env[k];
});
