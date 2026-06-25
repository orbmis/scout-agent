// feed.mjs — dependency-free RSS 2.0 / Atom parser.
// Replaces the inline Python XML heredocs in the old rss-scan.sh / arxiv-scan.sh.
// Tolerant by design: feeds are messy. Returns [{title, url, text, categories, ts}].
// ts is epoch seconds (0 if unknown).

import { decodeHtml } from "./text.mjs";

function unwrapCdata(s = "") {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

// First inner text of <tag>...</tag> (namespace-insensitive on the local name).
function tagText(block, name) {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${name}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return decodeHtml(unwrapCdata(m[1]).trim());
}

function allTagText(block, name) {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${name}>`, "gi");
  const out = [];
  for (const m of block.matchAll(re)) {
    const t = decodeHtml(unwrapCdata(m[1]).trim());
    if (t) out.push(t);
  }
  return out;
}

// Atom <link href="..."/> — prefer rel="alternate" or no rel.
function atomLink(block) {
  const links = Array.from(block.matchAll(/<link\b([^>]*)\/?>/gi)).map((m) => m[1]);
  const parse = (attrs) => {
    const href = attrs.match(/href="([^"]+)"/i)?.[1];
    const rel = attrs.match(/rel="([^"]+)"/i)?.[1] || "alternate";
    return href ? { href: decodeHtml(href), rel } : null;
  };
  const parsed = links.map(parse).filter(Boolean);
  const alt = parsed.find((l) => l.rel === "alternate") || parsed[0];
  return alt ? alt.href : "";
}

function toTs(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function blocks(xml, tag) {
  const re = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi");
  return xml.match(re) || [];
}

export function parseFeed(xml = "") {
  const items = [];

  // RSS 2.0 <item>
  for (const block of blocks(xml, "item")) {
    items.push({
      title: tagText(block, "title"),
      url: tagText(block, "link"),
      text: tagText(block, "description") || tagText(block, "encoded"),
      categories: allTagText(block, "category"),
      ts: toTs(tagText(block, "pubDate") || tagText(block, "date")),
    });
  }

  // Atom <entry>
  for (const block of blocks(xml, "entry")) {
    const link = atomLink(block) || tagText(block, "link") || tagText(block, "id");
    items.push({
      title: tagText(block, "title"),
      url: link,
      text: tagText(block, "summary") || tagText(block, "content"),
      categories: allTagText(block, "category"),
      ts: toTs(tagText(block, "published") || tagText(block, "updated") || tagText(block, "date")),
    });
  }

  return items;
}
