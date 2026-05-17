#!/usr/bin/env bash
# lib/state.sh
# Persistent state for Scout. URL dedup over rolling 14d window; tier3-author tracking.

STATE_DIR="${SCOUT_STATE_DIR:-$HOME/.local/share/scout}"
SEEN_URLS_FILE="$STATE_DIR/seen-urls.jsonl"
TIER3_AUTHORS_FILE="$STATE_DIR/tier3-authors.jsonl"
SEEN_WINDOW_DAYS="${SCOUT_SEEN_WINDOW_DAYS:-14}"

state_init() {
  mkdir -p "$STATE_DIR"
  : >> "$SEEN_URLS_FILE"
  : >> "$TIER3_AUTHORS_FILE"
}

state_seen_url() {
  # Args: url
  # Returns 0 if URL was seen within the window, 1 otherwise
  local url="$1"
  local cutoff
  cutoff=$(date -u -d "$SEEN_WINDOW_DAYS days ago" +%s)
  awk -F'\t' -v u="$url" -v c="$cutoff" '
    $2 == u && $1 + 0 >= c { found=1; exit }
    END { exit (found ? 0 : 1) }
  ' "$SEEN_URLS_FILE"
}

state_mark_url_seen() {
  # Args: url
  local url="$1"
  local ts
  ts=$(date -u +%s)
  printf "%s\t%s\n" "$ts" "$url" >> "$SEEN_URLS_FILE"
}

state_prune_seen_urls() {
  # Drop entries older than the window
  local cutoff
  cutoff=$(date -u -d "$SEEN_WINDOW_DAYS days ago" +%s)
  local tmp
  tmp=$(mktemp)
  awk -F'\t' -v c="$cutoff" '$1 + 0 >= c' "$SEEN_URLS_FILE" > "$tmp" && mv "$tmp" "$SEEN_URLS_FILE"
}

state_filter_new_items() {
  # Reads JSON array from stdin, writes array containing only items whose .url is not in seen-urls
  # Marks new URLs as seen as a side effect.
  state_init
  state_prune_seen_urls

  local input
  input=$(cat)
  local count
  count=$(echo "$input" | jq 'length')
  local kept="[]"
  for ((i=0; i<count; i++)); do
    local item url
    item=$(echo "$input" | jq -c ".[$i]")
    url=$(echo "$item" | jq -r '.url // empty')
    if [[ -z "$url" ]]; then
      kept=$(echo "$kept" | jq --argjson it "$item" '. + [$it]')
      continue
    fi
    if state_seen_url "$url"; then
      continue
    fi
    state_mark_url_seen "$url"
    kept=$(echo "$kept" | jq --argjson it "$item" '. + [$it]')
  done
  echo "$kept"
}
