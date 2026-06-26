// http.mjs — the single network seam. Collectors call only these helpers, so
// tests can stub the whole module to run end-to-end with no network.
//
// Record/replay (for building and serving offline fixtures):
//   SCOUT_HTTP_MODE=record  SCOUT_HTTP_FIXTURES=<dir>   capture real responses
//   SCOUT_HTTP_MODE=replay  SCOUT_HTTP_FIXTURES=<dir>   serve captured responses

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30000;

function fixtureFile(url) {
  const dir = process.env.SCOUT_HTTP_FIXTURES;
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "url";
    }
  })();
  return path.join(dir, `${host}-${hash}.json`);
}

async function realGetText(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, ua } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": ua || "scout-signal-scan", ...headers },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function getText(url, opts = {}) {
  const mode = process.env.SCOUT_HTTP_MODE;
  if (mode === "replay") {
    const file = fixtureFile(url);
    if (!fs.existsSync(file)) return { ok: false, status: 0, text: "", error: `no fixture for ${url}` };
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const res = await realGetText(url, opts);
  if (mode === "record") {
    fs.mkdirSync(process.env.SCOUT_HTTP_FIXTURES, { recursive: true });
    fs.writeFileSync(fixtureFile(url), JSON.stringify({ ok: res.ok, status: res.status, text: res.text }));
  }
  return res;
}

export async function getJson(url, opts = {}) {
  const res = await getText(url, opts);
  if (!res.ok) return { ...res, json: null };
  try {
    return { ...res, json: JSON.parse(res.text) };
  } catch {
    return { ...res, json: null };
  }
}
