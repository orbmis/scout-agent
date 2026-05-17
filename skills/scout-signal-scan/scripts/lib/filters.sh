#!/usr/bin/env bash
# lib/filters.sh
# Shared filtering and metadata extraction. Source from other scripts.
# Provides:
#   filters_load                  - loads config files into env-accessible JSON
#   filters_text_passes "<text>"  - returns 0 if text passes negative filters, 1 if blocked
#   filters_subreddit_blocked "<sub>" - returns 0 if blocked, 1 if allowed
#   filters_extract_metadata "<text>" - emits JSON object with content-specificity flags

SKILL_ROOT="${SKILL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NEG_FILTERS_FILE="$SKILL_ROOT/config/negative-filters.json"
TRACKED_FILE="$SKILL_ROOT/config/tracked-entities.json"

filters_load() {
  if [[ ! -f "$NEG_FILTERS_FILE" ]]; then
    echo "filters: missing $NEG_FILTERS_FILE" >&2
    return 1
  fi
  if [[ ! -f "$TRACKED_FILE" ]]; then
    echo "filters: missing $TRACKED_FILE" >&2
    return 1
  fi
  return 0
}

filters_subreddit_blocked() {
  local sub="$1"
  local blocked
  blocked=$(jq -r --arg s "$sub" '.blocked_subreddits[] | select(ascii_downcase == ($s | ascii_downcase))' "$NEG_FILTERS_FILE" 2>/dev/null | head -1)
  if [[ -n "$blocked" ]]; then return 0; fi

  # Pattern-based block (ticker-shaped sub names)
  while IFS= read -r pattern; do
    if [[ "$sub" =~ $pattern ]]; then return 0; fi
  done < <(jq -r '.blocked_subreddit_patterns[]' "$NEG_FILTERS_FILE")
  return 1
}

filters_text_passes() {
  local text="$1"
  # Returns 0 if passes (no blocked patterns found), 1 if blocked
  while IFS= read -r pattern; do
    if echo "$text" | grep -qE "$pattern"; then
      return 1
    fi
  done < <(jq -r '.blocked_text_patterns[]' "$NEG_FILTERS_FILE")
  return 0
}

filters_is_noise_reply() {
  local text="$1"
  # Returns 0 if text matches a noise-reply pattern
  local trimmed
  trimmed=$(echo "$text" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
  while IFS= read -r pattern; do
    if echo "$trimmed" | grep -qiE "$pattern"; then
      return 0
    fi
  done < <(jq -r '.noise_reply_patterns[]' "$NEG_FILTERS_FILE")
  return 1
}

filters_account_blocked() {
  # Args: account_age_days posts_per_day handle
  local age="$1" velocity="$2" handle="$3"
  local min_age max_velocity ticker_regex
  min_age=$(jq -r '.blocked_account_rules.min_account_age_days' "$NEG_FILTERS_FILE")
  max_velocity=$(jq -r '.blocked_account_rules.max_posts_per_day_for_new_account' "$NEG_FILTERS_FILE")
  ticker_regex=$(jq -r '.blocked_account_rules.ticker_in_handle_regex' "$NEG_FILTERS_FILE")

  if [[ -n "$age" && "$age" =~ ^[0-9]+$ && "$age" -lt "$min_age" ]]; then
    if [[ -n "$velocity" && "$velocity" =~ ^[0-9]+$ && "$velocity" -gt "$max_velocity" ]]; then
      return 0
    fi
  fi
  if [[ -n "$handle" ]] && echo "$handle" | grep -qE "$ticker_regex"; then
    return 0
  fi
  return 1
}

filters_extract_metadata() {
  # Args: text
  # Emits JSON object with content-specificity flags
  local text="$1"
  local has_eip="false" eip_numbers="[]"
  local has_code="false" anchor_links="[]"
  local tracked_companies="[]" tracked_protocols="[]" tech_markers="[]"

  # EIP detection
  local eip_pattern
  eip_pattern=$(jq -r '.eip_pattern' "$TRACKED_FILE")
  if echo "$text" | grep -qE "$eip_pattern"; then
    has_eip="true"
    eip_numbers=$(echo "$text" | grep -oE "$eip_pattern" | grep -oE "[0-9]+" | sort -u | jq -R . | jq -sc .)
  fi

  # Code block detection
  if echo "$text" | grep -qE '```|0x[a-fA-F0-9]{40}|function [a-zA-Z]+\('; then
    has_code="true"
  fi

  # Anchor domain links
  anchor_links=$(jq -r '.anchor_domains[]' "$TRACKED_FILE" | while read -r domain; do
    if echo "$text" | grep -qF "$domain"; then echo "$domain"; fi
  done | jq -R . | jq -sc .)

  # Tracked companies (case-insensitive)
  tracked_companies=$(jq -r '.companies | to_entries[] | .value[]' "$TRACKED_FILE" | while read -r company; do
    if echo "$text" | grep -qiF "$company"; then echo "$company"; fi
  done | jq -R . | jq -sc .)

  # Tracked protocols
  tracked_protocols=$(jq -r '.protocols[]' "$TRACKED_FILE" | while read -r proto; do
    if echo "$text" | grep -qF "$proto"; then echo "$proto"; fi
  done | jq -R . | jq -sc .)

  # Technical markers
  tech_markers=$(jq -r '.technical_markers[]' "$TRACKED_FILE" | while read -r marker; do
    if echo "$text" | grep -qiF "$marker"; then echo "$marker"; fi
  done | jq -R . | jq -sc .)

  jq -n \
    --argjson has_eip "$has_eip" \
    --argjson eip_numbers "$eip_numbers" \
    --argjson has_code "$has_code" \
    --argjson anchor_links "$anchor_links" \
    --argjson companies "$tracked_companies" \
    --argjson protocols "$tracked_protocols" \
    --argjson markers "$tech_markers" \
    '{
      has_eip_reference: $has_eip,
      eip_numbers: $eip_numbers,
      has_code_block: $has_code,
      anchor_domain_links: $anchor_links,
      tracked_companies: $companies,
      tracked_protocols: $protocols,
      technical_markers: $markers
    }'
}
