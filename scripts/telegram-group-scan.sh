#!/usr/bin/env bash
set -euo pipefail

HOURS="${1:-4}"
WORKDIR="${OPENCLAW_WORKSPACE:-/home/clawdbot/.openclaw/workspace-saorin-scout}"
TG_SYNC_DIR="/home/clawdbot/telegram-sync"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CSV_OUT="$TMP_DIR/telegram_groups.csv"
JSON_OUT="$TMP_DIR/telegram_groups.json"

if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then
  HOURS=4
fi

cd "$TG_SYNC_DIR"
export PYTHONPATH="$TG_SYNC_DIR/src"
PYTHON_BIN="$TG_SYNC_DIR/.venv/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "- Telegram scan unavailable (.venv python missing)"
  exit 0
fi

"$PYTHON_BIN" src/tg_folk_logger/group_activity.py \
  --group ERC8004 \
  --group erc8183 \
  --hours "$HOURS" \
  --timezone UTC \
  --output "$CSV_OUT" \
  --json-output "$JSON_OUT" >/dev/null

if [[ -f "$JSON_OUT" ]]; then
  python3 - <<'PY' "$JSON_OUT"
import json, sys
p = sys.argv[1]
rows = json.load(open(p))
if not rows:
    print('- No Telegram messages found in selected channels')
    raise SystemExit(0)
for row in rows[:10]:
    sender = row.get('sender_username') or row.get('sender_name') or 'unknown'
    group = row.get('group_title') or row.get('group_input') or 'unknown'
    text = (row.get('message_text') or '').replace('\n', ' ').strip()
    print(f"- [{group}] {sender}: {text[:180]}")
PY
else
  echo "- Telegram scan unavailable"
fi
