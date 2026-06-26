// Tests for the new infrastructure: manifest schema, run report, HTTP replay,
// and the clock-driven state window.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateManifest } from "../src/lib/manifest-schema.mjs";
import { buildCollectReport, canaryVerdict } from "../src/report.mjs";
import { buildState } from "../src/lib/state.mjs";

const validManifest = {
  schema_version: "1.1",
  captured_at: "2026-06-25T08:00:00Z",
  date_utc: "2026-06-25",
  window_hours: {},
  signals_dir: "/x",
  previous_signals_files: [],
  weekly_report_due: false,
  collection_diagnostics: {},
  items: [{ source: "rss", url: "https://x", metadata: { eip_numbers: [], has_eip_reference: false } }],
};

test("validateManifest accepts a well-formed manifest", () => {
  assert.deepEqual(validateManifest(validManifest), []);
});

test("validateManifest reports specific problems", () => {
  const bad = { ...validManifest, schema_version: "9", date_utc: "nope", items: [{ source: "bogus" }] };
  const errors = validateManifest(bad);
  assert.ok(errors.some((e) => e.includes("schema_version")));
  assert.ok(errors.some((e) => e.includes("date_utc")));
  assert.ok(errors.some((e) => e.includes("not a known source")));
  assert.ok(errors.some((e) => e.includes("items[0].url")));
});

test("buildCollectReport flags errored collectors and the canary verdict", () => {
  const byName = {
    x_seed: { items: [], diag: { status: "no_token" } },
    rss: { items: [{}, {}], diag: {} },
    github: { items: [{}], diag: {} },
    arxiv: { items: [], diag: { status: "error" } },
  };
  const report = buildCollectReport({
    date: "2026-06-25",
    capturedAt: "t",
    byName,
    dedup: { total_before: 3, total_after: 3 },
    collectMs: 1000,
    totalMs: 1200,
  });
  assert.equal(report.collectors.arxiv.status, "error");
  assert.ok(report.warnings.some((w) => w.code === "collector_error" && w.collector === "arxiv"));
  assert.equal(report.ok, true); // not every collector errored

  const verdict = canaryVerdict(report);
  assert.equal(verdict.pass, false); // arxiv errored
  assert.ok(verdict.failures.some((f) => f.includes("arxiv")));
});

test("HTTP replay serves recorded fixtures and reports misses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-http-"));
  process.env.SCOUT_HTTP_MODE = "replay";
  process.env.SCOUT_HTTP_FIXTURES = dir;
  const { getText } = await import("../src/lib/http.mjs"); // reads env at call time

  // Record a fixture by hand using the same key the module computes.
  const crypto = await import("node:crypto");
  const url = "https://example.com/feed";
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
  fs.writeFileSync(
    path.join(dir, `example.com-${hash}.json`),
    JSON.stringify({ ok: true, status: 200, text: "HELLO" })
  );

  const hit = await getText(url);
  assert.equal(hit.ok, true);
  assert.equal(hit.text, "HELLO");
  const miss = await getText("https://example.com/missing");
  assert.equal(miss.ok, false);
  assert.match(miss.error, /no fixture/);

  delete process.env.SCOUT_HTTP_MODE;
  delete process.env.SCOUT_HTTP_FIXTURES;
});

test("state dedup window honours the injected clock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-state-"));
  const day = 86400 * 1000;
  const t0 = Date.parse("2026-06-01T00:00:00Z");
  const s0 = buildState({ stateDir: dir, seenWindowDays: 14, nowMs: t0 });
  s0.markUrls([{ url: "https://a" }]);
  // 5 days later: still within the 14-day window → seen.
  assert.equal(
    buildState({ stateDir: dir, seenWindowDays: 14, nowMs: t0 + 5 * day }).filterNew([{ url: "https://a" }]).length,
    0
  );
  // 20 days later: pruned → treated as new again.
  assert.equal(
    buildState({ stateDir: dir, seenWindowDays: 14, nowMs: t0 + 20 * day }).filterNew([{ url: "https://a" }]).length,
    1
  );
});
