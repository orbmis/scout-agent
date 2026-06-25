// config.mjs — resolves all paths, windows, secrets, and loaded config.
// This is the ONLY place that knows where things live. Everything else takes
// what it needs from the object returned by loadConfig().

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function intEnv(name, fallback) {
  const v = process.env[name];
  const n = v == null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function expandTilde(p) {
  if (!p) return p;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// Best-effort load of the secrets file (KEY=VALUE lines). The orchestrator on
// the host usually sources this into the environment already; we load it too so
// local/standalone runs work. Existing process.env always wins.
export function loadEnvFile(file) {
  const target = file || process.env.SOCIAL_SCAN_ENV_FILE || path.join(os.homedir(), ".config/social-scan/.env");
  if (!fs.existsSync(target)) return {};
  const loaded = {};
  for (const line of fs.readFileSync(target, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    loaded[m[1]] = val;
    if (process.env[m[1]] == null) process.env[m[1]] = val;
  }
  return loaded;
}

export function loadConfig() {
  loadEnvFile();

  const workspaceRoot = process.env.OPENCLAW_WORKSPACE || repoRoot;
  const home = os.homedir();
  const signalsDir = process.env.SCOUT_SIGNALS_DIR || path.join(home, "obsidian-vault/Signals");
  const manifestDir = process.env.SCOUT_MANIFEST_DIR || "/tmp/scout";
  const stateDir = process.env.SCOUT_STATE_DIR || path.join(home, ".local/share/scout");

  const sources = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/sources.json"), "utf8"));
  const editorial = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/editorial.json"), "utf8"));
  // Expand ~ in telegram paths once, here.
  if (sources.telegram) {
    sources.telegram.python_bin = expandTilde(sources.telegram.python_bin);
    sources.telegram.session_path = expandTilde(sources.telegram.session_path);
  }

  return {
    repoRoot,
    workspaceRoot,
    signalsDir,
    manifestDir,
    stateDir,
    seenWindowDays: intEnv("SCOUT_SEEN_WINDOW_DAYS", 14),
    windows: {
      x_seed: intEnv("SEED_HOURS", 24),
      rss: intEnv("RSS_HOURS", 48),
      github: intEnv("GITHUB_HOURS", 24),
      arxiv: intEnv("ARXIV_HOURS", 48),
      telegram: intEnv("TELEGRAM_HOURS", 4),
    },
    secrets: {
      X_BEARER_TOKEN: process.env.X_BEARER_TOKEN || "",
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
      TELEGRAM_API_ID: process.env.TELEGRAM_API_ID || "",
      TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH || "",
    },
    sources,
    editorial,
    // Files the editorial engine reads for personalization.
    userMdPath: path.join(workspaceRoot, "USER.md"),
  };
}
