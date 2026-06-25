// render.mjs — turns scored/tiered entries into the daily and filtered Markdown.

import { stripHtml } from "../lib/text.mjs";

export function summarize(item) {
  const text = stripHtml(item.text || "");
  if (item.source === "github") {
    return text.replace(/\s+/g, " ").trim().replace(/ - modified:.*$/i, "").replace(/ - added:.*$/i, "");
  }
  if (text.length <= 220) return text;
  return text.slice(0, 217).trimEnd() + "...";
}

export function titleFor(item) {
  if (item.title) return item.title;
  const text = stripHtml(item.text || "");
  if (item.author?.handle) {
    return `@${item.author.handle} — ${text.slice(0, 80).trim()}${text.length > 80 ? "..." : ""}`;
  }
  return text.slice(0, 90).trim() || item.url;
}

function formatAuthor(item) {
  const author = item.author || {};
  if (author.handle) {
    const age = author.account_age_days ? ` · account age ${author.account_age_days} days` : "";
    if (item.source === "rss" || item.source === "github" || item.source === "arxiv") {
      return `${author.display_name || author.handle}${age}`;
    }
    return `@${author.handle}${age}`;
  }
  return author.display_name || item.subsource || "Unknown";
}

function formatSource(item, tier) {
  if (item.source === "x-seed") return `X seed / Tier ${tier}`;
  if (item.source === "rss") return `RSS / Tier ${tier} / ${item.subsource}`;
  if (item.source === "github") return `GitHub / Tier ${tier} / ${item.subsource}`;
  if (item.source === "telegram") return `Telegram / Tier ${tier} / ${item.subsource}`;
  return `${item.source} / Tier ${tier}`;
}

function renderEntry(entry) {
  const { item } = entry;
  const engagement = item.engagement || {};
  const engagementParts = [];
  if ((engagement.seed_engaged_by || []).length > 0) engagementParts.push(`seed engaged by ${engagement.seed_engaged_by.join(", ")}`);
  if ((engagement.likes || 0) + (engagement.reposts || 0) + (engagement.replies || 0) + (engagement.quotes || 0) > 0) {
    engagementParts.push(`${engagement.likes || 0} likes, ${engagement.reposts || 0} reposts, ${engagement.replies || 0} replies, ${engagement.quotes || 0} quotes`);
  }
  const lines = [
    `### ${titleFor(item)}`,
    `- **Source:** ${formatSource(item, entry.tier)}`,
    `- **Author:** ${formatAuthor(item)}`,
    `- **Link:** ${item.url}`,
  ];
  if (engagementParts.length > 0) lines.push(`- **Engagement:** ${engagementParts.join("; ")}`);
  lines.push(`- **Summary:** ${entry.summary}`);
  lines.push(`- **Why it may matter:** ${entry.why}`);
  lines.push(`- **Composite score:** ${entry.composite}`);
  lines.push(`- **Dominant axis:** ${entry.dominantAxis}`);
  if (item.created_at) lines.push(`- **Captured timestamp:** ${item.created_at}`);
  if (entry.connect) lines.push(`- **${entry.connect}**`);
  return lines.join("\n");
}

function renderTier(tiers, tierNumber, heading, emptyLine) {
  const entries = tiers.get(tierNumber) || [];
  const lines = [`## ${heading}`, ""];
  if (!entries.length) {
    lines.push(emptyLine, "");
    return lines.join("\n");
  }
  for (const entry of entries) lines.push(renderEntry(entry), "");
  return lines.join("\n");
}

