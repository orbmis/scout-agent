// doctor.mjs — deeper than `diagnose`. Probes each source individually and
// returns per-check status with a one-line remediation, plus a config-schema
// check. Read this when something is broken and `diagnose` wasn't specific enough.

import fs from "node:fs";
import { getText, getJson } from "./lib/http.mjs";

function checkConfigShape(sources) {
  const problems = [];
  if (!sources.x?.list_id) problems.push("sources.x.list_id is empty");
  if (!(sources.rss?.feeds?.length > 0)) problems.push("sources.rss.feeds is empty");
  if (!(sources.arxiv?.categories?.length > 0)) problems.push("sources.arxiv.categories is empty");
  return { ok: problems.length === 0, problems };
}

export async function runDoctor(config) {
  const { sources, secrets } = config;
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, ...(ok ? {} : { fix }) });

  // Config schema
  const cfg = checkConfigShape(sources);
  add("config", cfg.ok, cfg.ok ? "sources.json well-formed" : cfg.problems.join("; "), "edit config/sources.json");

  // Each RSS feed reachable
  const feeds = sources.rss?.feeds || [];
  const feedResults = await Promise.all(
    feeds.map(async (f) => ({ name: f.name, ...(await getText(f.url, { ua: "scout-doctor", timeoutMs: 10000 })) }))
  );
  const deadFeeds = feedResults.filter((r) => !r.ok).map((r) => r.name);
  add("rss_feeds", deadFeeds.length === 0, `${feeds.length - deadFeeds.length}/${feeds.length} reachable${deadFeeds.length ? `; dead: ${deadFeeds.join(", ")}` : ""}`, "update the feed URL(s) in config/sources.json");

  // GitHub rate limit
  const ghHeaders = secrets.GITHUB_TOKEN ? { Authorization: `Bearer ${secrets.GITHUB_TOKEN}` } : {};
  const rl = await getJson("https://api.github.com/rate_limit", { headers: ghHeaders, timeoutMs: 10000 });
  const remaining = rl.json?.resources?.core?.remaining;
  add("github", rl.ok && remaining > 0, rl.ok ? `${remaining} core requests remaining${secrets.GITHUB_TOKEN ? "" : " (unauthenticated — set GITHUB_TOKEN)"}` : "rate_limit endpoint unreachable", "set GITHUB_TOKEN in ~/.config/social-scan/.env");

  // arxiv reachable
  const ax = await getText(`${sources.arxiv?.base_url || "https://export.arxiv.org/rss"}/${sources.arxiv?.categories?.[0] || "cs.CR"}`, { ua: "scout-doctor", timeoutMs: 10000 });
  add("arxiv", ax.ok, ax.ok ? "reachable" : `unreachable (status ${ax.status})`, "check network / arxiv.base_url");

  // X List visibility (only if a token is present)
  if (secrets.X_BEARER_TOKEN) {
    const x = await getText(`https://api.x.com/2/lists/${sources.x.list_id}/tweets?max_results=5`, { headers: { Authorization: `Bearer ${secrets.X_BEARER_TOKEN}` }, timeoutMs: 10000 });
    add("x", x.ok, x.ok ? "List readable" : `status ${x.status} — List may be private or token invalid`, "make the X List public and verify X_BEARER_TOKEN");
  } else {
    add("x", false, "no X_BEARER_TOKEN (collector will be skipped)", "set X_BEARER_TOKEN to enable the X collector");
  }

  // Telegram session
  const tgSession = sources.telegram?.session_path ? fs.existsSync(`${sources.telegram.session_path}.session`) : false;
  const tgVenv = sources.telegram?.python_bin ? fs.existsSync(sources.telegram.python_bin) : false;
  add("telegram", tgVenv && tgSession, `venv ${tgVenv ? "present" : "missing"}, session ${tgSession ? "present" : "missing"}`, "see README 'Telegram setup'");

  return { command: "doctor", ok: checks.every((c) => c.ok || c.name === "x" || c.name === "telegram"), checks };
}
