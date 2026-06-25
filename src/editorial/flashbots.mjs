// flashbots.mjs — the Flashbots MEV Newsletter RSS body bundles many links into
// one item; expand it into the individual signals it references.

import { stripHtml, decodeHtml, normalizeUrl } from "../lib/text.mjs";

function parseItems(html = "") {
  const entries = [];
  const tokenPattern = /(<[^>]+>)|([^<]+)/g;
  let currentSection = "";
  let inHeading = false;
  let headingBuffer = "";
  let ulDepth = 0;
  let liDepth = 0;
  let itemBuffer = "";
  let itemSection = "";

  for (const match of html.matchAll(tokenPattern)) {
    const raw = match[0];
    const tag = match[1];
    const text = match[2];

    if (tag) {
      const tagMatch = tag.match(/^<\/?\s*([a-zA-Z0-9]+)/);
      const tagName = tagMatch?.[1]?.toLowerCase() || "";
      const isClose = /^<\//.test(tag);

      if (tagName === "h1") {
        if (isClose) {
          inHeading = false;
          currentSection = stripHtml(headingBuffer);
        } else {
          inHeading = true;
          headingBuffer = "";
        }
      }
      if (tagName === "ul") ulDepth = isClose ? Math.max(0, ulDepth - 1) : ulDepth + 1;

      if (tagName === "li") {
        if (!isClose) {
          if (ulDepth === 1 && liDepth === 0) {
            itemBuffer = raw;
            itemSection = currentSection;
          }
          liDepth += 1;
          if (itemBuffer !== raw && itemBuffer) itemBuffer += raw;
        } else if (itemBuffer) {
          itemBuffer += raw;
        }
        if (isClose) {
          liDepth = Math.max(0, liDepth - 1);
          if (ulDepth === 1 && liDepth === 0 && itemBuffer) {
            entries.push({ section: itemSection, html: itemBuffer });
            itemBuffer = "";
            itemSection = "";
          }
        }
        continue;
      }

      if (inHeading && tagName !== "h1") headingBuffer += raw;
      if (itemBuffer) itemBuffer += raw;
      continue;
    }

    if (typeof text === "string") {
      if (inHeading) headingBuffer += text;
      if (itemBuffer) itemBuffer += text;
    }
  }
  return entries;
}

function chooseLink(section, itemHtml) {
  const topLevelHtml = itemHtml.replace(/<ul[\s\S]*?<\/ul>/gi, " ");
  const anchors = Array.from(topLevelHtml.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi))
    .map((match) => ({
      href: normalizeUrl(decodeHtml(match[1] || "")),
      label: stripHtml(decodeHtml(match[2] || "")),
    }))
    .filter((a) => a.href);

  const genericLabels = new Set(["post", "thread", "agenda", "notes", "note", "read full topic", "sign up here"]);
  const scored = anchors
    .map((anchor) => {
      const href = anchor.href.toLowerCase();
      const label = anchor.label.toLowerCase();
      let score = 0;
      if (/x\.com\/[^/]+\/status\//.test(href)) score += 8;
      if (/arxiv\.org|ethresear\.ch|eips\.ethereum\.org|github\.com|youtube\.com|youtu\.be|notes\.ethereum\.org|ethereum\.foundation|forum\.arbitrum\.foundation|ethpandaops\.io|ecdsa\.fail|fastconfirm\.it|etherworld\.co|vitalik\.eth\.limo/.test(href)) score += 5;
      if (/collective\.flashbots\.net\/u\//.test(href)) score -= 6;
      if (/x\.com\/[^/]+\/?$/.test(href)) score -= 5;
      if (/^https?:\/\/[^/]+\/?$/.test(href)) score -= 4;
      if (/collective\.flashbots\.net\/t\/the-mev-letter/i.test(href)) score -= 8;
      if (genericLabels.has(label)) score -= 5;
      if (/^@/.test(label)) score -= 4;
      if (label.length >= 12) score += 2;
      if (/papers? & articles/i.test(section) && /arxiv\.org|ethresear\.ch|eips\.ethereum\.org/.test(href)) score += 3;
      if (/talks? & discussions?/i.test(section) && /youtube\.com|youtu\.be/.test(href)) score += 3;
      if (/posts? & threads?/i.test(section) && /x\.com\/[^/]+\/status\//.test(href)) score += 4;
      return { ...anchor, score };
    })
    .sort((a, b) => b.score - a.score);

  return {
    anchor: scored[0] || null,
    urls: Array.from(new Set(anchors.map((a) => a.href))),
    summaryHtml: topLevelHtml,
  };
}

function summarizeItem(itemHtml) {
  const summary = stripHtml(decodeHtml(itemHtml.replace(/<ul[\s\S]*?<\/ul>/gi, " ")));
  return summary.length <= 420 ? summary : summary.slice(0, 417).trimEnd() + "...";
}

// Returns the expanded child items, or [item] if this is not the newsletter.
export function expandFlashbots(item, extractMetadata) {
  if (item.source !== "rss" || item.subsource !== "Flashbots MEV Newsletter") return [item];
  const parsedItems = parseItems(item.text || "");
  const expanded = [];

  for (const parsed of parsedItems) {
    const chosen = chooseLink(parsed.section, parsed.html);
    if (!chosen.anchor) continue;
    const summary = summarizeItem(parsed.html);
    const title =
      chosen.anchor.label && !/^(post|thread|agenda|notes?|read full topic)$/i.test(chosen.anchor.label)
        ? chosen.anchor.label
        : summary.slice(0, 120).trim();
    if (!title || !chosen.anchor.href) continue;

    expanded.push({
      ...item,
      url: chosen.anchor.href,
      title,
      text: summary,
      metadata: extractMetadata(summary, chosen.urls),
    });
  }
  return expanded.length ? expanded : [item];
}
