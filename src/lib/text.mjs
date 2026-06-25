// text.mjs — small, pure text helpers shared by collectors and the editorial engine.

export function decodeHtml(input = "") {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

export function stripHtml(input = "") {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\b\d+ post - \d+ participant\b/gi, " ")
    .replace(/\bRead full topic\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function textFor(item) {
  return [item.title || "", stripHtml(item.text || "")].filter(Boolean).join(" ").trim();
}

export function lowerText(item) {
  return textFor(item).toLowerCase();
}

export function hasAnyKeyword(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function tokenize(text) {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 4)
    )
  );
}

export function similarity(a, b) {
  const aa = new Set(tokenize(a));
  const bb = new Set(tokenize(b));
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const token of aa) if (bb.has(token)) overlap += 1;
  return overlap / Math.min(aa.size, bb.size);
}

export function parseTimeMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    return value || "";
  }
}

// UTC date string YYYY-MM-DD for a Date (default now).
export function utcDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
