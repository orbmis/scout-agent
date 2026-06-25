// telegram.mjs — fetches recent channel messages via the Telethon shim
// (telegram_fetch.py), then applies negative + noise-reply filters.
// Degrades cleanly to [] with an explicit status when not configured.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FETCH_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "telegram_fetch.py");

function runFetch(pythonBin, args) {
  return new Promise((resolve) => {
    const child = spawn(pythonBin, [FETCH_PY, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => resolve({ code: 1, out: "", err: "spawn failed" }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

export async function collect({ windowHours, sources, filters, metadata }) {
  const cfg = sources.telegram || {};
  const diag = { channels_scanned: 0, channels_with_activity: 0, items_kept: 0, status: "ok" };
  const channels = cfg.channels || [];

  if (!channels.length) {
    diag.status = "no_channels";
    return { items: [], diag };
  }
  if (!cfg.python_bin || !fs.existsSync(cfg.python_bin)) {
    diag.status = "venv_missing";
    return { items: [], diag };
  }
  if (!fs.existsSync(`${cfg.session_path}.session`)) {
    diag.status = "session_missing";
    return { items: [], diag };
  }

  diag.channels_scanned = channels.length;
  const args = [];
  for (const c of channels) args.push("--group", c.group);
  args.push("--hours", String(windowHours), "--timezone", "UTC", "--session", cfg.session_path);

  const { code, out } = await runFetch(cfg.python_bin, args);
  let rows;
  try {
    rows = JSON.parse(out);
  } catch {
    diag.status = code === 0 ? "bad_output" : "script_failed";
    return { items: [], diag };
  }
  if (!Array.isArray(rows)) {
    diag.status = "bad_output";
    return { items: [], diag };
  }

  diag.channels_with_activity = new Set(rows.map((r) => r.group_title || r.group_input)).size;
  const maxItems = cfg.max_items_per_run || 25;
  const items = [];

  for (const row of rows) {
    if (items.length >= maxItems) break;
    const text = row.message_text || "";
    if (!text) continue;
    if (!filters.passes(text)) continue;
    if (filters.isNoiseReply(text)) continue;

    const group = row.group_title || row.group_input || "unknown";
    const groupHandle = row.group_input || "";
    const url = groupHandle && row.message_id ? `https://t.me/${groupHandle}/${row.message_id}` : "";

    items.push({
      source: "telegram",
      subsource: `@${group}`,
      url,
      title: "",
      text,
      author: { handle: row.sender_username || row.sender_name || "unknown" },
      engagement: {},
      created_at: row.message_datetime_iso || "",
      metadata: metadata.extract(text),
    });
  }
  diag.items_kept = items.length;
  if (!items.length) diag.status = "no_activity";

  return { items, diag };
}
