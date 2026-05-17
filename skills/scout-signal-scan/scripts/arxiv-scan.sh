#!/usr/bin/env bash
set -euo pipefail
# arxiv-scan.sh
# Polls arxiv RSS feeds for configured categories, filters on keywords, emits JSON.
#
# Usage:
#   arxiv-scan.sh <hours>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export SKILL_ROOT
# shellcheck source=./lib/filters.sh
source "$SCRIPT_DIR/lib/filters.sh"
filters_load

HOURS="${1:-24}"
if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then HOURS=24; fi
CUTOFF=$(date -u -d "$HOURS hours ago" +%s)

CFG="$SKILL_ROOT/config/arxiv.json"
BASE=$(jq -r '.base_url' "$CFG")
CATEGORIES=$(jq -r '.categories[]' "$CFG")
KEYWORDS=$(jq -r '.keyword_filter[]' "$CFG")

OUT="[]"
CATS_POLLED=0; ITEMS_KEPT=0

while IFS= read -r cat; do
  CATS_POLLED=$((CATS_POLLED+1))
  body=$(curl -s --max-time 30 -A "scout-arxiv-scan" "$BASE/$cat" 2>/dev/null || echo "")
  if [[ -z "$body" ]]; then continue; fi

  # arxiv RSS has dc:date, title, link, description
  PARSED=$(python3 - <<PY 2>/dev/null
import sys, re, json
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET

xml = """$body"""
try:
    # Strip default namespace for easier matching
    xml_clean = re.sub(r'\\sxmlns="[^"]+"', '', xml, count=1)
    root = ET.fromstring(xml_clean)
except Exception:
    print("[]"); sys.exit(0)

items = []
for it in root.iter('item'):
    title = (it.findtext('title') or "").strip()
    link = (it.findtext('link') or "").strip()
    desc = (it.findtext('description') or "").strip()
    # arxiv uses dc:date
    date_el = None
    for el in it:
        if el.tag.endswith('}date') or el.tag == 'date':
            date_el = el; break
    pub = (date_el.text if date_el is not None else "") or ""
    try:
        from datetime import datetime
        ts = int(datetime.fromisoformat(pub.replace('Z','+00:00')).timestamp()) if pub else 0
    except Exception:
        try:
            ts = int(parsedate_to_datetime(pub).timestamp())
        except Exception:
            ts = 0
    items.append({"title": title, "url": link, "text": desc, "ts": ts})

print(json.dumps(items))
PY
)
  if [[ -z "$PARSED" ]] || ! echo "$PARSED" | jq -e 'type == "array"' >/dev/null 2>&1; then continue; fi

  ICOUNT=$(echo "$PARSED" | jq 'length')
  for ((i=0; i<ICOUNT; i++)); do
    item=$(echo "$PARSED" | jq -c ".[$i]")
    ts=$(echo "$item" | jq -r '.ts // 0')
    if [[ "$ts" != "0" && "$ts" -lt "$CUTOFF" ]]; then continue; fi

    title=$(echo "$item" | jq -r '.title')
    text=$(echo "$item" | jq -r '.text')
    combined="$title $text"

    # Keyword filter: at least one match required
    matched=""
    while IFS= read -r kw; do
      if echo "$combined" | grep -qiF "$kw"; then matched="yes"; break; fi
    done <<< "$KEYWORDS"
    if [[ -z "$matched" ]]; then continue; fi

    if ! filters_text_passes "$combined"; then continue; fi

    url=$(echo "$item" | jq -r '.url')
    created_iso=""
    if [[ "$ts" != "0" ]]; then
      created_iso=$(date -u -d "@$ts" -Iseconds 2>/dev/null || echo "")
    fi
    metadata=$(filters_extract_metadata "$combined")

    entry=$(jq -nc \
      --arg source "arxiv" \
      --arg subsource "arxiv:$cat" \
      --arg url "$url" \
      --arg title "$title" \
      --arg text "$text" \
      --arg created "$created_iso" \
      --argjson metadata "$metadata" \
      '{
        source: $source, subsource: $subsource,
        url: $url, title: $title, text: $text,
        author: { handle: $subsource },
        engagement: {},
        created_at: $created,
        metadata: $metadata
      }')
    OUT=$(echo "$OUT" | jq --argjson e "$entry" '. + [$e]')
    ITEMS_KEPT=$((ITEMS_KEPT+1))
  done
done <<< "$CATEGORIES"

echo "[arxiv-scan] cats_polled=$CATS_POLLED items_kept=$ITEMS_KEPT" >&2
echo "$OUT"
