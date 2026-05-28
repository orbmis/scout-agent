#!/usr/bin/env bash
set -euo pipefail
# telegram-scan.sh
# Reads recent messages from configured Telegram channels via the in-skill
# telegram_fetch.py (Telethon). No external telegram-sync dependency.
# Applies negative filters and metadata enrichment, emits JSON array.
#
# Requires (see references/SETUP.md):
#   - a venv with telethon installed (path in config python_bin)
#   - TELEGRAM_API_ID / TELEGRAM_API_HASH in env (from ~/.config/social-scan/.env)
#   - an authorized Telethon session at config session_path
#
# Usage:
#   telegram-scan.sh <hours>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export SKILL_ROOT
# shellcheck source=./lib/filters.sh
source "$SCRIPT_DIR/lib/filters.sh"
filters_load

HOURS="${1:-24}"
if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then HOURS=24; fi

CFG="$SKILL_ROOT/config/telegram-channels.json"
FETCH_PY="$SCRIPT_DIR/lib/telegram_fetch.py"

if [[ ! -f "$CFG" ]]; then
  echo "[telegram-scan] missing config: $CFG" >&2
  echo "[]"; exit 0
fi
if [[ ! -f "$FETCH_PY" ]]; then
  echo "[telegram-scan] missing $FETCH_PY" >&2
  echo "[]"; exit 0
fi

# Resolve config values, expanding a leading ~ to $HOME
expand_tilde() { local p="$1"; echo "${p/#\~/$HOME}"; }

PYTHON_BIN=$(expand_tilde "$(jq -r '.python_bin' "$CFG")")
SESSION_PATH=$(expand_tilde "$(jq -r '.session_path' "$CFG")")
MAX_ITEMS=$(jq -r '.max_items_per_run // 25' "$CFG")

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "[telegram-scan] python venv not found at $PYTHON_BIN; skipping" >&2
  echo "[]"; exit 0
fi
if [[ ! -f "$SESSION_PATH.session" ]]; then
  echo "[telegram-scan] no authorized session at $SESSION_PATH.session; run interactive login once (see SETUP.md)" >&2
  echo "[]"; exit 0
fi

# Build --group args from config
GROUP_ARGS=()
while IFS= read -r grp; do
  GROUP_ARGS+=(--group "$grp")
done < <(jq -r '.channels[].group' "$CFG")
if [[ ${#GROUP_ARGS[@]} -eq 0 ]]; then
  echo "[telegram-scan] no channels configured" >&2
  echo "[]"; exit 0
fi
CHANNEL_COUNT=$((${#GROUP_ARGS[@]} / 2))

# Fetch (JSON array on stdout)
ROWS=$("$PYTHON_BIN" "$FETCH_PY" \
  "${GROUP_ARGS[@]}" \
  --hours "$HOURS" \
  --timezone UTC \
  --session "$SESSION_PATH" 2>/tmp/scout-telegram.err) || {
    echo "[telegram-scan] telegram_fetch.py failed" >&2
    cat /tmp/scout-telegram.err >&2 || true
    echo "[]"; exit 0
  }
# Surface python stderr diagnostics
cat /tmp/scout-telegram.err >&2 || true

if ! echo "$ROWS" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "[telegram-scan] output not a JSON array" >&2
  echo "[]"; exit 0
fi

ROW_COUNT=$(echo "$ROWS" | jq 'length')
CHANNELS_WITH_ACTIVITY=$(echo "$ROWS" | jq 'map(.group_title // .group_input) | unique | length')
OUT="[]"
KEPT=0

for ((i=0; i<ROW_COUNT && KEPT<MAX_ITEMS; i++)); do
  row=$(echo "$ROWS" | jq -c ".[$i]")
  text=$(echo "$row" | jq -r '.message_text // ""')
  [[ -z "$text" ]] && continue

  if ! filters_text_passes "$text"; then continue; fi
  if filters_is_noise_reply "$text"; then continue; fi

  group=$(echo "$row" | jq -r '.group_title // .group_input // "unknown"')
  group_handle=$(echo "$row" | jq -r '.group_input // empty')
  sender=$(echo "$row" | jq -r '.sender_username // .sender_name // "unknown"')
  msg_id=$(echo "$row" | jq -r '.message_id // empty')
  created_iso=$(echo "$row" | jq -r '.message_datetime_iso // empty')

  url=""
  if [[ -n "$group_handle" && -n "$msg_id" ]]; then
    url="https://t.me/$group_handle/$msg_id"
  fi

  metadata=$(filters_extract_metadata "$text")

  entry=$(jq -nc \
    --arg source "telegram" \
    --arg subsource "@$group" \
    --arg url "$url" \
    --arg text "$text" \
    --arg sender "$sender" \
    --arg created "$created_iso" \
    --argjson metadata "$metadata" \
    '{
      source: $source, subsource: $subsource,
      url: $url, title: "", text: $text,
      author: { handle: $sender },
      engagement: {},
      created_at: $created,
      metadata: $metadata
    }')
  OUT=$(echo "$OUT" | jq --argjson e "$entry" '. + [$e]')
  KEPT=$((KEPT+1))
done

echo "[telegram-scan] channels=$CHANNEL_COUNT rows=$ROW_COUNT channels_with_activity=$CHANNELS_WITH_ACTIVITY kept=$KEPT" >&2
echo "$OUT"
