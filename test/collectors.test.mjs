// Collector tests with a stubbed HTTP layer — fully offline, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMetadata } from "../src/lib/metadata.mjs";
import { buildFilters } from "../src/lib/filters.mjs";
import { collect as collectRss } from "../src/collectors/rss.mjs";
import { collect as collectX } from "../src/collectors/x.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const editorial = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/editorial.json"), "utf8"));
const fixture = (f) => fs.readFileSync(path.join(here, "fixtures", f), "utf8");

const metadata = buildMetadata(editorial.tracked);
const filters = buildFilters(editorial.negative);

test("rss collector keeps on-topic item, drops pump item", async () => {
  const sources = {
    rss: { feeds: [{ name: "Ethereum Blog", url: "http://x", group: "core_protocol", max_items_per_run: 10 }] },
  };
  const http = { getText: async () => ({ ok: true, text: fixture("rss-sample.xml") }) };
  const { items, diag } = await collectRss({ windowHours: 100000, sources, filters, metadata, http });
  assert.equal(diag.successful, 1);
  assert.equal(items.length, 1);
  assert.match(items[0].title, /ERC-4337/);
  assert.equal(items[0].source, "rss");
  assert.ok(items[0].metadata.has_eip_reference);
});

test("x collector maps seed category and filters pump tweets", async () => {
  const sources = {
    x: { list_id: "123", max_results: 100, seed_authors: [{ handle: "VitalikButerin", category: "aa_standards" }] },
  };
  const secrets = { X_BEARER_TOKEN: "test" };
  const http = { getJson: async () => ({ json: JSON.parse(fixture("x-list-response.json")) }) };
  const { items, diag } = await collectX({ windowHours: 100000, sources, secrets, filters, metadata, http });
  assert.equal(diag.tweets_returned, 2);
  assert.equal(items.length, 1); // pump tweet dropped by negative filter
  assert.equal(items[0].author.handle, "VitalikButerin");
  assert.equal(items[0].author.seed_category, "aa_standards");
  assert.equal(items[0].author.is_seed_author, true);
});

test("x collector returns empty with explicit status when no token", async () => {
  const { items, diag } = await collectX({
    windowHours: 24,
    sources: { x: { list_id: "123" } },
    secrets: {},
    filters,
    metadata,
    http: {},
  });
  assert.equal(items.length, 0);
  assert.equal(diag.status, "no_token");
});
