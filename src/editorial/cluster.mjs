// cluster.mjs — source-to-tier mapping, intra-day topic clustering keys, and
// cross-day dedup against the previous 14 days of signal files.

import fs from "node:fs";
import path from "node:path";
import { textFor, lowerText, similarity, parseTimeMs } from "../lib/text.mjs";

export function assignTier(item) {
  const { source, group, tag } = item;
  const author = item.author || {};
  const engagement = item.engagement || {};
  if (source === "rss" && (group === "research_outputs" || group === "core_protocol" || group === "forums" || group === "company_blogs" || tag === "newsletter")) return 0;
  if (source === "github" || source === "arxiv") return 0;
  if (author.is_seed_author) return 1;
  if ((engagement.seed_engaged_by || []).length > 0) return 2;
  return 3;
}

function inferTopicBuckets(item) {
  const text = lowerText(item);
  const buckets = [];
  if (/\bbase\b/.test(text) && /agent|wallet|payment|payments|stablecoin|x402|agentkit/.test(text)) buckets.push("base-agent-stack");
  if (/x402|http 402|payment required|agent payments?|stablecoin/.test(text)) buckets.push("agent-payments");
  if (/attestation|identity|registry|agentic actions/.test(text)) buckets.push("identity-registry");
  if (/virtuals|agent swarms|launchpads/.test(text)) buckets.push("agent-launchpads");
  const eips = Array.from(text.matchAll(/(?:eip|erc)[- ]?(\d{4})/g)).map((m) => m[1]);
  for (const eip of eips) buckets.push(`eip:${eip}`);
  return Array.from(new Set(buckets));
}

export function threadClusterKey(item) {
  if (item.source !== "x-seed") return null;
  const handle = item.author?.handle;
  const createdAtMs = parseTimeMs(item.created_at);
  if (!handle || createdAtMs === null) return null;
  const buckets = inferTopicBuckets(item);
  const slot = Math.floor(createdAtMs / (10 * 60 * 1000));
  const keys = [`${handle}|${slot}|burst`];
  for (const bucket of buckets) keys.push(`${handle}|${slot}|${bucket}`);
  return Array.from(new Set(keys));
}

// The intra-day topic key used to collapse same-development items within one run.
export function topicKeyFor(item) {
  const text = lowerText(item);
  const isPrimarySource = item.source === "rss" || item.source === "github" || item.source === "arxiv";
  if (isPrimarySource) return item.url;
  const parts = [];
  const matchedEips = Array.from(text.matchAll(/(?:eip|erc)[- ]?(4337|7702|7579|7710|7715|7521|7683|8211|7928|8264|8253|7773)/g)).map((m) => m[1]);
  if (matchedEips.length) parts.push(`eip:${matchedEips[0]}`);
  if (/catena labs/i.test(text)) parts.push("catena-labs");
  if (/taskmarket/i.test(text)) parts.push("taskmarket");
  if (/proof of human|identity/i.test(text)) parts.push("identity");
  if (/stablecoin|payments?|merchant|remittance/i.test(text)) parts.push("payments");
  if (!parts.length) parts.push(item.url);
  return parts.join("|");
}

export function loadPreviousEntries(files) {
  const entries = [];
  for (const file of files || []) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    entries.push({ file, content, lower: content.toLowerCase() });
  }
  return entries;
}

export function dedupAgainstPrevious(item, previousEntries) {
  const text = textFor(item);
  const title = item.title || "";
  const eips = new Set([
    ...((item.metadata?.eip_numbers) || []).map(String),
    ...Array.from((title + " " + text).matchAll(/(?:eip|erc)[- ]?(4337|7702|7579|7710|7715|7521|7683|8211|7928|8264|8253|7773)/gi)).map((m) => m[1]),
  ]);
  for (const prev of previousEntries) {
    if (prev.content.includes(item.url)) {
      return { exclusionClass: "topic_dedup", reason: `A previous signal file already covered this exact source URL (${path.basename(prev.file)}).` };
    }
    if (title && prev.lower.includes(title.toLowerCase())) {
      return { exclusionClass: "topic_dedup", reason: `A previous signal file already covered the same titled development (${path.basename(prev.file)}).` };
    }
    for (const eip of eips) {
      if (prev.lower.includes(`eip-${eip}`) || prev.lower.includes(`erc-${eip}`)) {
        if (similarity(text, prev.content) > 0.45) {
          return { exclusionClass: "topic_dedup", reason: `A recent signal file already covered the same EIP thread without materially new detail (${path.basename(prev.file)}).` };
        }
      }
    }
  }
  return null;
}
