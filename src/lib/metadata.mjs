// metadata.mjs — content-specificity enrichment, shared by collectors (at
// collection time) and the editorial engine (when it re-expands newsletter items).
// Build once from the tracked-entities config, then call extract(text, urls).

import { stripHtml, decodeHtml } from "./text.mjs";

export function buildMetadata(tracked = {}) {
  const trackedCompanies = Object.values(tracked.companies || {}).flat();
  const trackedProtocols = tracked.protocols || [];
  const trackedTechnicalMarkers = tracked.technical_markers || [];
  const trackedAnchorDomains = tracked.anchor_domains || [];
  const trackedEipNumbers = new Set((tracked.eip_numbers || []).map(Number));
  const eipPattern = tracked.eip_pattern ? new RegExp(tracked.eip_pattern, "gi") : /\b(?:ERC|EIP)-?(\d{4})\b/gi;

  function anchorKeyForUrl(value) {
    try {
      const url = new URL(value);
      return `${url.hostname.toLowerCase()}${url.pathname}`.replace(/\/+$/, "");
    } catch {
      return "";
    }
  }

  function anchorMatches(value) {
    const key = anchorKeyForUrl(value);
    if (!key) return false;
    return trackedAnchorDomains.some((anchor) => {
      const a = anchor
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
      return key === a || key.startsWith(`${a}/`);
    });
  }

  function extractTrackedEipNumbers(text = "") {
    const found = new Set();
    for (const match of text.matchAll(eipPattern)) {
      // The configured pattern captures the prefix (ERC|EIP) in group 1 and the
      // number in group 2; the default pattern captures the number in group 1.
      // Pick whichever capture group is numeric.
      const value = match
        .slice(1)
        .map(Number)
        .find((n) => Number.isFinite(n));
      if (Number.isFinite(value)) found.add(value);
    }
    return Array.from(found);
  }

  function extract(text = "", urls = []) {
    const normalizedText = stripHtml(decodeHtml(text));
    const lc = normalizedText.toLowerCase();
    const eipNumbers = extractTrackedEipNumbers(normalizedText);

    // Anchor links: from real URLs (preferred) plus any anchor domain mentioned in the text.
    const fromUrls = urls
      .filter((url) => anchorMatches(url))
      .map((url) => {
        try {
          return new URL(url).hostname.toLowerCase();
        } catch {
          return url;
        }
      });
    const fromText = trackedAnchorDomains.filter((d) => lc.includes(d.toLowerCase()));
    const anchor_domain_links = Array.from(new Set([...fromUrls, ...fromText]));

    return {
      has_eip_reference: eipNumbers.some((n) => trackedEipNumbers.has(n)),
      eip_numbers: eipNumbers.filter((n) => trackedEipNumbers.has(n)),
      has_code_block: /<pre|<code|```|0x[a-fA-F0-9]{40}|function [a-zA-Z]+\(/.test(text),
      anchor_domain_links,
      tracked_companies: trackedCompanies.filter((c) => lc.includes(c.toLowerCase())),
      tracked_protocols: trackedProtocols.filter((p) => lc.includes(p.toLowerCase())),
      technical_markers: trackedTechnicalMarkers.filter((m) => lc.includes(m.toLowerCase())),
    };
  }

  return { extract, trackedEipNumbers, anchorMatches };
}
