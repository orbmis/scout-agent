// Unit tests for the pure building blocks: feed parsing, metadata, filters, scoring.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFeed } from "../src/lib/feed.mjs";
import { buildMetadata } from "../src/lib/metadata.mjs";
import { buildFilters } from "../src/lib/filters.mjs";
import { scoreItem } from "../src/editorial/score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const editorial = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/editorial.json"), "utf8"));
const fixture = (f) => fs.readFileSync(path.join(here, "fixtures", f), "utf8");

test("parseFeed reads RSS 2.0 items with categories and dates", () => {
  const items = parseFeed(fixture("rss-sample.xml"));
  assert.equal(items.length, 2);
  assert.match(items[0].title, /ERC-4337/);
  assert.equal(items[0].url, "https://blog.ethereum.org/2026/06/01/aa-update");
  assert.ok(items[0].categories.includes("Blockchains"));
  assert.ok(items[0].ts > 0);
});

test("parseFeed reads Atom entries with href links", () => {
  const items = parseFeed(fixture("atom-sample.xml"));
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://ethresear.ch/t/session-keys-delegation/1234");
  assert.match(items[0].text, /delegation/);
});

test("metadata extracts tracked EIPs, markers, and anchor links", () => {
  const { extract } = buildMetadata(editorial.tracked);
  const md = extract("ERC-4337 smart account with session key", ["https://eips.ethereum.org/EIPS/eip-4337"]);
  assert.equal(md.has_eip_reference, true);
  assert.ok(md.eip_numbers.includes(4337));
  assert.ok(md.technical_markers.includes("smart account"));
  assert.ok(md.anchor_domain_links.length > 0);
});

test("filters block tickers/pump phrases and noise replies", () => {
  const filters = buildFilters(editorial.negative);
  assert.equal(filters.passes("ERC-4337 update"), true);
  assert.equal(filters.passes("$DOGE to the moon 🚀🚀🚀"), false);
  assert.equal(filters.isNoiseReply("+1"), true);
  assert.equal(filters.isNoiseReply("Here is a substantive technical reply"), false);
});

test("scoreItem keeps a strong primary-source item and excludes a thin one", () => {
  const { extract } = buildMetadata(editorial.tracked);
  const strong = {
    source: "rss",
    group: "core_protocol",
    subsource: "Ethereum Blog",
    title: "ERC-4337 account abstraction update",
    text: "Deep dive into ERC-4337 bundlers, paymaster and session keys for smart accounts.",
    url: "https://blog.ethereum.org/aa",
    author: { handle: "Ethereum Blog" },
    engagement: {},
    metadata: extract("ERC-4337 account abstraction bundler paymaster session key smart account", [
      "https://blog.ethereum.org/aa",
    ]),
  };
  const thin = {
    source: "x-seed",
    subsource: "@x",
    title: "",
    text: "gm",
    url: "https://x.com/x/status/1",
    author: { handle: "x" },
    engagement: {},
    metadata: extract("gm", []),
  };
  assert.equal(scoreItem(strong).exclusionClass, null);
  assert.ok(scoreItem(thin).exclusionClass);
});
