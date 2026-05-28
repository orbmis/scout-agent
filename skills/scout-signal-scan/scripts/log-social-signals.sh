#!/usr/bin/env bash
set -euo pipefail
# log-social-signals.sh
# Orchestrates all collectors, deduplicates against rolling state, writes JSON manifest,
# and creates a marker file the agent picks up to process per AGENTS.md.
#
# Usage:
#   log-social-signals.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export SKILL_ROOT
# shellcheck source=./lib/state.sh
source "$SCRIPT_DIR/lib/state.sh"

# Inherit secrets and tokens so child collectors see them
if [[ -f "$HOME/.config/social-scan/.env" ]]; then
  set -a
  source "$HOME/.config/social-scan/.env"
  set +a
fi

WORKSPACE="${OPENCLAW_WORKSPACE:-/home/clawdbot/.openclaw/workspace-saorin-scout}"
SIGNALS_DIR="${SCOUT_SIGNALS_DIR:-/home/clawdbot/obsidian-vault/Signals}"
MANIFEST_DIR="${SCOUT_MANIFEST_DIR:-/tmp/scout}"
DATE_UTC=$(date -u +%F)
CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MANIFEST_FILE="$MANIFEST_DIR/manifest-$DATE_UTC.json"
MARKER_FILE="$MANIFEST_DIR/ready-$DATE_UTC.marker"
MANIFEST_MD_FILE="$SIGNALS_DIR/manifest-$DATE_UTC.md"

# Default window sizes
REDDIT_HOURS="${REDDIT_HOURS:-24}"
SEED_HOURS="${SEED_HOURS:-24}"
RSS_HOURS="${RSS_HOURS:-48}"
GITHUB_HOURS="${GITHUB_HOURS:-24}"
ARXIV_HOURS="${ARXIV_HOURS:-48}"

mkdir -p "$MANIFEST_DIR" "$SIGNALS_DIR"
state_init

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Default keyword query for the Reddit scan (passed to reddit-scan.sh)
QUERY='("agentic commerce" OR "agentic payments" OR "machine-to-machine payments" OR "account abstraction" OR "agent wallet" OR "ERC-4337" OR "ERC-7702" OR "x402" OR "agent payment")'

run_collector() {
  local name="$1"; shift
  local out_file="$1"; shift
  echo "[orchestrator] running $name..." >&2
  if ! "$@" > "$out_file" 2>"$TMP/$name.err"; then
    echo "[orchestrator] $name failed; using empty array" >&2
    cat "$TMP/$name.err" >&2 || true
    echo "[]" > "$out_file"
  fi
  # Validate JSON
  if ! jq -e 'type == "array"' "$out_file" >/dev/null 2>&1; then
    echo "[orchestrator] $name produced invalid JSON; coercing to empty" >&2
    echo "[]" > "$out_file"
  fi
  # Surface diagnostics to stderr
  cat "$TMP/$name.err" >&2 || true
}

run_collector "reddit-scan" "$TMP/reddit.json" bash "$SCRIPT_DIR/reddit-scan.sh" "$QUERY" "$REDDIT_HOURS"
run_collector "x-list-scan" "$TMP/seed.json"   bash "$SCRIPT_DIR/x-list-scan.sh" "$SEED_HOURS"
run_collector "rss-scan"    "$TMP/rss.json"    bash "$SCRIPT_DIR/rss-scan.sh" "$RSS_HOURS"
run_collector "github-scan" "$TMP/github.json" bash "$SCRIPT_DIR/github-scan.sh" "$GITHUB_HOURS"
run_collector "arxiv-scan"  "$TMP/arxiv.json"  bash "$SCRIPT_DIR/arxiv-scan.sh" "$ARXIV_HOURS"

# Telegram collector now lives in-skill. Keep diagnostics explicit so the agent
# can distinguish missing setup from ordinary no-activity runs.
TELEGRAM_SCRIPT="$SCRIPT_DIR/telegram-scan.sh"
TELEGRAM_JSON="$TMP/telegram.json"
TELEGRAM_ERR="$TMP/telegram-scan.err"
echo "[]" > "$TELEGRAM_JSON"
TELEGRAM_DIAG='{"channels_scanned":0,"channels_with_activity":0,"items_kept":0,"status":"script_missing"}'
if [[ -x "$TELEGRAM_SCRIPT" ]]; then
  if "$TELEGRAM_SCRIPT" 4 > "$TELEGRAM_JSON" 2>"$TELEGRAM_ERR"; then
    if ! jq -e 'type == "array"' "$TELEGRAM_JSON" >/dev/null 2>&1; then
      echo "[orchestrator] telegram-scan produced invalid JSON; coercing to empty" >&2
      echo "[]" > "$TELEGRAM_JSON"
    fi

    TELEGRAM_COUNT=$(jq 'length' "$TELEGRAM_JSON")
    TELEGRAM_SUMMARY=$(grep -E '^\[telegram-scan\] channels=' "$TELEGRAM_ERR" | tail -n 1 || true)

    if [[ -n "$TELEGRAM_SUMMARY" ]]; then
      TELEGRAM_CHANNELS=$(echo "$TELEGRAM_SUMMARY" | sed -E 's/.*channels=([0-9]+).*/\1/')
      TELEGRAM_ACTIVE=$(echo "$TELEGRAM_SUMMARY" | sed -E 's/.*channels_with_activity=([0-9]+).*/\1/')
      TELEGRAM_STATUS="ok"
      if [[ "$TELEGRAM_COUNT" -eq 0 ]]; then
        TELEGRAM_STATUS="no_activity"
      fi
      TELEGRAM_DIAG=$(jq -nc \
        --argjson scanned "$TELEGRAM_CHANNELS" \
        --argjson active "$TELEGRAM_ACTIVE" \
        --argjson kept "$TELEGRAM_COUNT" \
        --arg status "$TELEGRAM_STATUS" \
        '{channels_scanned: $scanned, channels_with_activity: $active, items_kept: $kept, status: $status}')
    elif grep -q 'missing config' "$TELEGRAM_ERR"; then
      TELEGRAM_DIAG='{"channels_scanned":0,"channels_with_activity":0,"items_kept":0,"status":"script_missing"}'
    else
      TELEGRAM_DIAG='{"channels_scanned":0,"channels_with_activity":0,"items_kept":0,"status":"script_failed"}'
    fi
  else
    TELEGRAM_DIAG='{"channels_scanned":0,"channels_with_activity":0,"items_kept":0,"status":"script_failed"}'
  fi
  cat "$TELEGRAM_ERR" >&2 || true
