#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const manifestPath = process.argv[2];

if (!manifestPath) {
  console.error("usage: node scripts/process-scout-manifest.mjs /tmp/scout/manifest-YYYY-MM-DD.json");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const workspaceRoot = "/home/clawdbot/.openclaw/workspace-saorin-scout";
const userMd = fs.readFileSync(path.join(workspaceRoot, "USER.md"), "utf8");
const trackedEntities = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, "skills/scout-signal-scan/config/tracked-entities.json"), "utf8")
);
const stateDir = path.join(process.env.HOME || "/home/clawdbot", ".local/share/scout");
const tier3AuthorsPath = path.join(stateDir, "tier3-authors.jsonl");
const signalDate = manifest.date_utc;
const signalsDir = manifest.signals_dir || "/home/clawdbot/obsidian-vault/Signals";
const dailyPath = path.join(signalsDir, `${signalDate}.md`);
const filteredPath = path.join(signalsDir, `${signalDate}_filtered.md`);
const risingAuthorsPath = path.join(signalsDir, `rising-authors-${signalDate}.md`);
const markerPath = `/tmp/scout/ready-${signalDate}.marker`;
const collectionDeduped = Array.isArray(manifest.collection_filtered?.url_dedup)
  ? manifest.collection_filtered.url_dedup
  : [];

