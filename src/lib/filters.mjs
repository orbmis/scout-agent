// filters.mjs — hard negative filters applied at collection time.
// Build once from the editorial config, then call passes(text) / isNoiseReply(text).

export function buildFilters(negative = {}) {
  const blocked = (negative.blocked_text_patterns || []).map((p) => new RegExp(p));
  const noise = (negative.noise_reply_patterns || []).map((p) => new RegExp(p, "i"));

  return {
    // true if the text is clean (no blocked pattern matched).
    passes(text = "") {
      return !blocked.some((re) => re.test(text));
    },
    // true if the text is a low-value reply ("great point", "+1", emoji-only).
    isNoiseReply(text = "") {
      const trimmed = text.trim();
      return noise.some((re) => re.test(trimmed));
    },
  };
}
