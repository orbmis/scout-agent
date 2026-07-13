// diagnose.mjs — preflight checks. Answers "is this machine able to run Scout,
// and which channels are live?" without writing a manifest. Used by `scout diagnose`.

import fs from "node:fs";
import { getText } from "./lib/http.mjs";

async function reachable(url, headers = {}) {
  const res = await getText(url, { headers, timeoutMs: 10000 });
  return { url, ok: res.ok, status: res.status };
}

export async function runDiagnostics(config) {
  const { sources, secrets, signalsDir, manifestDir, stateDir } = config;

  const node = process.versions.node;
  const nodeMajor = Number(node.split(".")[0]);

  const checks = {
    node: { version: node, ok: nodeMajor >= 18 },
    paths: {
      signalsDir: { path: signalsDir, exists: fs.existsSync(signalsDir) },
      manifestDir: { path: manifestDir, writable: canWrite(manifestDir) },
      stateDir: { path: stateDir, writable: canWrite(stateDir) },
    },
    credentials: {
      X_BEARER_TOKEN: Boolean(secrets.X_BEARER_TOKEN),
      GITHUB_TOKEN: Boolean(secrets.GITHUB_TOKEN),
    },
    config: {
      x_list_id: sources.x?.list_id || null,
      seed_authors: (sources.x?.seed_authors || []).length,
      rss_feeds: (sources.rss?.feeds || []).length,
      rss_window_hours: config.windows?.rss ?? null,
      rss_max_items_per_run: Object.fromEntries((sources.rss?.feeds || []).map((feed) => [feed.name, feed.max_items_per_run ?? 10])),
      arxiv_categories: (sources.arxiv?.categories || []).length,
    },
  };

  // Connectivity (best-effort, short timeouts).
  const githubHeaders = secrets.GITHUB_TOKEN ? { Authorization: `Bearer ${secrets.GITHUB_TOKEN}` } : {};
  checks.connectivity = {
    github: await reachable("https://api.github.com/rate_limit", githubHeaders),
    arxiv: await reachable(`${sources.arxiv?.base_url || "https://export.arxiv.org/rss"}/cs.CR`),
    x: secrets.X_BEARER_TOKEN
      ? await reachable(`https://api.x.com/2/lists/${sources.x.list_id}/tweets?max_results=5`, {
          Authorization: `Bearer ${secrets.X_BEARER_TOKEN}`,
        })
      : { url: "x", ok: false, status: "no_token" },
  };

  checks.summary = {
    ready_to_collect: checks.node.ok && checks.paths.manifestDir.writable && checks.paths.stateDir.writable,
    live_channels: [
      checks.credentials.X_BEARER_TOKEN && "x",
      checks.connectivity.github.ok && "github",
      checks.connectivity.arxiv.ok && "arxiv",
      checks.config.rss_feeds > 0 && "rss",
    ].filter(Boolean),
  };

  return { command: "diagnose", ...checks };
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
