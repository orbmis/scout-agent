// rss.mjs — polls all configured RSS/Atom feeds, applies window + negative
// filters, caps per-feed volume, enriches with metadata.

import { getText } from "../lib/http.mjs";
import { parseFeed } from "../lib/feed.mjs";

export async function collect({ windowHours, sources, filters, metadata, http = { getText } }) {
  const feeds = sources.rss?.feeds || [];
  const diag = { feeds_polled: feeds.length, successful: 0, failed: 0 };
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const items = [];

  for (const feed of feeds) {
    const res = await http.getText(feed.url, { ua: "Mozilla/5.0 (Scout RSS poller)" });
    if (!res.ok || !res.text) {
      diag.failed += 1;
      continue;
    }
    const parsed = parseFeed(res.text);
    diag.successful += 1;

    let keptForFeed = 0;
    const maxItems = feed.max_items_per_run ?? 10;
    for (const entry of parsed) {
      if (keptForFeed >= maxItems) break;
      if (entry.ts && entry.ts < cutoff) continue;

      // Optional category / URL-path filter (e.g. The Defiant — Blockchains only).
      if (feed.category_filter) {
        const hasCat = (entry.categories || []).includes(feed.category_filter);
        const hasPath = feed.url_path_filter && entry.url.includes(feed.url_path_filter);
        if (!hasCat && !hasPath) continue;
      }

      const combined = `${entry.title} ${entry.text}`;
      if (!filters.passes(combined)) continue;

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
  }

  return { items, diag };
}