fs.mkdirSync(signalsDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

const trackedCompanies = Object.values(trackedEntities.companies || {}).flat();
const trackedProtocols = trackedEntities.protocols || [];
const trackedTechnicalMarkers = trackedEntities.technical_markers || [];
const trackedAnchorDomains = trackedEntities.anchor_domains || [];
const trackedEipNumbers = new Set((trackedEntities.eip_numbers || []).map(Number));
const eipReferencePattern = trackedEntities.eip_pattern ? new RegExp(trackedEntities.eip_pattern, "gi") : /\b(?:ERC|EIP)-?(\d{4})\b/gi;

function stripHtml(input = "") {
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

function decodeHtml(input = "") {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function textFor(item) {
  return [item.title || "", stripHtml(item.text || "")]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function lowerText(item) {
  return textFor(item).toLowerCase();
}

function hasAnyKeyword(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function tokenize(text) {
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

function similarity(a, b) {
  const aa = new Set(tokenize(a));
  const bb = new Set(tokenize(b));
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const token of aa) {
    if (bb.has(token)) overlap += 1;
  }
  return overlap / Math.min(aa.size, bb.size);
}

function parseTimeMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function parseDiscourseThreadStats(text = "") {
  const match = text.match(/(\d+)\s+posts?\s+-\s+(\d+)\s+participants?/i);
  if (!match) return null;
  return {
    posts: Number(match[1]),
    participants: Number(match[2]),
  };
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    return value || "";
  }
}

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
    const normalizedAnchor = anchor.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return key === normalizedAnchor || key.startsWith(`${normalizedAnchor}/`);
  });
}

function extractTrackedEipNumbers(text = "") {
  const found = new Set();
  for (const match of text.matchAll(eipReferencePattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) found.add(value);
  }
  return Array.from(found);
}

function extractMetadata(text = "", urls = []) {
  const normalizedText = stripHtml(decodeHtml(text));
  const lc = normalizedText.toLowerCase();
  const eipNumbers = extractTrackedEipNumbers(normalizedText);
  const anchorDomainLinks = Array.from(new Set(urls.filter((url) => anchorMatches(url)).map((url) => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return url;
    }
  })));
  const tracked_companies = trackedCompanies.filter((company) => lc.includes(company.toLowerCase()));
  const tracked_protocols = trackedProtocols.filter((protocol) => lc.includes(protocol.toLowerCase()));
  const technical_markers = trackedTechnicalMarkers.filter((marker) => lc.includes(marker.toLowerCase()));

  return {
    has_eip_reference: eipNumbers.some((n) => trackedEipNumbers.has(n)),
    eip_numbers: eipNumbers.filter((n) => trackedEipNumbers.has(n)),
    has_code_block: /<pre|<code|\`\`\`/.test(text),
    anchor_domain_links: anchorDomainLinks,
    tracked_companies,
    tracked_protocols,
    technical_markers,
  };
}

function parseFlashbotsNewsletterItems(html = "") {
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

      if (tagName === "ul") {
        ulDepth = isClose ? Math.max(0, ulDepth - 1) : ulDepth + 1;
      }

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

function chooseFlashbotsNewsletterLink(section, itemHtml) {
  const topLevelHtml = itemHtml.replace(/<ul[\s\S]*?<\/ul>/gi, " ");
  const anchors = Array.from(topLevelHtml.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi))
    .map((match) => ({
      href: normalizeUrl(decodeHtml(match[1] || "")),
      label: stripHtml(decodeHtml(match[2] || "")),
    }))
    .filter((anchor) => anchor.href);

  const genericLabels = new Set(["post", "thread", "agenda", "notes", "note", "read full topic", "sign up here"]);
  const scored = anchors.map((anchor) => {
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
  }).sort((a, b) => b.score - a.score);

  return {
    anchor: scored[0] || null,
    urls: Array.from(new Set(anchors.map((anchor) => anchor.href))),
    summaryHtml: topLevelHtml,
  };
}

function summarizeFlashbotsNewsletterItem(itemHtml) {
  const summary = stripHtml(
    decodeHtml(
      itemHtml
        .replace(/<ul[\s\S]*?<\/ul>/gi, " ")
    )
  );
  return summary.length <= 420 ? summary : summary.slice(0, 417).trimEnd() + "...";
}

function expandFlashbotsNewsletterItem(item) {
  if (item.source !== "rss" || item.subsource !== "Flashbots MEV Newsletter") return [item];
  const parsedItems = parseFlashbotsNewsletterItems(item.text || "");
  const expanded = [];

  for (const parsed of parsedItems) {
    const chosen = chooseFlashbotsNewsletterLink(parsed.section, parsed.html);
    if (!chosen.anchor) continue;
    const summary = summarizeFlashbotsNewsletterItem(parsed.html);
    const title = chosen.anchor.label && !/^(post|thread|agenda|notes?|read full topic)$/i.test(chosen.anchor.label)
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

const expandedManifestItems = manifest.items.flatMap((item) => expandFlashbotsNewsletterItem(item));

const trackedTopicPatterns = [
  /agentic commerce/i,
  /agent wallet/i,
  /account abstraction/i,
  /smart account/i,
  /session key/i,
  /delegat/i,
  /intent/i,
  /solver/i,
  /stablecoin/i,
  /payment/i,
  /payments/i,
  /commerce/i,
  /attestation/i,
  /identity/i,
  /reputation/i,
  /x402/i,
  /l402/i,
  /acp/i,
  /ap2/i,
  /agent pay/i,
  /visa tap/i,
  /4337/i,
  /7702/i,
  /7579/i,
  /7710/i,
  /7715/i,
  /7521/i,
  /7683/i,
  /8211/i,
  /erc-4337/i,
  /erc-7702/i,
  /erc-7579/i,
  /erc-7710/i,
  /erc-7715/i,
  /erc-7521/i,
  /erc-7683/i,
  /erc-8211/i,
  /eip-4337/i,
  /eip-7702/i,
  /eip-7579/i,
  /eip-7710/i,
  /eip-7715/i,
  /eip-7521/i,
  /eip-7683/i,
  /eip-8211/i,
  /ai agent/i,
  /agents can/i,
  /machine[- ]to[- ]machine/i,
  /programmable/i
];

const thinPatterns = [
  /^rt @/i,
  /giveaway/i,
  /good morning/i,
  /happy thursday/i,
  /fill the wick/i,
  /after party/i,
  /be there/i,
  /join us/i,
  /live-stream tomorrow/i,
  /who should i bring/i,
  /yield agent/i,
  /shilling/i,
  /early crypto project/i
];

const connectTopics = [
  {
    label: "layered architecture of Ethereum account abstraction standards",
    patterns: [/4337/i, /7702/i, /7579/i, /7710/i, /7715/i, /7521/i, /7683/i, /8211/i, /account abstraction/i, /smart account/i, /delegat/i, /nonce/i]
  },
  {
    label: "agent wallet infrastructure stack: six-layer map covering full-stack platforms, signing infrastructure, identity and trust, card issuance, protocol and rail layer, adjacent players",
    patterns: [/agent wallet/i, /wallet/i, /sign/i, /identity/i, /attestation/i, /trust/i, /rails/i, /payment/i, /payments/i, /stablecoin/i, /card/i]
  },
  {
    label: "card vs stablecoin rails for agentic commerce; friction-per-autonomous-decision as the unifying frame",
    patterns: [/stablecoin/i, /card/i, /merchant/i, /payments/i, /payment/i, /commerce/i, /remittance/i]
  },
  {
    label: "verification gating versus settlement determination as separable concerns in agent payment design",
    patterns: [/proof of human/i, /identity/i, /attestation/i, /verified/i, /gating/i, /settlement/i, /payments/i]
  },
  {
    label: "intersection of account abstraction, agent wallets, and agentic payments",
    patterns: [/account abstraction/i, /smart account/i, /agent/i, /wallet/i, /payment/i, /stablecoin/i]
  },
  {
    label: "The agent wallet stack will consolidate around ERC-4337 plus ERC-7702 plus a delegation standard from the 7710/7715 family",
    patterns: [/4337/i, /7702/i, /7710/i, /7715/i, /delegat/i]
  },
  {
    label: "Agent identity and attestation will be a load-bearing primitive in agentic commerce, not an afterthought layered on later",
    patterns: [/identity/i, /attestation/i, /proof of human/i, /verified/i, /memory access rights/i]
  },
  {
    label: "Card rails will lose share to native crypto rails as agents take over, not because crypto is cheaper but because per-decision authorisation favours programmable rails",
    patterns: [/stablecoin/i, /payments/i, /remittance/i, /programmable/i, /merchant/i]
  }
];

function describeConnect(item) {
  const text = textFor(item);
  const lc = text.toLowerCase();
  for (const topic of connectTopics) {
    if (topic.patterns.some((pattern) => pattern.test(lc))) {
      if (/memory access rights/i.test(lc)) {
        return `Connects to ${topic.label}: It is a direct example of agent memory and permissions being specified as a distinct rights layer rather than folded implicitly into wallet control.`;
      }
      if (/7702/i.test(lc) && /gas/i.test(lc)) {
        return `Connects to ${topic.label}: It adds operational detail to the 7702 execution path, which matters for how delegation-style flows fail and recover in practice.`;
      }
      if (/proof of human|verified/i.test(lc)) {
        return `Connects to ${topic.label}: It is a concrete example of verification controls being discussed separately from payment or execution rails.`;
      }
      if (/stablecoin|payments?|merchant|remittance/i.test(lc)) {
        return `Connects to ${topic.label}: It gives a live example of builders framing programmable rails, rather than cards, as the control surface for software-driven payments.`;
      }
      if (/identity|attestation/i.test(lc)) {
        return `Connects to ${topic.label}: It reinforces that identity and attestation are being treated as first-order infrastructure, not as an application-layer add-on.`;
      }
      return `Connects to ${topic.label}: It supplies a concrete example that sharpens this framing with a current implementation or standards signal.`;
    }
  }
  return null;
}

function scoreItem(item) {
  const author = item.author || {};
  const engagement = item.engagement || {};
  const metadata = item.metadata || {};
  const text = textFor(item);
  const lc = text.toLowerCase();
  const title = item.title || "";
  const discourseStats = parseDiscourseThreadStats(item.text || "");

  const axisScores = {
    content: 0,
    author: 0,
    engagement: 0,
    negative: 0,
  };

  if ((metadata.anchor_domain_links || []).length > 0) axisScores.content += 3;
  if (metadata.has_eip_reference) axisScores.content += 3;
  if ((metadata.tracked_protocols || []).length > 0) axisScores.content += 2;
  if ((metadata.tracked_companies || []).length > 0) axisScores.content += 1;
  if ((metadata.technical_markers || []).length > 0) axisScores.content += Math.min(2, metadata.technical_markers.length);
  if (metadata.has_code_block) axisScores.content += 1;
  if (item.source === "github") axisScores.content += 2;
  if (item.source === "rss" && item.group !== "newsletters") axisScores.content += 1;
  if (item.source === "rss" && item.tag === "newsletter") axisScores.content += 0.5;
  if (hasAnyKeyword(text, trackedTopicPatterns)) axisScores.content += 2;
  if (/erc-|eip-|ai agent memory access rights|stablecoins? are the future of money|agents can safely use money/i.test(text)) {
    axisScores.content += 1;
  }

  if (author.is_seed_author) axisScores.author += 2;
  if ((author.account_age_days || 0) > 365) axisScores.author += 1;
  if ((author.account_age_days || 0) > 1825) axisScores.author += 0.5;
  if ((author.followers || 0) > 10000 && hasAnyKeyword((author.bio || "").toLowerCase(), trackedTopicPatterns)) {
    axisScores.author += 0.5;
  }

  const totalEngagement = (engagement.likes || 0) + (engagement.reposts || 0) + (engagement.replies || 0) + (engagement.quotes || 0);
  if ((engagement.seed_engaged_by || []).length > 0) axisScores.engagement += 3;
  if ((engagement.quotes || 0) >= 3) axisScores.engagement += 1;
  if ((engagement.reposts || 0) >= 10) axisScores.engagement += 0.5;
  if (totalEngagement >= 100) axisScores.engagement += 0.5;

  if (thinPatterns.some((pattern) => pattern.test(lc))) axisScores.negative -= 3;
  if (/^rt @/i.test(lc)) axisScores.negative -= 1.5;
  if (text.length < 80) axisScores.negative -= 1.5;
  if (/^rt @/i.test(lc) && (metadata.anchor_domain_links || []).length === 0 && (metadata.tracked_protocols || []).length === 0 && (metadata.tracked_companies || []).length === 0) {
    axisScores.negative -= 1.5;
  }
  if (/https:\/\/t\.co\//i.test(text) && (metadata.anchor_domain_links || []).length === 0 && !hasAnyKeyword(text, trackedTopicPatterns)) {
    axisScores.negative -= 1;
  }
  if (/photo\/1/i.test((item.expanded_urls || []).join(" "))) axisScores.negative -= 0.5;
  if (/giveaway|after party|good morning|happy thursday|fill the wick/i.test(lc)) axisScores.negative -= 2;
  if (/rt @/i.test(lc) && !hasAnyKeyword(text, trackedTopicPatterns)) axisScores.negative -= 1;
  if (/on june \d+|be there|we will be joined|live-stream tomorrow/i.test(lc)) axisScores.negative -= 2;
  if (/openai model has disproved|education for countries|accelerate code review with codex/i.test(lc)) axisScores.negative -= 3;
  if (/hyperliquid etf|tradfi liquidity/i.test(lc)) axisScores.negative -= 4;
  if (/post-quantum|pq interop/i.test(lc)) axisScores.negative -= 2;
  if (/topic deleted by author|1 post - 1 participant/i.test(lc)) axisScores.negative -= 5;

  let topical = 0;
  if (hasAnyKeyword(text, trackedTopicPatterns)) topical += 2;
  if ((metadata.anchor_domain_links || []).length > 0) topical += 1;
  if ((metadata.eip_numbers || []).some((n) => [4337, 7702, 7579, 7710, 7715, 7521, 7683, 8211].includes(n))) topical += 2;
  if (/7702|4337|7710|7715|smart account|agent|stablecoin|payment|payments|identity|attestation|wallet/i.test(title + " " + text)) topical += 1;

  const rawScore = axisScores.content + axisScores.author + axisScores.engagement + axisScores.negative + topical;
  const strongContentSpecificityCount = [
    !!metadata.has_eip_reference,
    (metadata.tracked_protocols || []).length > 0,
    (metadata.tracked_companies || []).length > 0,
    (metadata.technical_markers || []).length > 0,
    !!metadata.has_code_block,
  ].filter(Boolean).length;
  const hasRequiredAnchorSignal =
    item.source === "github" ||
    item.source === "arxiv" ||
    (item.source === "rss" && ["research_outputs", "core_protocol", "forums", "company_blogs"].includes(item.group || "")) ||
    (metadata.anchor_domain_links || []).length > 0 ||
    (engagement.seed_engaged_by || []).length > 0 ||
    !!author.is_seed_author ||
    strongContentSpecificityCount >= 2;

  const sourceThreshold = item.source === "github" || item.source === "rss" ? 4 : 5;
  const score = Math.max(0, rawScore);
  const passesScore = score >= sourceThreshold && topical >= 2;

  const dominantAxis = Object.entries(axisScores)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "content";
  const dominantAxisLabel = dominantAxis === "author" ? "author shape" : dominantAxis === "engagement" ? "network engagement" : dominantAxis === "negative" ? "negative markers" : "content specificity";
  const composite = score >= 8 ? "strong" : score >= 5 ? "moderate" : "weak";

  let exclusionClass = null;
  let reason = null;
  if (
    item.source === "rss" &&
    item.subsource === "Ethereum Magicians" &&
    discourseStats &&
    discourseStats.posts <= 1
  ) {
    exclusionClass = "below_threshold";
    reason = "The Ethereum Magicians topic only has the original post and no replies yet.";
  } else if (!hasRequiredAnchorSignal) {
    exclusionClass = "missing_anchor_signal";
    reason = "It never picked up a required anchor signal and the underlying content is too thin to stand alone.";
  } else if (!passesScore) {
    exclusionClass = "below_threshold";
    reason = "It has too little topic-specific substance relative to the volume of generic or promotional language.";
  }

  if (item.source === "rss" && item.group === "newsletters" && !hasAnyKeyword(text, trackedTopicPatterns)) {
    exclusionClass = "below_threshold";
    reason = "The newsletter item is not meaningfully about Scout's tracked themes today.";
  }

  return {
    score,
    composite,
    dominantAxis: dominantAxisLabel,
    passesScore,
    hasRequiredAnchorSignal,
    strongContentSpecificityCount,
    exclusionClass,
    reason,
    summaryText: text,
  };
}

function inferTopicBuckets(item) {
  const text = lowerText(item);
  const buckets = [];
  if (/\bbase\b/.test(text) && /agent|wallet|payment|payments|stablecoin|x402|agentkit/.test(text)) {
    buckets.push("base-agent-stack");
  }
  if (/x402|http 402|payment required|agent payments?|stablecoin/.test(text)) {
    buckets.push("agent-payments");
  }
  if (/attestation|identity|registry|agentic actions/.test(text)) {
    buckets.push("identity-registry");
  }
  if (/virtuals|agent swarms|launchpads/.test(text)) {
    buckets.push("agent-launchpads");
  }
  const eips = Array.from(text.matchAll(/(?:eip|erc)[- ]?(\d{4})/g)).map((m) => m[1]);
  for (const eip of eips) buckets.push(`eip:${eip}`);
  return Array.from(new Set(buckets));
}

function threadClusterKey(item) {
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

function assignTier(item) {
  const source = item.source;
  const group = item.group;
  const tag = item.tag;
  const author = item.author || {};
  const engagement = item.engagement || {};
  if (source === "rss" && (group === "research_outputs" || group === "core_protocol" || group === "forums" || group === "company_blogs" || tag === "newsletter")) return 0;
  if (source === "github" || source === "arxiv") return 0;
  if (author.is_seed_author) return 1;
  if ((engagement.seed_engaged_by || []).length > 0) return 2;
  return 3;
}

function summarize(item) {
  const text = stripHtml(item.text || "");
  if (item.source === "github") {
    return text.replace(/\s+/g, " ").trim().replace(/ - modified:.*$/i, "").replace(/ - added:.*$/i, "");
  }
  if (text.length <= 220) return text;
  return text.slice(0, 217).trimEnd() + "...";
}

function whyMatter(item) {
  const text = textFor(item);
  const lc = text.toLowerCase();
  if (/memory access rights/i.test(lc)) {
    return "It proposes a rights model for what an AI agent may retain and access over time, which is a concrete control-layer question adjacent to wallet authority.";
  }
  if (/7702/i.test(lc) && /gas/i.test(lc)) {
    return "It sharpens a concrete edge case in 7702 execution, which matters for how delegated transaction flows behave under failure conditions.";
  }
  if (/stablecoins? are the future of money|stablecoin|remittance|merchant/i.test(lc)) {
    return "It is a direct rails-and-payments signal relevant to how programmable settlement is being framed against incumbent payment infrastructure.";
  }
  if (/proof of human|identity/i.test(lc)) {
    return "It is a concrete example of identity and verification infrastructure being treated as a control surface for agent or wallet behavior.";
  }
  if (/taskmarket|agents can safely use money|intelligent agents|ai agents can act, transact, and automate/i.test(lc)) {
    return "It reflects live product or market framing around agent execution, payment controls, or agent-native infrastructure rather than generic AI commentary.";
  }
  return "It adds a concrete standards, infrastructure, or market datapoint inside Scout's tracked themes.";
}

function formatAuthor(item) {
  const author = item.author || {};
  if (author.handle) {
    const age = author.account_age_days ? ` · account age ${author.account_age_days} days` : "";
    if (item.source === "rss" || item.source === "github" || item.source === "arxiv") {
      return `${author.display_name || author.handle}${age}`;
    }
    return `@${author.handle}${age}`;
  }
  return author.display_name || item.subsource || "Unknown";
}

function formatSource(item, tier) {
  if (item.source === "x-seed") return `X seed / Tier ${tier}`;
  if (item.source === "rss") return `RSS / Tier ${tier} / ${item.subsource}`;
  if (item.source === "github") return `GitHub / Tier ${tier} / ${item.subsource}`;
  if (item.source === "reddit") return `Reddit / Tier ${tier} / ${item.subsource}`;
  if (item.source === "telegram") return `Telegram / Tier ${tier} / ${item.subsource}`;
  return `${item.source} / Tier ${tier}`;
}

function titleFor(item) {
  if (item.title) return item.title;
  const text = stripHtml(item.text || "");
  if (item.author?.handle) {
    return `@${item.author.handle} — ${text.slice(0, 80).trim()}${text.length > 80 ? "..." : ""}`;
  }
  return text.slice(0, 90).trim() || item.url;
}

function loadPreviousEntries(files) {
  const entries = [];
  for (const file of files || []) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    entries.push({ file, content, lower: content.toLowerCase() });
  }
  return entries;
}

const previousEntries = loadPreviousEntries(manifest.previous_signals_files);

function dedupAgainstPrevious(item) {
  const text = textFor(item);
  const title = item.title || "";
  const eips = new Set([
    ...((item.metadata?.eip_numbers) || []).map(String),
    ...Array.from((title + " " + text).matchAll(/(?:eip|erc)[- ]?(4337|7702|7579|7710|7715|7521|7683|8211|7928|8264|8253|7773)/gi)).map((m) => m[1])
  ]);
  for (const prev of previousEntries) {
    if (prev.content.includes(item.url)) {
      return {
        exclusionClass: "topic_dedup",
        reason: `A previous signal file already covered this exact source URL (${path.basename(prev.file)}).`
      };
    }
    if (title && prev.lower.includes(title.toLowerCase())) {
      return {
        exclusionClass: "topic_dedup",
        reason: `A previous signal file already covered the same titled development (${path.basename(prev.file)}).`
      };
    }
    for (const eip of eips) {
      if (prev.lower.includes(`eip-${eip}`) || prev.lower.includes(`erc-${eip}`)) {
        if (similarity(text, prev.content) > 0.45) {
          return {
            exclusionClass: "topic_dedup",
            reason: `A recent signal file already covered the same EIP thread without materially new detail (${path.basename(prev.file)}).`
          };
        }
      }
    }
  }
  return null;
}

const kept = [];
const filtered = [];
const intraDayClusters = new Map();

for (const item of expandedManifestItems) {
  const score = scoreItem(item);
  if (score.exclusionClass) {
    filtered.push({ item, ...score, exclusionClass: score.exclusionClass, reason: score.reason });
    continue;
  }
  const tier = assignTier(item);
  const topicKeyParts = [];
  const text = lowerText(item);
  const isPrimarySource = item.source === "rss" || item.source === "github" || item.source === "arxiv";
  if (isPrimarySource) {
    topicKeyParts.push(item.url);
  } else {
    const matchedEips = Array.from((text.matchAll(/(?:eip|erc)[- ]?(4337|7702|7579|7710|7715|7521|7683|8211|7928|8264|8253|7773)/g))).map((m) => m[1]);
    if (matchedEips.length) topicKeyParts.push(`eip:${matchedEips[0]}`);
    if (/catena labs/i.test(text)) topicKeyParts.push("catena-labs");
    if (/taskmarket/i.test(text)) topicKeyParts.push("taskmarket");
    if (/proof of human|identity/i.test(text)) topicKeyParts.push("identity");
    if (/stablecoin|payments?|merchant|remittance/i.test(text)) topicKeyParts.push("payments");
    if (!topicKeyParts.length) topicKeyParts.push(item.url);
  }
  const topicKey = topicKeyParts.join("|");
  const clusterKeys = [topicKey, ...(threadClusterKey(item) || [])];
  const existing = clusterKeys
    .map((key) => intraDayClusters.get(key))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)[0];
  if (existing && existing.score >= score.score) {
    filtered.push({
      item,
      ...score,
      exclusionClass: "collapsed_to_cluster",
      reason: `Another kept item covered the same development more directly (${titleFor(existing.item)}).`
    });
    continue;
  }
  if (existing) {
    filtered.push({
      item: existing.item,
      ...existing.scoreMeta,
      exclusionClass: "collapsed_to_cluster",
      reason: `Another kept item covered the same development more directly (${titleFor(item)}).`
    });
    kept.splice(existing.keptIndex, 1);
  }
  const prior = dedupAgainstPrevious(item);
  if (prior) {
    filtered.push({ item, ...score, exclusionClass: prior.exclusionClass, reason: prior.reason });
    continue;
  }
  const scoreMeta = {
    ...score,
    tier,
    summary: summarize(item),
    why: whyMatter(item),
    connect: describeConnect(item),
  };
  for (const key of clusterKeys) {
    intraDayClusters.set(key, { item, score: score.score, scoreMeta, keptIndex: kept.length });
  }
  kept.push({ item, ...scoreMeta });
}

kept.sort((a, b) => a.tier - b.tier || b.score - a.score || (a.item.created_at || "").localeCompare(b.item.created_at || ""));
filtered.sort((a, b) => {
  const order = { below_threshold: 0, missing_anchor_signal: 1, topic_dedup: 2, collapsed_to_cluster: 3 };
  return (order[a.exclusionClass] ?? 9) - (order[b.exclusionClass] ?? 9);
});

const tiers = new Map([
  [0, []],
  [1, []],
  [2, []],
  [3, []],
]);
for (const entry of kept) tiers.get(entry.tier).push(entry);

function renderEntry(entry) {
  const { item } = entry;
  const engagement = item.engagement || {};
  const engagementParts = [];
  if ((engagement.seed_engaged_by || []).length > 0) engagementParts.push(`seed engaged by ${engagement.seed_engaged_by.join(", ")}`);
  if ((engagement.likes || 0) + (engagement.reposts || 0) + (engagement.replies || 0) + (engagement.quotes || 0) > 0) {
    engagementParts.push(`${engagement.likes || 0} likes, ${engagement.reposts || 0} reposts, ${engagement.replies || 0} replies, ${engagement.quotes || 0} quotes`);
  }
  const lines = [
    `### ${titleFor(item)}`,
    `- **Source:** ${formatSource(item, entry.tier)}`,
    `- **Author:** ${formatAuthor(item)}`,
    `- **Link:** ${item.url}`,
  ];
  if (engagementParts.length > 0) lines.push(`- **Engagement:** ${engagementParts.join("; ")}`);
  lines.push(`- **Summary:** ${entry.summary}`);
  lines.push(`- **Why it may matter:** ${entry.why}`);
  lines.push(`- **Composite score:** ${entry.composite}`);
  lines.push(`- **Dominant axis:** ${entry.dominantAxis}`);
  if (item.created_at) lines.push(`- **Captured timestamp:** ${item.created_at}`);
  if (entry.connect) lines.push(`- **${entry.connect}**`);
  return lines.join("\n");
}

