// score.mjs — the four-axis editorial scoring model + the topical gate, plus the
// "why it matters" and "connects to" annotation helpers. Pure functions over a
// manifest item; see SPEC.md for the policy these implement.

import { textFor, hasAnyKeyword } from "../lib/text.mjs";

export const trackedTopicPatterns = [
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
  /programmable/i,
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
  /early crypto project/i,
];

const connectTopics = [
  {
    label: "layered architecture of Ethereum account abstraction standards",
    patterns: [
      /4337/i,
      /7702/i,
      /7579/i,
      /7710/i,
      /7715/i,
      /7521/i,
      /7683/i,
      /8211/i,
      /account abstraction/i,
      /smart account/i,
      /delegat/i,
      /nonce/i,
    ],
  },
  {
    label:
      "agent wallet infrastructure stack: six-layer map covering full-stack platforms, signing infrastructure, identity and trust, card issuance, protocol and rail layer, adjacent players",
    patterns: [
      /agent wallet/i,
      /wallet/i,
      /sign/i,
      /identity/i,
      /attestation/i,
      /trust/i,
      /rails/i,
      /payment/i,
      /payments/i,
      /stablecoin/i,
      /card/i,
    ],
  },
  {
    label: "card vs stablecoin rails for agentic commerce; friction-per-autonomous-decision as the unifying frame",
    patterns: [/stablecoin/i, /card/i, /merchant/i, /payments/i, /payment/i, /commerce/i, /remittance/i],
  },
  {
    label: "verification gating versus settlement determination as separable concerns in agent payment design",
    patterns: [/proof of human/i, /identity/i, /attestation/i, /verified/i, /gating/i, /settlement/i, /payments/i],
  },
  {
    label: "intersection of account abstraction, agent wallets, and agentic payments",
    patterns: [/account abstraction/i, /smart account/i, /agent/i, /wallet/i, /payment/i, /stablecoin/i],
  },
  {
    label:
      "The agent wallet stack will consolidate around ERC-4337 plus ERC-7702 plus a delegation standard from the 7710/7715 family",
    patterns: [/4337/i, /7702/i, /7710/i, /7715/i, /delegat/i],
  },
  {
    label:
      "Agent identity and attestation will be a load-bearing primitive in agentic commerce, not an afterthought layered on later",
    patterns: [/identity/i, /attestation/i, /proof of human/i, /verified/i, /memory access rights/i],
  },
  {
    label:
      "Card rails will lose share to native crypto rails as agents take over, not because crypto is cheaper but because per-decision authorisation favours programmable rails",
    patterns: [/stablecoin/i, /payments/i, /remittance/i, /programmable/i, /merchant/i],
  },
];

function parseDiscourseThreadStats(text = "") {
  const match = text.match(/(\d+)\s+posts?\s+-\s+(\d+)\s+participants?/i);
  if (!match) return null;
  return { posts: Number(match[1]), participants: Number(match[2]) };
}

export function describeConnect(item) {
  const text = textFor(item);
  const lc = text.toLowerCase();
  for (const topic of connectTopics) {
    if (topic.patterns.some((pattern) => pattern.test(lc))) {
      if (/memory access rights/i.test(lc))
        return `Connects to ${topic.label}: It is a direct example of agent memory and permissions being specified as a distinct rights layer rather than folded implicitly into wallet control.`;
      if (/7702/i.test(lc) && /gas/i.test(lc))
        return `Connects to ${topic.label}: It adds operational detail to the 7702 execution path, which matters for how delegation-style flows fail and recover in practice.`;
      if (/proof of human|verified/i.test(lc))
        return `Connects to ${topic.label}: It is a concrete example of verification controls being discussed separately from payment or execution rails.`;
      if (/stablecoin|payments?|merchant|remittance/i.test(lc))
        return `Connects to ${topic.label}: It gives a live example of builders framing programmable rails, rather than cards, as the control surface for software-driven payments.`;
      if (/identity|attestation/i.test(lc))
        return `Connects to ${topic.label}: It reinforces that identity and attestation are being treated as first-order infrastructure, not as an application-layer add-on.`;
      return `Connects to ${topic.label}: It supplies a concrete example that sharpens this framing with a current implementation or standards signal.`;
    }
  }
  return null;
}

export function whyMatter(item) {
  const lc = textFor(item).toLowerCase();
  if (/memory access rights/i.test(lc))
    return "It proposes a rights model for what an AI agent may retain and access over time, which is a concrete control-layer question adjacent to wallet authority.";
  if (/7702/i.test(lc) && /gas/i.test(lc))
    return "It sharpens a concrete edge case in 7702 execution, which matters for how delegated transaction flows behave under failure conditions.";
  if (/stablecoins? are the future of money|stablecoin|remittance|merchant/i.test(lc))
    return "It is a direct rails-and-payments signal relevant to how programmable settlement is being framed against incumbent payment infrastructure.";
  if (/proof of human|identity/i.test(lc))
    return "It is a concrete example of identity and verification infrastructure being treated as a control surface for agent or wallet behavior.";
  if (/taskmarket|agents can safely use money|intelligent agents|ai agents can act, transact, and automate/i.test(lc))
    return "It reflects live product or market framing around agent execution, payment controls, or agent-native infrastructure rather than generic AI commentary.";
  return "It adds a concrete standards, infrastructure, or market datapoint inside Scout's tracked themes.";
}

