// arxiv.mjs — polls arxiv RSS per category, keeps items matching >=1 keyword.

import { getText } from "../lib/http.mjs";
import { parseFeed } from "../lib/feed.mjs";

export async function collect({ windowHours, sources, filters, metadata, nowMs = Date.now(), http = { getText } }) {
  const cfg = sources.arxiv || {};
  const categories = cfg.categories || [];
  const keywords = (cfg.keyword_filter || []).map((k) => k.toLowerCase());
  const diag = { cats_polled: 0, items_kept: 0 };
  const cutoff = Math.floor(nowMs / 1000) - windowHours * 3600;
  const items = [];

  for (const cat of categories) {
    diag.cats_polled += 1;
    const res = await http.getText(`${cfg.base_url}/${cat}`, { ua: "scout-arxiv-scan" });
    if (!res.ok || !res.text) continue;
    const parsed = parseFeed(res.text);

    for (const entry of parsed) {
      if (entry.ts && entry.ts < cutoff) continue;
      const combined = `${entry.title} ${entry.text}`;
      const lc = combined.toLowerCase();
      if (!keywords.some((kw) => lc.includes(kw))) continue;
      if (!filters.passes(combined)) continue;

      const createdIso = entry.ts ? new Date(entry.ts * 1000).toISOString() : "";
      items.push({
        source: "arxiv",
        subsource: `arxiv:${cat}`,
        url: entry.url,
        title: entry.title,
        text: entry.text,
        author: { handle: `arxiv:${cat}` },
        engagement: {},
        created_at: createdIso,
        metadata: metadata.extract(combined, [entry.url]),
      });
      diag.items_kept += 1;
    }
  }

  return { items, diag };
}