function renderTier(tierNumber, heading, emptyLine) {
  const entries = tiers.get(tierNumber) || [];
  const lines = [`## ${heading}`, ""];
  if (!entries.length) {
    lines.push(emptyLine);
    lines.push("");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(renderEntry(entry));
    lines.push("");
  }
  return lines.join("\n");
}

const diag = manifest.collection_diagnostics || {};
const dailyLines = [
  `# Signals — ${signalDate}`,
  "",
  "## Daily social scan",
  `- **Captured (UTC):** ${manifest.captured_at}`,
  `- **Manifest:** \`${manifestPath}\``,
  `- **Scan windows:** X seed ${manifest.window_hours?.x_seed ?? 24}h · RSS ${manifest.window_hours?.rss ?? 48}h · GitHub ${manifest.window_hours?.github ?? 24}h · arXiv ${manifest.window_hours?.arxiv ?? 48}h`,
  "",
  renderTier(0, "Tier 0 — Primary Source", `No Tier 0 items were surfaced. RSS kept ${diag.rss?.items_kept ?? 0} items and GitHub kept ${diag.github?.items_kept ?? 0}, but none cleared the editorial threshold after scoring.`),
  renderTier(1, "Tier 1 — Seed-Set Signal", `No Tier 1 items were surfaced. X seed kept ${diag.x_seed?.items_kept ?? 0} items, but none cleared threshold after substance checks.`),
  renderTier(2, "Tier 2 — Seed-Adjacent Signal", `No seed-adjacent items were surfaced. Collection kept ${diag.x_seed?.items_kept ?? 0} X seed items, but no non-seed author in today's manifest carried usable seed-engagement context.`),
  renderTier(3, "Tier 3 — Independent Signal", `No independent candidates cleared into the final note. Today's manifest included ${diag.arxiv?.items_kept ?? 0} arXiv items and ${diag.telegram?.items_kept ?? 0} Telegram items after collection-time filtering.`),
  "## Collection diagnostics",
  `- **X seed scan:** ${diag.x_seed?.items_kept ?? 0} items kept at collection time.`,
  `- **RSS:** ${diag.rss?.items_kept ?? 0} items kept at collection time.`,
  `- **GitHub:** ${diag.github?.items_kept ?? 0} items kept at collection time.`,
  `- **arXiv:** ${diag.arxiv?.items_kept ?? 0} items kept.`,
  `- **Telegram:** status \`${diag.telegram?.status ?? "unknown"}\`; ${diag.telegram?.items_kept ?? 0} items kept; channels scanned ${diag.telegram?.channels_scanned ?? "unknown"}; channels with activity ${diag.telegram?.channels_with_activity ?? "unknown"}.`,
  `- **Dedup:** ${diag.dedup?.total_before ?? 0} candidates before rolling dedup; ${diag.dedup?.total_after ?? 0} remained after dedup against the 14-day seen store.`,
  "",
];

