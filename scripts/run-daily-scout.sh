#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${OPENCLAW_WORKSPACE:-/home/clawdbot/.openclaw/workspace-saorin-scout}"
MANIFEST_DIR="${SCOUT_MANIFEST_DIR:-/tmp/scout}"
DATE_UTC="${1:-$(date -u +%F)}"
FORCE_COLLECT="${SCOUT_FORCE_COLLECT:-0}"
COLLECTOR="$WORKSPACE/skills/scout-signal-scan/scripts/log-social-signals.sh"
PROCESSOR="$WORKSPACE/scripts/process-scout-manifest.mjs"
MANIFEST_FILE="$MANIFEST_DIR/manifest-$DATE_UTC.json"
MARKER_FILE="$MANIFEST_DIR/ready-$DATE_UTC.marker"
DEFAULT_SIGNALS_DIR="/home/clawdbot/obsidian-vault/Signals"

if [[ ! -x "$COLLECTOR" ]]; then
  echo "collector not executable: $COLLECTOR" >&2
  exit 1
fi
if [[ ! -f "$PROCESSOR" ]]; then
  echo "processor missing: $PROCESSOR" >&2
  exit 1
fi

prune_old_filtered_files() {
  local signals_dir="$1"
  [[ -d "$signals_dir" ]] || return 0

  local cutoff
  cutoff=$(date -u -d "$DATE_UTC -7 days" +%F)

  local file base file_date
  shopt -s nullglob
  for file in "$signals_dir"/*_filtered.md; do
    base=$(basename "$file")
    file_date="${base%%_filtered.md}"
    if [[ "$file_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$file_date" < "$cutoff" ]]; then
      rm -f "$file"
    fi
  done
  shopt -u nullglob
}

mkdir -p "$MANIFEST_DIR"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

collector_stdout="$TMP_DIR/collector.out"
collector_stderr="$TMP_DIR/collector.err"
processor_stdout="$TMP_DIR/processor.json"
collection_mode="collected"

if [[ "$FORCE_COLLECT" != "1" && -s "$MANIFEST_FILE" && -f "$MARKER_FILE" ]]; then
  collection_mode="reused_manifest"
  collector_start=$(date +%s)
  collector_end=$collector_start
elif [[ "$FORCE_COLLECT" != "1" && -s "$MANIFEST_FILE" && ! -f "$MARKER_FILE" ]]; then
  jq -n \
    --arg date_utc "$DATE_UTC" \
    --arg manifest "$MANIFEST_FILE" \
    '{
      date_utc: $date_utc,
      manifest: $manifest,
      skipped: true,
      skip_reason: "manifest_exists_without_marker"
    }'
  exit 0
else
  collector_start=$(date +%s)
  bash "$COLLECTOR" >"$collector_stdout" 2>"$collector_stderr"
  collector_end=$(date +%s)
fi

if [[ ! -s "$MANIFEST_FILE" ]]; then
  echo "manifest missing after collection: $MANIFEST_FILE" >&2
  exit 1
fi

processor_start=$(date +%s)
node "$PROCESSOR" "$MANIFEST_FILE" >"$processor_stdout"
processor_end=$(date +%s)

jq -e 'type == "object"' "$processor_stdout" >/dev/null

SIGNALS_DIR=$(jq -r '.signals_dir // empty' "$MANIFEST_FILE")
if [[ -z "$SIGNALS_DIR" || "$SIGNALS_DIR" == "null" ]]; then
  SIGNALS_DIR="$DEFAULT_SIGNALS_DIR"
fi
prune_old_filtered_files "$SIGNALS_DIR"

rm -f "$MARKER_FILE"

jq -n \
  --arg date_utc "$DATE_UTC" \
  --arg manifest "$MANIFEST_FILE" \
  --arg collection_mode "$collection_mode" \
  --argjson collector_seconds "$((collector_end - collector_start))" \
  --argjson processor_seconds "$((processor_end - processor_start))" \
  --slurpfile processor "$processor_stdout" \
  --slurpfile manifest_json "$MANIFEST_FILE" \
  '{
    date_utc: $date_utc,
    manifest: $manifest,
    collection_mode: $collection_mode,
    collector_seconds: $collector_seconds,
    processor_seconds: $processor_seconds,
    collection_diagnostics: $manifest_json[0].collection_diagnostics,
    dailyPath: $processor[0].dailyPath,
    filteredPath: $processor[0].filteredPath,
    risingWritten: $processor[0].risingWritten,
    risingAuthorsPath: $processor[0].risingAuthorsPath,
    keptCount: $processor[0].keptCount,
    filteredCount: $processor[0].filteredCount,
    strongest: $processor[0].strongest,
    summary: (
      "Daily scan completed.\n\n"
      + "Daily note: "
      + ($processor[0].dailyPath | split("/") | last)
      + "\nFiltered note: "
      + ($processor[0].filteredPath | split("/") | last)
      + "\n\nKept "
      + ($processor[0].keptCount | tostring)
      + ", filtered "
      + ($processor[0].filteredCount | tostring)
      + ". Collection mode "
      + $collection_mode
      + ". Collector "
      + ($collector_seconds | tostring)
      + "s, processor "
      + ($processor_seconds | tostring)
      + "s.\n\n"
      + (
          if (($processor[0].strongest | length) > 0) then
            "Strongest signals:\n"
            + (($processor[0].strongest
                | map("- Tier " + (.tier | tostring) + ": " + .title + " — " + .url))
                | join("\n"))
            + "\n\n"
          else
            "No signals cleared into the final note.\n\n"
          end
        )
      + "Diagnostics: X seed "
      + (($manifest_json[0].collection_diagnostics.x_seed.items_kept // 0) | tostring)
      + ", RSS "
      + (($manifest_json[0].collection_diagnostics.rss.items_kept // 0) | tostring)
      + ", GitHub "
      + (($manifest_json[0].collection_diagnostics.github.items_kept // 0) | tostring)
      + ", arXiv "
      + (($manifest_json[0].collection_diagnostics.arxiv.items_kept // 0) | tostring)
      + ", Telegram status "
      + (($manifest_json[0].collection_diagnostics.telegram.status // "unknown") | tostring)
      + " with "
      + (($manifest_json[0].collection_diagnostics.telegram.items_kept // 0) | tostring)
      + " kept item(s) across "
      + (($manifest_json[0].collection_diagnostics.telegram.channels_scanned // 0) | tostring)
      + " scanned channel(s), and dedup reduced candidates from "
      + (($manifest_json[0].collection_diagnostics.dedup.total_before // 0) | tostring)
      + " to "
      + (($manifest_json[0].collection_diagnostics.dedup.total_after // 0) | tostring)
      + "."
    )
  }'
