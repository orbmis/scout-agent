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

state_filter_new_items_no_mark() {
  # Reads JSON array from stdin, writes array containing only items whose .url is not in seen-urls.
  # Does not mutate the seen state; callers can commit after successful downstream writes.
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
    kept=$(echo "$kept" | jq --argjson it "$item" '. + [$it]')
  done
  echo "$kept"
}

state_partition_items_no_mark() {
  # Reads JSON array from stdin and returns an object with kept and deduped arrays.
  # Does not mutate the seen state; callers can commit after successful downstream writes.
  state_init
  state_prune_seen_urls

  local input
  input=$(cat)
  local count
  count=$(echo "$input" | jq 'length')
  local kept_file deduped_file
  kept_file=$(mktemp)
  deduped_file=$(mktemp)
  trap 'rm -f "$kept_file" "$deduped_file"' RETURN
  for ((i=0; i<count; i++)); do
    local item url
    item=$(echo "$input" | jq -c ".[$i]")
    url=$(echo "$item" | jq -r '.url // empty')
    if [[ -z "$url" ]]; then
      printf '%s\n' "$item" >> "$kept_file"
      continue
    fi
    if state_seen_url "$url"; then
      printf '%s\n' "$item" >> "$deduped_file"
      continue
    fi
    printf '%s\n' "$item" >> "$kept_file"
  done

  local kept_json deduped_json
  if [[ -s "$kept_file" ]]; then
    kept_json=$(jq -s '.' "$kept_file")
  else
    kept_json='[]'
  fi

  if [[ -s "$deduped_file" ]]; then
    deduped_json=$(jq -s '.' "$deduped_file")
  else
    deduped_json='[]'
  fi

  printf '{"kept":%s,"deduped":%s}\n' "$kept_json" "$deduped_json"
}

state_mark_urls_from_items() {
  # Reads JSON array from stdin and records each non-empty .url as seen.
  state_init

  local input
  input=$(cat)
  local count
  count=$(echo "$input" | jq 'length')
  for ((i=0; i<count; i++)); do
    local url
    url=$(echo "$input" | jq -r ".[$i].url // empty")
    if [[ -n "$url" ]]; then
      state_mark_url_seen "$url"
    fi
  done
}
