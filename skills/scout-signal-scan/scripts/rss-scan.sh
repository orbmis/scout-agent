#!/usr/bin/env bash
set -euo pipefail
# rss-scan.sh
# Polls all configured RSS feeds, filters to window, applies negative regex, emits JSON array.
#
# Usage:
#   rss-scan.sh <hours>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export SKILL_ROOT
# shellcheck source=./lib/filters.sh
source "$SCRIPT_DIR/lib/filters.sh"
filters_load

HOURS="${1:-24}"
if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then HOURS=24; fi

FEEDS_FILE="$SKILL_ROOT/config/feeds.json"
CUTOFF=$(date -u -d "$HOURS hours ago" +%s)

# Flatten all feed categories into one list with their group
FEEDS=$(jq -c '
  [
    (.research_outputs[]? + {group: "research_outputs"}),
    (.newsletters[]?      + {group: "newsletters"}),
    (.core_protocol[]?    + {group: "core_protocol"}),
    (.company_blogs[]?    + {group: "company_blogs"}),
    (.forums[]?           + {group: "forums"})
  ]
' "$FEEDS_FILE")

OUT="[]"
FEED_COUNT=$(echo "$FEEDS" | jq 'length')
SUCCESS=0; FAILED=0

for ((i=0; i<FEED_COUNT; i++)); do
  feed=$(echo "$FEEDS" | jq -c ".[$i]")
  name=$(echo "$feed" | jq -r '.name')
  url=$(echo "$feed" | jq -r '.url')
  group=$(echo "$feed" | jq -r '.group')
  max_items=$(echo "$feed" | jq -r '.max_items_per_run // 10')
  category_filter=$(echo "$feed" | jq -r '.category_filter // empty')
  url_path_filter=$(echo "$feed" | jq -r '.url_path_filter // empty')
  tag=$(echo "$feed" | jq -r '.tag // empty')

  body=$(curl -s --max-time 30 -L -A "Mozilla/5.0 (Scout RSS poller)" "$url" 2>/dev/null || echo "")
  if [[ -z "$body" ]]; then FAILED=$((FAILED+1)); continue; fi

  # Parse with python; bash + RSS is a losing battle
  PARSED=$(python3 - <<PY 2>/dev/null
import sys, re, json
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET

xml = """$body"""
try:
    # Strip default namespaces to make tag matching saner
    xml_clean = re.sub(r'\\sxmlns="[^"]+"', '', xml, count=1)
    root = ET.fromstring(xml_clean)
except Exception as e:
    print("[]")
    sys.exit(0)

items = []
# RSS 2.0
for it in root.iter('item'):
    title = (it.findtext('title') or "").strip()
    link = (it.findtext('link') or "").strip()
    desc = (it.findtext('description') or "").strip()
    pub = it.findtext('pubDate') or ""
    categories = [c.text for c in it.findall('category') if c.text]
    try:
        dt = parsedate_to_datetime(pub) if pub else None
        ts = int(dt.timestamp()) if dt else 0
    except Exception:
        ts = 0
    items.append({"title": title, "url": link, "text": desc, "categories": categories, "ts": ts})

# Atom
for it in root.iter('{http://www.w3.org/2005/Atom}entry'):
    title = (it.findtext('{http://www.w3.org/2005/Atom}title') or "").strip()
    link_el = it.find('{http://www.w3.org/2005/Atom}link')
    link = link_el.get('href') if link_el is not None else ""
    summary = (it.findtext('{http://www.w3.org/2005/Atom}summary') or "").strip()
    content = (it.findtext('{http://www.w3.org/2005/Atom}content') or "").strip()
    pub = it.findtext('{http://www.w3.org/2005/Atom}published') or it.findtext('{http://www.w3.org/2005/Atom}updated') or ""
    try:
        from datetime import datetime
        ts = int(datetime.fromisoformat(pub.replace('Z','+00:00')).timestamp()) if pub else 0
    except Exception:
        ts = 0
    items.append({"title": title, "url": link, "text": summary or content, "categories": [], "ts": ts})

# Also handle root without 'item' namespace (some Atom feeds without namespace)
if not items:
    for it in root.iter('entry'):
        title = (it.findtext('title') or "").strip()
        link_el = it.find('link')
        link = (link_el.get('href') if link_el is not None and link_el.get('href') else (it.findtext('link') or "")).strip()
        summary = (it.findtext('summary') or it.findtext('content') or "").strip()
        items.append({"title": title, "url": link, "text": summary, "categories": [], "ts": 0})

print(json.dumps(items))
PY
)
  if [[ -z "$PARSED" ]] || ! echo "$PARSED" | jq -e 'type == "array"' >/dev/null 2>&1; then
    FAILED=$((FAILED+1))
    continue
  fi
  SUCCESS=$((SUCCESS+1))

  ICOUNT=$(echo "$PARSED" | jq 'length')
  kept_for_feed=0
  for ((j=0; j<ICOUNT && kept_for_feed<max_items; j++)); do
    item=$(echo "$PARSED" | jq -c ".[$j]")
    ts=$(echo "$item" | jq -r '.ts // 0')
    if [[ "$ts" != "0" && "$ts" -lt "$CUTOFF" ]]; then continue; fi

    title=$(echo "$item" | jq -r '.title')
    url=$(echo "$item" | jq -r '.url')
    text=$(echo "$item" | jq -r '.text')

    # Category filter (Defiant etc.)
    if [[ -n "$category_filter" ]]; then
      has_cat=$(echo "$item" | jq -r --arg c "$category_filter" '.categories[]? | select(. == $c)' | head -1)
      url_has_path="false"
      if [[ -n "$url_path_filter" ]] && echo "$url" | grep -qF "$url_path_filter"; then url_has_path="true"; fi
      if [[ -z "$has_cat" && "$url_has_path" != "true" ]]; then continue; fi
    fi

    # Hard negative filter
    combined="$title $text"
    if ! filters_text_passes "$combined"; then continue; fi

    created_iso=""
    if [[ "$ts" != "0" ]]; then
      created_iso=$(date -u -d "@$ts" -Iseconds 2>/dev/null || echo "")
    fi
    metadata=$(filters_extract_metadata "$combined")

    entry=$(jq -nc \
      --arg source "rss" \
      --arg subsource "$name" \
      --arg group "$group" \
      --arg tag "$tag" \
      --arg url "$url" \
      --arg title "$title" \
      --arg text "$text" \
      --arg created "$created_iso" \
      --argjson metadata "$metadata" \
      '{
        source: $source, subsource: $subsource, group: $group, tag: $tag,
        url: $url, title: $title, text: $text,
        author: { handle: $subsource },
        engagement: {},
        created_at: $created,
        metadata: $metadata
      }')
    OUT=$(echo "$OUT" | jq --argjson e "$entry" '. + [$e]')
    kept_for_feed=$((kept_for_feed+1))
  done
done

echo "[rss-scan] feeds_polled=$FEED_COUNT successful=$SUCCESS failed=$FAILED" >&2
echo "$OUT"
