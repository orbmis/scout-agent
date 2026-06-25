// Coverage for the previously-untested collectors and editorial units.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMetadata } from "../src/lib/metadata.mjs";
import { buildFilters } from "../src/lib/filters.mjs";
import { collect as collectGithub } from "../src/collectors/github.mjs";
import { collect as collectArxiv } from "../src/collectors/arxiv.mjs";
import { collect as collectTelegram } from "../src/collectors/telegram.mjs";
import { expandFlashbots } from "../src/editorial/flashbots.mjs";
import { assignTier, dedupAgainstPrevious } from "../src/editorial/cluster.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const editorial = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/editorial.json"), "utf8"));
const metadata = buildMetadata(editorial.tracked);
const filters = buildFilters(editorial.negative);
const BIG = 1000000; // window large enough that fixture dates always pass

test("github collector reads releases and EIP commits (N+1)", async () => {
  const sources = { github: { release_watch: [{ owner: "ethereum", repo: "EIPs" }], eip_repo: { owner: "ethereum", repo: "EIPs" } } };
  const http = {
    getJson: async (url) => {
      if (url.includes("/releases")) return { json: [{ published_at: "2026-06-20T00:00:00Z", name: "v1", tag_name: "v1", html_url: "https://gh/r/1", body: "ERC-4337 paymaster fix" }] };
      if (url.includes("/commits?path=EIPS")) return { json: [{ sha: "s1" }] };
      if (url.includes("/commits/s1")) return { json: { commit: { message: "Update ERC-7702", author: { name: "dev", date: "2026-06-20T00:00:00Z" } }, files: [{ filename: "EIPS/eip-7702.md", status: "modified" }] } };
      return { json: [] };
    },
  };
  const { items, diag } = await collectGithub({ windowHours: BIG, sources, secrets: {}, filters, metadata, http });
  assert.equal(diag.releases, 1);
  assert.equal(diag.eip_changes, 1);
  assert.ok(items.some((i) => i.event === "release"));
  assert.ok(items.some((i) => i.event === "eip-commit" && i.metadata.eip_numbers.includes(7702)));
});

test("arxiv collector keeps only keyword-matching items", async () => {
  const sources = { arxiv: { base_url: "http://x", categories: ["cs.CR"], keyword_filter: ["account abstraction"] } };
  const xml = `<rss><channel>
    <item><title>On account abstraction wallets</title><link>https://arxiv.org/abs/1</link><description>smart account stuff</description><pubDate>Mon, 22 Jun 2026 00:00:00 GMT</pubDate></item>
    <item><title>Unrelated topology paper</title><link>https://arxiv.org/abs/2</link><description>manifolds</description><pubDate>Mon, 22 Jun 2026 00:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const http = { getText: async () => ({ ok: true, text: xml }) };
  const { items, diag } = await collectArxiv({ windowHours: BIG, sources, filters, metadata, http });
  assert.equal(diag.items_kept, 1);
  assert.match(items[0].title, /account abstraction/);
});

test("telegram collector degrades to a clear status when the venv is missing", async () => {
  const sources = { telegram: { channels: [{ group: "ERC8004" }], python_bin: "/nonexistent/python", session_path: "/nonexistent/s" } };
  const { items, diag } = await collectTelegram({ windowHours: 4, sources, filters, metadata });
  assert.equal(items.length, 0);
  assert.equal(diag.status, "venv_missing");
});

test("flashbots expander unpacks the newsletter into linked items", () => {
  const item = {
    source: "rss", subsource: "Flashbots MEV Newsletter", url: "https://collective.flashbots.net/t/the-mev-letter/1",
    text: `<h1>Posts &amp; Threads</h1><ul><li><a href="https://x.com/foo/status/123">A concrete AA delegation thread</a> notes on 7702</li></ul>`,
  };
  const expanded = expandFlashbots(item, metadata.extract);
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].url, "https://x.com/foo/status/123");
  assert.match(expanded[0].title, /AA delegation/);
});

test("assignTier maps sources to the right tiers", () => {
  assert.equal(assignTier({ source: "github" }), 0);
  assert.equal(assignTier({ source: "rss", group: "core_protocol" }), 0);
  assert.equal(assignTier({ source: "x-seed", author: { is_seed_author: true } }), 1);
  assert.equal(assignTier({ source: "x-seed", author: {}, engagement: { seed_engaged_by: ["a"] } }), 2);
  assert.equal(assignTier({ source: "x-seed", author: {}, engagement: {} }), 3);
});

test("dedupAgainstPrevious drops items already covered by a prior file", () => {
  const item = { url: "https://blog.ethereum.org/aa", title: "ERC-4337 update", text: "x", metadata: { eip_numbers: [4337] } };
  const prev = [{ file: "2026-06-20.md", content: "see https://blog.ethereum.org/aa", lower: "see https://blog.ethereum.org/aa" }];
  const verdict = dedupAgainstPrevious(item, prev);
  assert.equal(verdict.exclusionClass, "topic_dedup");
  assert.equal(dedupAgainstPrevious(item, []), null);
});