fi

# Merge all collector outputs
MERGED=$(jq -s 'add' "$TMP/reddit.json" "$TMP/seed.json" "$TMP/rss.json" "$TMP/github.json" "$TMP/arxiv.json" "$TELEGRAM_JSON")

# Apply state-based URL dedup without mutating state until the manifest is safely written
NEW_ITEMS=$(echo "$MERGED" | state_filter_new_items_no_mark)

# Build collection diagnostics
REDDIT_COUNT=$(jq 'length' "$TMP/reddit.json")
SEED_COUNT=$(jq 'length' "$TMP/seed.json")
RSS_COUNT=$(jq 'length' "$TMP/rss.json")
GITHUB_COUNT=$(jq 'length' "$TMP/github.json")
ARXIV_COUNT=$(jq 'length' "$TMP/arxiv.json")
TOTAL_BEFORE_DEDUP=$(echo "$MERGED" | jq 'length')
TOTAL_AFTER_DEDUP=$(echo "$NEW_ITEMS" | jq 'length')

DIAGNOSTICS=$(jq -nc \
  --argjson reddit "$REDDIT_COUNT" \
  --argjson seed "$SEED_COUNT" \
  --argjson rss "$RSS_COUNT" \
  --argjson github "$GITHUB_COUNT" \
  --argjson arxiv "$ARXIV_COUNT" \
  --argjson telegram "$TELEGRAM_DIAG" \
  --argjson before "$TOTAL_BEFORE_DEDUP" \
  --argjson after "$TOTAL_AFTER_DEDUP" \
  '{
    reddit:    { items_kept: $reddit },
    x_seed:    { items_kept: $seed },
    rss:       { items_kept: $rss },
    github:    { items_kept: $github },
    arxiv:     { items_kept: $arxiv },
    telegram:  $telegram,
    dedup:     { total_before: $before, total_after: $after }
  }')

# Build the manifest
PREV_FILES=$(find "$SIGNALS_DIR" -name "????-??-??.md" -type f -mtime -14 2>/dev/null | sort | jq -R . | jq -sc .)
printf '%s\n' "$NEW_ITEMS" > "$TMP/new-items.json"
printf '%s\n' "$DIAGNOSTICS" > "$TMP/diagnostics.json"
printf '%s\n' "$PREV_FILES" > "$TMP/prev-files.json"

# Day-of-week for weekly report flag (1=Mon..7=Sun)
DOW=$(date -u +%u)
WEEKLY_FLAG="false"
if [[ "$DOW" == "7" ]]; then WEEKLY_FLAG="true"; fi

jq -n \
  --arg captured_at "$CAPTURED_AT" \
  --arg date_utc "$DATE_UTC" \
  --argjson reddit_hours "$REDDIT_HOURS" \
  --argjson seed_hours "$SEED_HOURS" \
  --argjson rss_hours "$RSS_HOURS" \
  --argjson github_hours "$GITHUB_HOURS" \
  --argjson arxiv_hours "$ARXIV_HOURS" \
  --argjson weekly_report_due "$WEEKLY_FLAG" \
  --arg signals_dir "$SIGNALS_DIR" \
  --slurpfile new_items "$TMP/new-items.json" \
  --slurpfile diagnostics "$TMP/diagnostics.json" \
  --slurpfile prev_files "$TMP/prev-files.json" \
  '{
    schema_version: "1.1",
    captured_at: $captured_at,
    date_utc: $date_utc,
    window_hours: {
      reddit: $reddit_hours,
      x_seed: $seed_hours,
      rss:    $rss_hours,
      github: $github_hours,
      arxiv:  $arxiv_hours
    },
    signals_dir: $signals_dir,
    previous_signals_files: $prev_files[0],
    weekly_report_due: $weekly_report_due,
    collection_diagnostics: $diagnostics[0],
    items: $new_items[0]
  }' > "$MANIFEST_FILE"

{
  printf '# Manifest - %s\n\n' "$DATE_UTC"
  printf '```json\n'
  jq '.' "$MANIFEST_FILE"
  printf '\n```\n'
} > "$MANIFEST_MD_FILE"

echo "$NEW_ITEMS" | state_mark_urls_from_items

touch "$MARKER_FILE"

echo "[orchestrator] manifest written: $MANIFEST_FILE" >&2
echo "[orchestrator] markdown copy written: $MANIFEST_MD_FILE" >&2
echo "[orchestrator] items: $TOTAL_AFTER_DEDUP (of $TOTAL_BEFORE_DEDUP before dedup)" >&2
echo "[orchestrator] weekly_report_due: $WEEKLY_FLAG" >&2
echo "$MANIFEST_FILE"
