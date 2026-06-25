// End-to-end editorial test: a hand-built manifest through processManifest,
// writing into a temp workspace. No network, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("processManifest writes daily + filtered files and removes the marker", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scout-e2e-"));
  const signalsDir = path.join(tmp, "Signals");
  const manifestDir = path.join(tmp, "manifest");
  fs.mkdirSync(signalsDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });

  // Configure the engine to use the temp workspace.
  process.env.SCOUT_SIGNALS_DIR = signalsDir;
  process.env.SCOUT_MANIFEST_DIR = manifestDir;
  process.env.SCOUT_STATE_DIR = path.join(tmp, "state");

  const date = "2026-06-25";
  const manifest = {
    schema_version: "1.1",
    captured_at: "2026-06-25T08:00:00Z",
    date_utc: date,
    window_hours: { x_seed: 24, rss: 48, github: 24, arxiv: 48 },
    signals_dir: signalsDir,
    previous_signals_files: [],
    weekly_report_due: false,
    collection_diagnostics: { x_seed: { items_kept: 1 }, rss: { items_kept: 1 }, github: { items_kept: 0 }, arxiv: { items_kept: 0 }, telegram: { status: "no_channels", items_kept: 0 }, dedup: { total_before: 2, total_after: 2 } },
    items: [
      {
        source: "rss", group: "core_protocol", subsource: "Ethereum Blog",
        title: "ERC-4337 account abstraction update", url: "https://blog.ethereum.org/aa",
        text: "Deep dive into ERC-4337 bundlers, paymaster and session keys for smart accounts.",
        author: { handle: "Ethereum Blog" }, engagement: {},
        metadata: { has_eip_reference: true, eip_numbers: [4337], has_code_block: false, anchor_domain_links: ["blog.ethereum.org"], tracked_companies: [], tracked_protocols: [], technical_markers: ["smart account", "session key"] },
      },
      {
        source: "x-seed", subsource: "@moonboy", title: "", url: "https://x.com/moonboy/status/1",
        text: "gm", author: { handle: "moonboy" }, engagement: {},
        metadata: { has_eip_reference: false, eip_numbers: [], has_code_block: false, anchor_domain_links: [], tracked_companies: [], tracked_protocols: [], technical_markers: [] },
      },
    ],
  };

  const manifestPath = path.join(manifestDir, `manifest-${date}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(manifestDir, `ready-${date}.marker`), "");

  // Fresh config import after env is set.
  const { loadConfig } = await import("../src/config.mjs");
  const { processManifest } = await import("../src/process.mjs");
  const result = processManifest(loadConfig(), manifestPath);

  assert.equal(result.keptCount, 1, "strong primary-source item kept");
  assert.ok(result.filteredCount >= 1, "thin item filtered");
  assert.ok(fs.existsSync(result.dailyPath));
  assert.ok(fs.existsSync(result.filteredPath));
  assert.match(fs.readFileSync(result.dailyPath, "utf8"), /Tier 0 — Primary Source/);
  assert.ok(!fs.existsSync(path.join(manifestDir, `ready-${date}.marker`)), "marker removed on success");
});
