// x.mjs — reads the configured X watch List via GET /2/lists/:id/tweets.
// One API call covers every List member. Emits items with source "x-seed".

import { getJson } from "../lib/http.mjs";

export async function collect({ windowHours, sources, secrets, filters, metadata, http = { getJson } }) {
  const cfg = sources.x || {};
  const diag = { tweets_returned: 0, kept: 0, dropped_timewindow: 0, dropped_filters: 0, status: "ok" };

  if (!cfg.list_id || cfg.list_id === "REPLACE_WITH_YOUR_LIST_ID") {
    diag.status = "no_list_id";
    return { items: [], diag };
  }
  if (!secrets.X_BEARER_TOKEN) {
    diag.status = "no_token";
    return { items: [], diag };
  }

  const seedByHandle = new Map(
    (cfg.seed_authors || []).map((a) => [a.handle.toLowerCase(), a.category])
  );

  const params = new URLSearchParams({
    max_results: String(cfg.max_results || 100),
    "tweet.fields": "created_at,public_metrics,text,entities,referenced_tweets",
    expansions: "author_id",
    "user.fields": "username,name,created_at,public_metrics,description",
  });
  const url = `https://api.x.com/2/lists/${cfg.list_id}/tweets?${params}`;
  const res = await http.getJson(url, { headers: { Authorization: `Bearer ${secrets.X_BEARER_TOKEN}` } });
  const body = res.json;

  if (!body || body.errors || body.error || body.title === "Forbidden" || body.title === "Not Found") {
    diag.status = "api_error";
    return { items: [], diag };
  }

  const users = new Map((body.includes?.users || []).map((u) => [u.id, u]));
  const tweets = body.data || [];
  diag.tweets_returned = tweets.length;

  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const now = Math.floor(Date.now() / 1000);
  const items = [];

  for (const tweet of tweets) {
    const author = users.get(tweet.author_id) || {};
    const handle = author.username || "unknown";
    const text = tweet.text || "";

    const created = tweet.created_at || "";
    if (created) {
      const ts = Math.floor(Date.parse(created) / 1000);
      if (Number.isFinite(ts) && ts < cutoff) {
        diag.dropped_timewindow += 1;
        continue;
      }
    }
    if (!filters.passes(text)) {
      diag.dropped_filters += 1;
      continue;
    }

    let accountAgeDays = 0;
    if (author.created_at) {
      const ts = Math.floor(Date.parse(author.created_at) / 1000);
      if (Number.isFinite(ts) && ts > 0) accountAgeDays = Math.floor((now - ts) / 86400);
    }

    const expandedUrls = (tweet.entities?.urls || []).map((u) => u.expanded_url).filter(Boolean);
    const pm = tweet.public_metrics || {};

    items.push({
      source: "x-seed",
      subsource: `@${handle}`,
      url: `https://x.com/${handle}/status/${tweet.id}`,
      text,
      author: {
        handle,
        display_name: author.name || "",
        bio: author.description || "",
        account_age_days: accountAgeDays,
        followers: author.public_metrics?.followers_count || 0,
        is_seed_author: true,
        seed_category: seedByHandle.get(handle.toLowerCase()) || "uncategorised",
      },
      engagement: {
        likes: pm.like_count || 0,
        reposts: pm.retweet_count || 0,
        replies: pm.reply_count || 0,
        quotes: pm.quote_count || 0,
      },
      created_at: created,
      metadata: metadata.extract(`${text} ${expandedUrls.join(" ")}`, expandedUrls),
      expanded_urls: expandedUrls,
    });
    diag.kept += 1;
  }

  return { items, diag };
}
