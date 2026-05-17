#!/usr/bin/env bash
set -euo pipefail
# x-seed-scan.sh
# Pulls recent posts from each seed author. Emits JSON array to stdout.
# Items get is_seed_author=true so the agent can prioritise them.
#
# Usage:
#   x-seed-scan.sh <hours>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export SKILL_ROOT
# shellcheck source=./lib/filters.sh
source "$SCRIPT_DIR/lib/filters.sh"
filters_load

HOURS="${1:-24}"
if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then HOURS=24; fi

SEEDS_FILE="$SKILL_ROOT/config/seed-authors.json"
X_ENV_FILE="${SOCIAL_SCAN_ENV_FILE:-$HOME/.config/social-scan/.env}"
X_TOKEN_FILE="${X_BEARER_TOKEN_FILE:-$HOME/.config/social-scan/x-bearer-token.txt}"
if [[ -f "$X_ENV_FILE" ]]; then set -a; source "$X_ENV_FILE"; set +a; fi
if [[ -f "$X_TOKEN_FILE" ]]; then X_BEARER_TOKEN="$(tr -d '\r\n' < "$X_TOKEN_FILE")"; fi

if [[ -z "${X_BEARER_TOKEN:-}" ]]; then
  echo "[x-seed-scan] X_BEARER_TOKEN not set; skipping." >&2
  echo "[]"
  exit 0
fi

START_TIME=$(date -u -d "$HOURS hours ago" +"%Y-%m-%dT%H:%M:%SZ")
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# Build flat list of {handle, category}
SEEDS=$(jq -c '
  .categories
  | to_entries
  | map(.key as $cat | .value[] | {handle: .handle, category: $cat})
  | flatten
' "$SEEDS_FILE")

OUT="[]"
SEED_COUNT=$(echo "$SEEDS" | jq 'length')
HANDLES_PROCESSED=0

for ((i=0; i<SEED_COUNT; i++)); do
  seed=$(echo "$SEEDS" | jq -c ".[$i]")
  handle=$(echo "$seed" | jq -r '.handle')
  category=$(echo "$seed" | jq -r '.category')

  # 1) Resolve handle to user_id (cached crudely per run)
  USER_JSON="$TMP_DIR/user-$handle.json"
  if ! curl -s --max-time 30 \
       "https://api.x.com/2/users/by/username/$handle?user.fields=id,username,created_at,public_metrics,description" \
       -H "Authorization: Bearer ${X_BEARER_TOKEN}" > "$USER_JSON" 2>/dev/null; then
    continue
  fi
  user_id=$(jq -r '.data.id // empty' "$USER_JSON")
  if [[ -z "$user_id" ]]; then continue; fi

  display_name=$(jq -r '.data.name // ""' "$USER_JSON")
  bio=$(jq -r '.data.description // ""' "$USER_JSON")
  acct_created=$(jq -r '.data.created_at // ""' "$USER_JSON")
  followers=$(jq -r '.data.public_metrics.followers_count // 0' "$USER_JSON")

  age_days=0
  if [[ -n "$acct_created" ]]; then
    ts=$(date -u -d "$acct_created" +%s 2>/dev/null || echo 0)
    now=$(date -u +%s)
    if [[ "$ts" -gt 0 ]]; then age_days=$(( (now - ts) / 86400 )); fi
  fi

  # 2) Pull recent tweets
  TWEETS_JSON="$TMP_DIR/tweets-$handle.json"
  if ! curl -s --max-time 30 --get \
       "https://api.x.com/2/users/$user_id/tweets" \
       -H "Authorization: Bearer ${X_BEARER_TOKEN}" \
       --data-urlencode "start_time=$START_TIME" \
       --data-urlencode "max_results=10" \
       --data-urlencode 'tweet.fields=created_at,public_metrics,text,referenced_tweets' \
       --data-urlencode 'exclude=retweets' \
       > "$TWEETS_JSON" 2>/dev/null; then
    continue
  fi

  TWEETS=$(jq -c '.data // []' "$TWEETS_JSON")
  TCOUNT=$(echo "$TWEETS" | jq 'length')
  for ((j=0; j<TCOUNT; j++)); do
    tweet=$(echo "$TWEETS" | jq -c ".[$j]")
    text=$(echo "$tweet" | jq -r '.text // ""')
    tweet_id=$(echo "$tweet" | jq -r '.id')
    created=$(echo "$tweet" | jq -r '.created_at // ""')
    likes=$(echo "$tweet" | jq -r '.public_metrics.like_count // 0')
    reposts=$(echo "$tweet" | jq -r '.public_metrics.retweet_count // 0')
    replies=$(echo "$tweet" | jq -r '.public_metrics.reply_count // 0')
    quotes=$(echo "$tweet" | jq -r '.public_metrics.quote_count // 0')

    # Even seed authors can post noise; apply text filter
    if ! filters_text_passes "$text"; then continue; fi

    url="https://x.com/$handle/status/$tweet_id"
    metadata=$(filters_extract_metadata "$text")

    entry=$(jq -nc \
      --arg source "x-seed" \
      --arg subsource "@$handle" \
      --arg category "$category" \
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
        metadata: $metadata
      }')
    OUT=$(echo "$OUT" | jq --argjson e "$entry" '. + [$e]')
  done
  HANDLES_PROCESSED=$((HANDLES_PROCESSED+1))

  # Light rate-limit courtesy
  sleep 0.2
done

echo "[x-seed-scan] processed $HANDLES_PROCESSED/$SEED_COUNT handles" >&2
echo "$OUT"