if (kept.length) {
  const strongest = kept.slice(0, Math.min(3, kept.length)).map((entry) => titleFor(entry.item));
  dailyLines.push("## Editorial note");
  dailyLines.push(`Today's strongest signals were ${strongest.join("; ")}.`);
  dailyLines.push("");
} else {
  dailyLines.push("## Editorial note");
  dailyLines.push("Today's manifest skewed heavily toward seed-set chatter and low-signal newsletter items rather than concrete standards, infrastructure, or payment developments.");
  dailyLines.push("");
}

const filteredLines = [
  `# Signals Filtered — ${signalDate}`,
  "",
  "## Below threshold",
  "",
];

for (const klass of ["below_threshold", "missing_anchor_signal", "topic_dedup", "collapsed_to_cluster"]) {
  if (klass !== "below_threshold") {
    filteredLines.push(`## ${klass === "missing_anchor_signal" ? "Missing required anchor signal" : klass === "topic_dedup" ? "Topic dedup / prior coverage" : "Collapsed to cluster"}`);
    filteredLines.push("");
  }
  const items = filtered.filter((entry) => entry.exclusionClass === klass);
  if (!items.length) {
    filteredLines.push("No items.");
    filteredLines.push("");
    continue;
  }
  for (const entry of items) {
    const item = entry.item;
    filteredLines.push(`### ${titleFor(item)}`);
    filteredLines.push(`- **Source:** ${item.source} / ${item.subsource || "n/a"}`);
    filteredLines.push(`- **Author:** ${item.author?.handle ? "@" + item.author.handle : item.author?.display_name || "Unknown"}`);
    filteredLines.push(`- **Link:** ${item.url}`);
    if (item.created_at) filteredLines.push(`- **Captured timestamp:** ${item.created_at}`);
    filteredLines.push(`- **Exclusion class:** ${entry.exclusionClass}`);
    filteredLines.push(`- **Reason:** ${entry.reason}`);
    filteredLines.push(`- **Scoring note:** ${entry.composite} score; dominant axis ${entry.dominantAxis}.`);
    filteredLines.push("");
  }
}