export function scoreItem(item) {
  const author = item.author || {};
  const engagement = item.engagement || {};
  const metadata = item.metadata || {};
  const text = textFor(item);
  const lc = text.toLowerCase();
  const title = item.title || "";
  const discourseStats = parseDiscourseThreadStats(item.text || "");

  const axisScores = { content: 0, author: 0, engagement: 0, negative: 0 };

  if ((metadata.anchor_domain_links || []).length > 0) axisScores.content += 3;
  if (metadata.has_eip_reference) axisScores.content += 3;
  if ((metadata.tracked_protocols || []).length > 0) axisScores.content += 2;
  if ((metadata.tracked_companies || []).length > 0) axisScores.content += 1;
  if ((metadata.technical_markers || []).length > 0)
    axisScores.content += Math.min(2, metadata.technical_markers.length);
  if (metadata.has_code_block) axisScores.content += 1;
  if (item.source === "github") axisScores.content += 2;
  if (item.source === "rss" && item.group !== "newsletters") axisScores.content += 1;
  if (item.source === "rss" && item.tag === "newsletter") axisScores.content += 0.5;
  if (hasAnyKeyword(text, trackedTopicPatterns)) axisScores.content += 2;
  if (
    /erc-|eip-|ai agent memory access rights|stablecoins? are the future of money|agents can safely use money/i.test(
      text
    )
  )
    axisScores.content += 1;

  if (author.is_seed_author) axisScores.author += 2;
  if ((author.account_age_days || 0) > 365) axisScores.author += 1;
  if ((author.account_age_days || 0) > 1825) axisScores.author += 0.5;
  if ((author.followers || 0) > 10000 && hasAnyKeyword((author.bio || "").toLowerCase(), trackedTopicPatterns))
    axisScores.author += 0.5;

  const totalEngagement =
    (engagement.likes || 0) + (engagement.reposts || 0) + (engagement.replies || 0) + (engagement.quotes || 0);
  if ((engagement.seed_engaged_by || []).length > 0) axisScores.engagement += 3;
  if ((engagement.quotes || 0) >= 3) axisScores.engagement += 1;
  if ((engagement.reposts || 0) >= 10) axisScores.engagement += 0.5;
  if (totalEngagement >= 100) axisScores.engagement += 0.5;

  if (thinPatterns.some((pattern) => pattern.test(lc))) axisScores.negative -= 3;
  if (/^rt @/i.test(lc)) axisScores.negative -= 1.5;
  if (text.length < 80) axisScores.negative -= 1.5;
  if (
    /^rt @/i.test(lc) &&
    (metadata.anchor_domain_links || []).length === 0 &&
    (metadata.tracked_protocols || []).length === 0 &&
    (metadata.tracked_companies || []).length === 0
  )
    axisScores.negative -= 1.5;
  if (
    /https:\/\/t\.co\//i.test(text) &&
    (metadata.anchor_domain_links || []).length === 0 &&
    !hasAnyKeyword(text, trackedTopicPatterns)
  )
    axisScores.negative -= 1;
  if (/photo\/1/i.test((item.expanded_urls || []).join(" "))) axisScores.negative -= 0.5;
  if (/giveaway|after party|good morning|happy thursday|fill the wick/i.test(lc)) axisScores.negative -= 2;
  if (/rt @/i.test(lc) && !hasAnyKeyword(text, trackedTopicPatterns)) axisScores.negative -= 1;
  if (/on june \d+|be there|we will be joined|live-stream tomorrow/i.test(lc)) axisScores.negative -= 2;
  if (/openai model has disproved|education for countries|accelerate code review with codex/i.test(lc))
    axisScores.negative -= 3;
  if (/hyperliquid etf|tradfi liquidity/i.test(lc)) axisScores.negative -= 4;
  if (/post-quantum|pq interop/i.test(lc)) axisScores.negative -= 2;
  if (/topic deleted by author|1 post - 1 participant/i.test(lc)) axisScores.negative -= 5;

  let topical = 0;
  if (hasAnyKeyword(text, trackedTopicPatterns)) topical += 2;
  if ((metadata.anchor_domain_links || []).length > 0) topical += 1;
  if ((metadata.eip_numbers || []).some((n) => [4337, 7702, 7579, 7710, 7715, 7521, 7683, 8211].includes(n)))
    topical += 2;
  if (
    /7702|4337|7710|7715|smart account|agent|stablecoin|payment|payments|identity|attestation|wallet/i.test(
      title + " " + text
    )
  )
    topical += 1;

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
    (item.source === "rss" &&
      ["research_outputs", "core_protocol", "forums", "company_blogs"].includes(item.group || "")) ||
    (metadata.anchor_domain_links || []).length > 0 ||
    (engagement.seed_engaged_by || []).length > 0 ||
    !!author.is_seed_author ||
    strongContentSpecificityCount >= 2;

  const sourceThreshold = item.source === "github" || item.source === "rss" ? 4 : 5;
  const score = Math.max(0, rawScore);
  const passesScore = score >= sourceThreshold && topical >= 2;

  const dominantAxis = Object.entries(axisScores).sort((a, b) => b[1] - a[1])[0]?.[0] || "content";
  const dominantAxisLabel =
    dominantAxis === "author"
      ? "author shape"
      : dominantAxis === "engagement"
        ? "network engagement"
        : dominantAxis === "negative"
          ? "negative markers"
          : "content specificity";
  const composite = score >= 8 ? "strong" : score >= 5 ? "moderate" : "weak";

  let exclusionClass = null;
  let reason = null;
  if (item.source === "rss" && item.subsource === "Ethereum Magicians" && discourseStats && discourseStats.posts <= 1) {
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