export function renderDaily({ signalDate, manifest, manifestPath, kept }) {
  const diag = manifest.collection_diagnostics || {};
  const tiers = new Map([[0, []], [1, []], [2, []], [3, []]]);
  for (const entry of kept) tiers.get(entry.tier).push(entry);

  const lines = [
    `# Signals — ${signalDate}`,
    "",
    "## Daily social scan",
    `- **Captured (UTC):** ${manifest.captured_at}`,
    `- **Manifest:** \`${manifestPath}\``,
    `- **Scan windows:** X seed ${manifest.window_hours?.x_seed ?? 24}h · RSS ${manifest.window_hours?.rss ?? 48}h · GitHub ${manifest.window_hours?.github ?? 24}h · arXiv ${manifest.window_hours?.arxiv ?? 48}h`,
    "",
    renderTier(tiers, 0, "Tier 0 — Primary Source", `No Tier 0 items were surfaced. RSS kept ${diag.rss?.items_kept ?? 0} items and GitHub kept ${diag.github?.items_kept ?? 0}, but none cleared the editorial threshold after scoring.`),
    renderTier(tiers, 1, "Tier 1 — Seed-Set Signal", `No Tier 1 items were surfaced. X seed kept ${diag.x_seed?.items_kept ?? 0} items, but none cleared threshold after substance checks.`),
    renderTier(tiers, 2, "Tier 2 — Seed-Adjacent Signal", `No seed-adjacent items were surfaced. Collection kept ${diag.x_seed?.items_kept ?? 0} X seed items, but no non-seed author in today's manifest carried usable seed-engagement context.`),
    renderTier(tiers, 3, "Tier 3 — Independent Signal", `No independent candidates cleared into the final note. Today's manifest included ${diag.arxiv?.items_kept ?? 0} arXiv items and ${diag.telegram?.items_kept ?? 0} Telegram items after collection-time filtering.`),
    "## Collection diagnostics",
    `- **X seed scan:** ${diag.x_seed?.items_kept ?? 0} items kept at collection time.`,
    `- **RSS:** ${diag.rss?.items_kept ?? 0} items kept at collection time.`,
    `- **GitHub:** ${diag.github?.items_kept ?? 0} items kept at collection time.`,
    `- **arXiv:** ${diag.arxiv?.items_kept ?? 0} items kept.`,
    `- **Telegram:** status \`${diag.telegram?.status ?? "unknown"}\`; ${diag.telegram?.items_kept ?? 0} items kept; channels scanned ${diag.telegram?.channels_scanned ?? "unknown"}; channels with activity ${diag.telegram?.channels_with_activity ?? "unknown"}.`,
    `- **Dedup:** ${diag.dedup?.total_before ?? 0} candidates before rolling dedup; ${diag.dedup?.total_after ?? 0} remained after dedup against the 14-day seen store.`,
    "",
  ];

  lines.push("## Editorial note");
  if (kept.length) {
    const strongest = kept.slice(0, Math.min(3, kept.length)).map((entry) => titleFor(entry.item));
    lines.push(`Today's strongest signals were ${strongest.join("; ")}.`);
  } else {
    lines.push("Today's manifest skewed heavily toward seed-set chatter and low-signal newsletter items rather than concrete standards, infrastructure, or payment developments.");
  }
  lines.push("");
  return lines.join("\n");
}

export function renderFiltered({ signalDate, kept, filtered }) {
  const lines = [`# Signals Filtered — ${signalDate}`, "", "## Below threshold", ""];

  for (const klass of ["below_threshold", "missing_anchor_signal", "topic_dedup", "collapsed_to_cluster"]) {
    if (klass !== "below_threshold") {
      lines.push(`## ${klass === "missing_anchor_signal" ? "Missing required anchor signal" : klass === "topic_dedup" ? "Topic dedup / prior coverage" : "Collapsed to cluster"}`, "");
    }
    const items = filtered.filter((entry) => entry.exclusionClass === klass);
    if (!items.length) {
      lines.push("No items.", "");
      continue;
    }
    for (const entry of items) {
      const item = entry.item;
      lines.push(
        `### ${titleFor(item)}`,
        `- **Source:** ${item.source} / ${item.subsource || "n/a"}`,
        `- **Author:** ${item.author?.handle ? "@" + item.author.handle : item.author?.display_name || "Unknown"}`,
        `- **Link:** ${item.url}`
      );
      if (item.created_at) lines.push(`- **Captured timestamp:** ${item.created_at}`);
      lines.push(`- **Exclusion class:** ${entry.exclusionClass}`, `- **Reason:** ${entry.reason}`, `- **Scoring note:** ${entry.composite} score; dominant axis ${entry.dominantAxis}.`, "");
    }
  }

  lines.push(
    "## Filter diagnostics summary",
    "",
    `- **Kept:** ${kept.length}`,
    `- **Filtered:** ${filtered.length}`,
    `- **Threshold failures:** ${filtered.filter((e) => e.exclusionClass === "below_threshold").length}`,
    `- **Missing anchor signal:** ${filtered.filter((e) => e.exclusionClass === "missing_anchor_signal").length}`,
    `- **Topic dedup:** ${filtered.filter((e) => e.exclusionClass === "topic_dedup").length}`,
    `- **Collapsed to cluster:** ${filtered.filter((e) => e.exclusionClass === "collapsed_to_cluster").length}`,
    ""
  );
  return lines.join("\n");
}
