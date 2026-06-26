// Unit tests for the live-e2e verdict logic (offline — no network).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateLiveRun } from "../scripts/live-e2e.mjs";

// A temp dir with the two editorial outputs present, for the "outputs" check.
function withOutputs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-live-test-"));
  const dailyPath = path.join(dir, "2026-06-25.md");
  const filteredPath = path.join(dir, "2026-06-25_filtered.md");
  fs.writeFileSync(dailyPath, "# signals");
  fs.writeFileSync(filteredPath, "# filtered");
  return { dailyPath, filteredPath };
}

const healthyReport = {
  collectors: {
    x_seed: { items: 0, status: "no_token" },
    rss: { items: 12, status: "ok" },
    github: { items: 4, status: "ok" },
    arxiv: { items: 0, status: "ok" }, // 0 is fine (e.g. weekend)
  },
  warnings: [],
  ok: true,
};
const readyDiag = { summary: { ready_to_collect: true } };

test("passes when public sources are healthy and X is absent", () => {
  const { dailyPath, filteredPath } = withOutputs();
  const v = evaluateLiveRun({
    diagnostics: readyDiag,
    report: healthyReport,
    dailyPath,
    filteredPath,
    hasXToken: false,
  });
  assert.equal(v.pass, true, JSON.stringify(v.checks));
});

test("fails when a public collector errored", () => {
  const { dailyPath, filteredPath } = withOutputs();
  const report = {
    ...healthyReport,
    collectors: { ...healthyReport.collectors, github: { items: 0, status: "error" } },
  };
  const v = evaluateLiveRun({ diagnostics: readyDiag, report, dailyPath, filteredPath, hasXToken: false });
  assert.equal(v.pass, false);
  assert.ok(v.checks.find((c) => c.name === "public_sources" && !c.ok));
});

test("fails when an X token is present but the X collector errored", () => {
  const { dailyPath, filteredPath } = withOutputs();
  const report = {
    ...healthyReport,
    collectors: { ...healthyReport.collectors, x_seed: { items: 0, status: "api_error" } },
  };
  const v = evaluateLiveRun({ diagnostics: readyDiag, report, dailyPath, filteredPath, hasXToken: true });
  assert.equal(v.pass, false);
  assert.ok(v.checks.find((c) => c.name === "x_collector" && !c.ok));
});

test("fails when outputs are missing", () => {
  const v = evaluateLiveRun({
    diagnostics: readyDiag,
    report: healthyReport,
    dailyPath: "/no/such.md",
    filteredPath: "/no/such_filtered.md",
    hasXToken: false,
  });
  assert.equal(v.pass, false);
  assert.ok(v.checks.find((c) => c.name === "outputs" && !c.ok));
});
