// process.mjs — the editorial half. Reads a manifest, scores/tiers/dedups every
// item, and writes the daily + filtered signal files. Deterministic, no network.

import fs from "node:fs";
import path from "node:path";
import { buildMetadata } from "./lib/metadata.mjs";
import { buildState } from "./lib/state.mjs";
import { lowerText } from "./lib/text.mjs";
import { expandFlashbots } from "./editorial/flashbots.mjs";
import { scoreItem, whyMatter, describeConnect } from "./editorial/score.mjs";
import { assignTier, threadClusterKey, topicKeyFor, loadPreviousEntries, dedupAgainstPrevious } from "./editorial/cluster.mjs";
import { renderDaily, renderFiltered, titleFor, summarize } from "./editorial/render.mjs";

// Core editorial reduction over manifest items. Pure given (items, previousEntries, extractMetadata).
export function evaluate(manifestItems, { previousEntries = [], extractMetadata }) {
  const expanded = manifestItems.flatMap((item) => expandFlashbots(item, extractMetadata));
  const kept = [];
  const filtered = [];
  const intraDayClusters = new Map();

  for (const item of expanded) {
    const score = scoreItem(item);
    if (score.exclusionClass) {
      filtered.push({ item, ...score });
      continue;
    }
    const tier = assignTier(item);
    const clusterKeys = [topicKeyFor(item), ...(threadClusterKey(item) || [])];
    const existing = clusterKeys.map((key) => intraDayClusters.get(key)).filter(Boolean).sort((a, b) => b.score - a.score)[0];

    if (existing && existing.score >= score.score) {
      filtered.push({ item, ...score, exclusionClass: "collapsed_to_cluster", reason: `Another kept item covered the same development more directly (${titleFor(existing.item)}).` });
      continue;
    }
    if (existing) {
      filtered.push({ item: existing.item, ...existing.scoreMeta, exclusionClass: "collapsed_to_cluster", reason: `Another kept item covered the same development more directly (${titleFor(item)}).` });
      kept.splice(existing.keptIndex, 1);
    }

    const prior = dedupAgainstPrevious(item, previousEntries);
    if (prior) {
      filtered.push({ item, ...score, ...prior });
      continue;
    }

    const scoreMeta = { ...score, tier, summary: summarize(item), why: whyMatter(item), connect: describeConnect(item) };
    for (const key of clusterKeys) intraDayClusters.set(key, { item, score: score.score, scoreMeta, keptIndex: kept.length });
    kept.push({ item, ...scoreMeta });
  }

  kept.sort((a, b) => a.tier - b.tier || b.score - a.score || (a.item.created_at || "").localeCompare(b.item.created_at || ""));
  filtered.sort((a, b) => {
    const order = { below_threshold: 0, missing_anchor_signal: 1, topic_dedup: 2, collapsed_to_cluster: 3 };
    return (order[a.exclusionClass] ?? 9) - (order[b.exclusionClass] ?? 9);
  });

  return { kept, filtered };
}

// Full side-effecting run: read manifest, evaluate, write files + state.
export function processManifest(config, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const metadata = buildMetadata(config.editorial.tracked);
  const state = buildState({ stateDir: config.stateDir, seenWindowDays: config.seenWindowDays, nowMs: config.nowMs });

  const signalDate = manifest.date_utc;
  const signalsDir = manifest.signals_dir || config.signalsDir;
  fs.mkdirSync(signalsDir, { recursive: true });

  const previousEntries = loadPreviousEntries(manifest.previous_signals_files);
  const { kept, filtered } = evaluate(manifest.items || [], { previousEntries, extractMetadata: metadata.extract });

  const dailyPath = path.join(signalsDir, `${signalDate}.md`);
  const filteredPath = path.join(signalsDir, `${signalDate}_filtered.md`);
  const risingAuthorsPath = path.join(signalsDir, `rising-authors-${signalDate}.md`);

  fs.writeFileSync(dailyPath, renderDaily({ signalDate, manifest, manifestPath, kept }));
  fs.writeFileSync(filteredPath, renderFiltered({ signalDate, kept, filtered }));

  // Append new Tier 3 authors to rolling state.
  const tier3 = kept
    .filter((entry) => entry.tier === 3 && entry.item.author?.handle)
    .map((entry) => ({ date: signalDate, handle: entry.item.author.handle, url: entry.item.url, score_axis: entry.dominantAxis, subsource: entry.item.subsource || "" }));
  state.appendTier3(tier3);

  let risingWritten = false;
  if (manifest.weekly_report_due) {
    fs.writeFileSync(
      risingAuthorsPath,
      [`# Rising Authors — ${signalDate}`, "", "Weekly report requested, but no Tier 3 author crossed the two-appearance threshold in the current local state snapshot.", ""].join("\n")
    );
    risingWritten = true;
  }

  // Marker is the trigger; delete it on success.
  const markerPath = path.join(config.manifestDir, `ready-${signalDate}.marker`);
  if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);

  return {
    dailyPath,
    filteredPath,
    risingWritten,
    risingAuthorsPath,
    keptCount: kept.length,
    filteredCount: filtered.length,
    strongest: kept.slice(0, 4).map((entry) => ({ title: titleFor(entry.item), url: entry.item.url, tier: entry.tier, score: entry.composite })),
  };
}