filteredLines.push("## Collection-stage URL dedup");
filteredLines.push("");
if (!collectionDeduped.length) {
  filteredLines.push("No items.");
  filteredLines.push("");
} else {
  for (const item of collectionDeduped) {
    filteredLines.push(`### ${titleFor(item)}`);
    filteredLines.push(`- **Source:** ${item.source} / ${item.subsource || "n/a"}`);
    filteredLines.push(`- **Author:** ${item.author?.handle ? "@" + item.author.handle : item.author?.display_name || "Unknown"}`);
    filteredLines.push(`- **Link:** ${item.url}`);
    if (item.created_at) filteredLines.push(`- **Captured timestamp:** ${item.created_at}`);
    filteredLines.push("- **Exclusion class:** collection_url_dedup");
    filteredLines.push("- **Reason:** URL already appeared in the rolling 14-day seen store before processor-time scoring.");
    filteredLines.push("");
  }
}

filteredLines.push("## Filter diagnostics summary");
filteredLines.push("");
const totalFilteredCount = filtered.length + collectionDeduped.length;
filteredLines.push(`- **Kept:** ${kept.length}`);
filteredLines.push(`- **Filtered:** ${totalFilteredCount}`);
filteredLines.push(`- **Threshold failures:** ${filtered.filter((entry) => entry.exclusionClass === "below_threshold").length}`);
filteredLines.push(`- **Missing anchor signal:** ${filtered.filter((entry) => entry.exclusionClass === "missing_anchor_signal").length}`);
filteredLines.push(`- **Topic dedup:** ${filtered.filter((entry) => entry.exclusionClass === "topic_dedup").length}`);
filteredLines.push(`- **Collapsed to cluster:** ${filtered.filter((entry) => entry.exclusionClass === "collapsed_to_cluster").length}`);
filteredLines.push(`- **Collection-stage URL dedup:** ${collectionDeduped.length}`);
filteredLines.push("");

