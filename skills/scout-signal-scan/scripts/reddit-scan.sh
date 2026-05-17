#!/usr/bin/env bash
set -euo pipefail
# reddit-scan.sh
# Polls an allowlist of subreddits with a topic query. Replaces social-scan-portable.sh.
# The X keyword half is removed; X coverage is handled by x-seed-scan.sh.
# Outputs JSON array of items to stdout.
#
# Usage:
#   reddit-scan.sh "<query>" <hours>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export SKILL_ROOT
# shellcheck source=./lib/filters.sh
source "$SCRIPT_DIR/lib/filters.sh"
filters_load

TOPIC="${1:-}"
HOURS="${2:-24}"

if [[ -z "$TOPIC" ]]; then
  TOPIC='("agentic commerce" OR "agentic payments" OR "machine-to-machine payments" OR "account abstraction" OR "agent wallet" OR "ERC-4337" OR "ERC-7702" OR "x402" OR "agent payment")'
  echo "[reddit-scan] No topic provided; using default Scout query." >&2
fi
if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then HOURS=24; fi
CUTOFF=$(date -u -d "$HOURS hours ago" +%s)

# Subreddit allowlist. Each entry is a subreddit name (no r/ prefix).
# Add or remove subreddits here. Pulled out of a config file deliberately —
# this list is short and change-controlled, not data the agent needs to read.
ALLOWED_SUBS=(
  "ethereum"
  "ethdev"
  "ethfinance"
  "ethstaker"
  "MachineLearning"
  "LocalLLaMA"
)
PER_SUB_LIMIT=10

# Resolve workspace root (for reddit-readonly skill)
if [[ -n "${OPENCLAW_WORKSPACE:-}" ]]; then
  WORKDIR="$OPENCLAW_WORKSPACE"
else
  WORKDIR=""
  for p in "$HOME/.openclaw/workspace-saorin-scout" "$HOME/.openclaw/workspace" \
           "/home/clawdbot/.openclaw/workspace-saorin-scout" "/home/clawdbot/.openclaw/workspace"; do
    if [[ -d "$p" ]]; then WORKDIR="$p"; break; fi
  done
fi
if [[ -z "$WORKDIR" ]]; then
  echo "[reddit-scan] Could not resolve OpenClaw workspace." >&2
  echo "[]"
  exit 0
fi

REDDIT_SCRIPT="$WORKDIR/skills/reddit-readonly/scripts/reddit-readonly.mjs"
if [[ ! -f "$REDDIT_SCRIPT" ]]; then
  echo "[reddit-scan] reddit-readonly skill not found at $REDDIT_SCRIPT" >&2
  echo "[]"
  exit 0
fi

OUT="[]"
SUBS_POLLED=0
SUBS_SUCCESSFUL=0
TOTAL_RAW=0
TOTAL_KEPT=0

for sub in "${ALLOWED_SUBS[@]}"; do
  SUBS_POLLED=$((SUBS_POLLED+1))

  # Even though we're targeting allowlisted subs, run them through the blocklist
  # check anyway — defence in depth in case the allowlist ever drifts into
  # something a later blocklist edit would flag.
  if filters_subreddit_blocked "$sub"; then
    echo "[reddit-scan] $sub is in blocklist; skipping" >&2
    continue
  fi

  TMP_RESULT=$(mktemp)
  if ! timeout 30s node "$REDDIT_SCRIPT" search "$sub" "$TOPIC" --limit "$PER_SUB_LIMIT" > "$TMP_RESULT" 2>/dev/null; then
    echo "[reddit-scan] search failed for r/$sub" >&2
    rm -f "$TMP_RESULT"
    continue
  fi
  if ! jq -e '.ok == true' "$TMP_RESULT" >/dev/null 2>&1; then
    echo "[reddit-scan] non-ok response for r/$sub" >&2
    rm -f "$TMP_RESULT"
    continue
  fi
  SUBS_SUCCESSFUL=$((SUBS_SUCCESSFUL+1))

  POSTS=$(jq -c '.data.posts // []' "$TMP_RESULT")
  rm -f "$TMP_RESULT"

  COUNT=$(echo "$POSTS" | jq 'length')
  TOTAL_RAW=$((TOTAL_RAW + COUNT))
  for ((i=0; i<COUNT; i++)); do
    item=$(echo "$POSTS" | jq -c ".[$i]")
    subreddit=$(echo "$item" | jq -r '.subreddit // ""')
    title=$(echo "$item" | jq -r '.title // ""')
    selftext=$(echo "$item" | jq -r '.selftext // ""')
    text="$title $selftext"

    if ! filters_text_passes "$text"; then continue; fi

    permalink=$(echo "$item" | jq -r '.permalink // ""')
    author=$(echo "$item" | jq -r '.author // ""')
    score=$(echo "$item" | jq -r '.score // 0')
    num_comments=$(echo "$item" | jq -r '.num_comments // 0')
    created_utc=$(echo "$item" | jq -r '.created_utc // 0')

    # Apply the time window cutoff. reddit-readonly returns recent posts but
    # not bounded; we want the same window everything else uses.
    created_int="${created_utc%.*}"
    if [[ -n "$created_int" && "$created_int" =~ ^[0-9]+$ && "$created_int" -lt "$CUTOFF" ]]; then
      continue
    fi
    created_iso=$(date -u -d "@$created_int" -Iseconds 2>/dev/null || echo "")

    metadata=$(filters_extract_metadata "$text")

    entry=$(jq -nc \
      --arg source "reddit" \
      --arg subsource "r/$subreddit" \
      --arg url "$permalink" \
      --arg title "$title" \
      --arg text "$text" \
      --arg author "$author" \
      --arg created "$created_iso" \
      --argjson score "$score" \
      --argjson comments "$num_comments" \
      --argjson metadata "$metadata" \
      '{
        source: $source, subsource: $subsource,
        url: $url, title: $title, text: $text,
        author: { handle: $author },
        engagement: { likes: $score, replies: $comments },
        created_at: $created,
        metadata: $metadata
      }')
    OUT=$(echo "$OUT" | jq --argjson e "$entry" '. + [$e]')
    TOTAL_KEPT=$((TOTAL_KEPT+1))
  done
done

echo "[reddit-scan] subs_polled=$SUBS_POLLED successful=$SUBS_SUCCESSFUL raw=$TOTAL_RAW kept=$TOTAL_KEPT" >&2
echo "$OUT"
