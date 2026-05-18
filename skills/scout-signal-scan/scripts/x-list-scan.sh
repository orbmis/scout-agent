#!/usr/bin/env bash
set -euo pipefail
# x-list-scan.sh
# Reads tweets from the configured Scout watch List via GET /2/lists/:id/tweets.
# Replaces x-seed-scan.sh's per-handle approach: one API call, all members covered.
# The List determines who is scanned; seed-authors.json provides editorial
# category labels (aa_standards, agent_payments, etc.) for items where the
# author is also catalogued there.
#
# Emits JSON array of items to stdout, manifest-shape compatible with the
# previous x-seed-scan output (source: "x-seed", is_seed_author: true).
#
# Usage:
#   x-list-scan.sh <hours>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export SKILL_ROOT
# shellcheck source=./lib/filters.sh
source "$SCRIPT_DIR/lib/filters.sh"
filters_load

HOURS="${1:-24}"
if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then HOURS=24; fi
CUTOFF_TS=$(date -u -d "$HOURS hours ago" +%s)

LIST_CONFIG="$SKILL_ROOT/config/x-list.json"
SEEDS_FILE="$SKILL_ROOT/config/seed-authors.json"

if [[ ! -f "$LIST_CONFIG" ]]; then
  echo "[x-list-scan] missing config: $LIST_CONFIG" >&2
  echo "[]"; exit 0
fi

LIST_ID=$(jq -r '.list_id // empty' "$LIST_CONFIG")
MAX_RESULTS=$(jq -r '.max_results // 100' "$LIST_CONFIG")

if [[ -z "$LIST_ID" || "$LIST_ID" == "REPLACE_WITH_YOUR_LIST_ID" ]]; then
  echo "[x-list-scan] list_id not set in $LIST_CONFIG" >&2
  echo "[]"; exit 0
fi

# Load X token (orchestrator usually sources this, but be defensive)
X_ENV_FILE="${SOCIAL_SCAN_ENV_FILE:-$HOME/.config/social-scan/.env}"
if [[ -f "$X_ENV_FILE" ]]; then set -a; source "$X_ENV_FILE"; set +a; fi
if [[ -z "${X_BEARER_TOKEN:-}" ]]; then
  echo "[x-list-scan] X_BEARER_TOKEN not set; skipping" >&2
  echo "[]"; exit 0
fi