fs.writeFileSync(dailyPath, dailyLines.join("\n"));
fs.writeFileSync(filteredPath, filteredLines.join("\n"));

const tier3ToAppend = [];
for (const entry of kept) {
  if (entry.tier !== 3) continue;
  const handle = entry.item.author?.handle;
  if (!handle) continue;
  tier3ToAppend.push(JSON.stringify({
    date: signalDate,
    handle,
    url: entry.item.url,
    score_axis: entry.dominantAxis,
    subsource: entry.item.subsource || ""
  }));
}
if (tier3ToAppend.length) {
  fs.appendFileSync(tier3AuthorsPath, tier3ToAppend.join("\n") + "\n");
}

let risingWritten = false;
if (manifest.weekly_report_due) {
  const lines = [
    `# Rising Authors — ${signalDate}`,
    "",
    "Weekly report requested, but no Tier 3 author crossed the two-appearance threshold in the current local state snapshot.",
    ""
  ];
  fs.writeFileSync(risingAuthorsPath, lines.join("\n"));
  risingWritten = true;
}

if (fs.existsSync(markerPath)) {
  fs.unlinkSync(markerPath);
}

const output = {
  dailyPath,
  filteredPath,
  risingWritten,
  risingAuthorsPath,
  keptCount: kept.length,
  filteredCount: totalFilteredCount,
  strongest: kept.slice(0, 4).map((entry) => ({
    title: titleFor(entry.item),
    url: entry.item.url,
    tier: entry.tier,
    score: entry.composite
  }))
};

console.log(JSON.stringify(output, null, 2));
