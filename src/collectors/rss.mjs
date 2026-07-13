// rss.mjs — polls all configured RSS/Atom feeds, applies window + negative
// filters, caps per-feed volume, enriches with metadata.

import { getText } from "../lib/http.mjs";
import { parseFeed } from "../lib/feed.mjs";

export async function collect({ windowHours, sources, filters, metadata, nowMs = Date.now(), http = { getText } }) {
  const feeds = sources.rss?.feeds || [];
  const diag = { feeds_polled: feeds.length, successful: 0, failed: 0, per_feed: [] };
  const cutoff = Math.floor(nowMs / 1000) - windowHours * 3600;
  const items = [];

  for (const feed of feeds) {
    const res = await http.getText(feed.url, { ua: "Mozilla/5.0 (Scout RSS poller)" });
    if (!res.ok || !res.text) {
      diag.failed += 1;
      diag.per_feed.push({
        name: feed.name,
        url: feed.url,
        max_items_per_run: feed.max_items_per_run ?? 10,
        status: "error",
        http_status: res.status,
        fetched_entries: 0,
        kept: 0,
        dropped_timewindow: 0,
        dropped_category_filter: 0,
        dropped_blocked_text: 0,
        dropped_feed_cap: 0,
      });
      continue;
    }
    const parsed = parseFeed(res.text);
    diag.successful += 1;

    let keptForFeed = 0;
    const maxItems = feed.max_items_per_run ?? 10;
    let droppedTimewindow = 0;
    let droppedCategoryFilter = 0;
    let droppedBlockedText = 0;
    let droppedFeedCap = 0;
    for (const entry of parsed) {
      if (keptForFeed >= maxItems) {
        droppedFeedCap += 1;
        continue;
      }
      if (entry.ts && entry.ts < cutoff) {
        droppedTimewindow += 1;
        continue;
      }

      // Optional category / URL-path filter (e.g. The Defiant — Blockchains only).
      if (feed.category_filter) {
        const hasCat = (entry.categories || []).includes(feed.category_filter);
        const hasPath = feed.url_path_filter && entry.url.includes(feed.url_path_filter);
        if (!hasCat && !hasPath) {
          droppedCategoryFilter += 1;
          continue;
        }
      }

      const combined = `${entry.title} ${entry.text}`;
      if (!filters.passes(combined)) {
        droppedBlockedText += 1;
        continue;
      }

      const createdIso = entry.ts ? new Date(entry.ts * 1000).toISOString() : "";
      items.push({
        source: "rss",
        subsource: feed.name,
        group: feed.group,
        tag: feed.tag || "",
        url: entry.url,
        title: entry.title,
        text: entry.text,
        author: { handle: feed.name },
        engagement: {},
        created_at: createdIso,
        metadata: metadata.extract(combined, [entry.url]),
      });
      keptForFeed += 1;
    }
    diag.per_feed.push({
      name: feed.name,
      url: feed.url,
      max_items_per_run: maxItems,
      status: "ok",
      fetched_entries: parsed.length,
      kept: keptForFeed,
      dropped_timewindow: droppedTimewindow,
      dropped_category_filter: droppedCategoryFilter,
      dropped_blocked_text: droppedBlockedText,
      dropped_feed_cap: droppedFeedCap,
    });
  }

  return { items, diag };
}