# Build handle -> category map from seed-authors.json (lowercased for case-insensitive lookup)
HANDLE_CATEGORY_MAP="{}"
if [[ -f "$SEEDS_FILE" ]]; then
  HANDLE_CATEGORY_MAP=$(jq -c '
    .categories
    | to_entries
    | map(
        .key as $cat
        | .value
        | map({ (.handle | ascii_downcase): $cat })
      )
    | flatten
    | add // {}
  ' "$SEEDS_FILE")
fi

# Single API call to fetch all recent tweets from list members
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
RESPONSE_FILE="$TMP_DIR/response.json"

curl -s --max-time 30 --connect-timeout 5 --get \
  "https://api.x.com/2/lists/$LIST_ID/tweets" \
  -H "Authorization: Bearer $X_BEARER_TOKEN" \
  --data-urlencode "max_results=$MAX_RESULTS" \
  --data-urlencode 'tweet.fields=created_at,public_metrics,text,entities,referenced_tweets' \
  --data-urlencode 'expansions=author_id' \
  --data-urlencode 'user.fields=username,name,created_at,public_metrics,description' \
  > "$RESPONSE_FILE" 2>/dev/null || {
    echo "[x-list-scan] curl failed" >&2
    echo "[]"; exit 0
  }

# Detect API errors
if jq -e '.errors or .error or .title == "Forbidden" or .title == "Not Found"' "$RESPONSE_FILE" >/dev/null 2>&1; then
  err_title=$(jq -r '.title // .errors[0].title // "unknown"' "$RESPONSE_FILE" 2>/dev/null)
  err_detail=$(jq -r '.detail // .errors[0].detail // "no detail"' "$RESPONSE_FILE" 2>/dev/null)
  echo "[x-list-scan] API error: $err_title — $err_detail" >&2
  echo "[]"; exit 0
fi

USERS_MAP=$(jq -c '(.includes.users // []) | map({key: .id, value: .}) | from_entries' "$RESPONSE_FILE")
TWEETS=$(jq -c '.data // []' "$RESPONSE_FILE")
TCOUNT=$(echo "$TWEETS" | jq 'length')

OUT="[]"
KEPT=0
DROPPED_TIMEWINDOW=0
DROPPED_FILTERS=0

for ((i=0; i<TCOUNT; i++)); do
  tweet=$(echo "$TWEETS" | jq -c ".[$i]")
  author_id=$(echo "$tweet" | jq -r '.author_id')
  author=$(echo "$USERS_MAP" | jq -c --arg id "$author_id" '.[$id] // {}')

  handle=$(echo "$author" | jq -r '.username // "unknown"')
  display_name=$(echo "$author" | jq -r '.name // ""')
  bio=$(echo "$author" | jq -r '.description // ""')
  acct_created=$(echo "$author" | jq -r '.created_at // ""')
  followers=$(echo "$author" | jq -r '.public_metrics.followers_count // 0')

  text=$(echo "$tweet" | jq -r '.text // ""')
  created=$(echo "$tweet" | jq -r '.created_at // ""')
  tweet_id=$(echo "$tweet" | jq -r '.id')
  likes=$(echo "$tweet" | jq -r '.public_metrics.like_count // 0')
  reposts=$(echo "$tweet" | jq -r '.public_metrics.retweet_count // 0')
  replies=$(echo "$tweet" | jq -r '.public_metrics.reply_count // 0')
  quotes=$(echo "$tweet" | jq -r '.public_metrics.quote_count // 0')

  # Client-side time window filter (the endpoint doesn't always honour start_time)
  if [[ -n "$created" ]]; then
    ts=$(date -u -d "$created" +%s 2>/dev/null || echo 0)
    if [[ "$ts" -gt 0 && "$ts" -lt "$CUTOFF_TS" ]]; then
      DROPPED_TIMEWINDOW=$((DROPPED_TIMEWINDOW+1))
      continue
    fi
  fi

  # Hard negative filters
  if ! filters_text_passes "$text"; then
    DROPPED_FILTERS=$((DROPPED_FILTERS+1))
    continue
  fi

  # Account age
  age_days=0
  if [[ -n "$acct_created" ]]; then
    ts2=$(date -u -d "$acct_created" +%s 2>/dev/null || echo 0)
    now=$(date -u +%s)
    if [[ "$ts2" -gt 0 ]]; then age_days=$(( (now - ts2) / 86400 )); fi
  fi

  # URL expansion via entities.urls (fixes t.co blindness)
  expanded_urls=$(echo "$tweet" | jq -c '[.entities.urls[]?.expanded_url // empty]')
  expanded_url_blob=$(echo "$expanded_urls" | jq -r '.[]' | tr '\n' ' ')
  enrichment_text="$text $expanded_url_blob"

  # Seed category lookup from seed-authors.json (case-insensitive)
  handle_lower=$(echo "$handle" | tr '[:upper:]' '[:lower:]')
  seed_category=$(echo "$HANDLE_CATEGORY_MAP" | jq -r --arg h "$handle_lower" '.[$h] // "uncategorised"')

  url="https://x.com/$handle/status/$tweet_id"
  metadata=$(filters_extract_metadata "$enrichment_text")

  entry=$(jq -nc \
    --arg source "x-seed" \
    --arg subsource "@$handle" \
    --arg category "$seed_category" \
    --arg url "$url" \
    --arg text "$text" \
    --arg handle "$handle" \
    --arg display "$display_name" \
    --arg bio "$bio" \
    --argjson age "$age_days" \
    --argjson followers "$followers" \
    --arg created "$created" \
    --argjson likes "$likes" \
    --argjson reposts "$reposts" \
    --argjson replies "$replies" \
    --argjson quotes "$quotes" \
    --argjson metadata "$metadata" \
    --argjson expanded_urls "$expanded_urls" \
    '{
      source: $source, subsource: $subsource,
      url: $url, text: $text,
      author: {
        handle: $handle, display_name: $display, bio: $bio,
        account_age_days: $age, followers: $followers,
        is_seed_author: true, seed_category: $category
      },
      engagement: { likes: $likes, reposts: $reposts, replies: $replies, quotes: $quotes },
      created_at: $created,
      metadata: $metadata,
      expanded_urls: $expanded_urls
    }')
  OUT=$(echo "$OUT" | jq --argjson e "$entry" '. + [$e]')
  KEPT=$((KEPT+1))
done

echo "[x-list-scan] tweets_returned=$TCOUNT kept=$KEPT dropped_timewindow=$DROPPED_TIMEWINDOW dropped_filters=$DROPPED_FILTERS" >&2
echo "$OUT"
