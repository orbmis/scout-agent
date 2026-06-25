// state.mjs — persistent rolling state. URL dedup over a 14-day window plus the
// append-only tier3-authors log. Stored as TSV (ts<TAB>url) under stateDir.

import fs from "node:fs";
import path from "node:path";

// nowMs is the injectable logical clock (epoch ms). Defaults to the real clock;
// tests pass a fixed value for deterministic window/prune behaviour.
export function buildState({ stateDir, seenWindowDays = 14, nowMs = Date.now() }) {
  const seenUrlsFile = path.join(stateDir, "seen-urls.tsv");
  const tier3AuthorsFile = path.join(stateDir, "tier3-authors.jsonl");
  const nowSec = Math.floor(nowMs / 1000);

  function init() {
    fs.mkdirSync(stateDir, { recursive: true });
    if (!fs.existsSync(seenUrlsFile)) fs.writeFileSync(seenUrlsFile, "");
    if (!fs.existsSync(tier3AuthorsFile)) fs.writeFileSync(tier3AuthorsFile, "");
  }

  function cutoff() {
    return nowSec - seenWindowDays * 86400;
  }

  // Returns a Set of URLs seen within the window, and rewrites the file pruned.
  function loadSeen() {
    init();
    const c = cutoff();
    const seen = new Set();
    const keptLines = [];
    for (const line of fs.readFileSync(seenUrlsFile, "utf8").split("\n")) {
      if (!line) continue;
      const [tsRaw, url] = line.split("\t");
      const ts = parseInt(tsRaw, 10);
      if (!Number.isFinite(ts) || ts < c) continue;
      seen.add(url);
      keptLines.push(line);
    }
    fs.writeFileSync(seenUrlsFile, keptLines.length ? keptLines.join("\n") + "\n" : "");
    return seen;
  }

  // Items whose .url is not already in the window. Does NOT mutate state, so the
  // caller can commit only after the manifest is safely written.
  function filterNew(items) {
    const seen = loadSeen();
    return items.filter((it) => {
      const url = it.url;
      if (!url) return true;
      return !seen.has(url);
    });
  }

  function markUrls(items) {
    init();
    const ts = nowSec;
    const lines = items
      .map((it) => it.url)
      .filter(Boolean)
      .map((url) => `${ts}\t${url}`);
    if (lines.length) fs.appendFileSync(seenUrlsFile, lines.join("\n") + "\n");
  }

  function appendTier3(records) {
    if (!records.length) return;
    init();
    fs.appendFileSync(tier3AuthorsFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  return { init, filterNew, markUrls, appendTier3, seenUrlsFile, tier3AuthorsFile };
}
