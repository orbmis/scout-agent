#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${OPENCLAW_WORKSPACE:-/home/clawdbot/.openclaw/workspace-saorin-scout}"
MANIFEST_DIR="${SCOUT_MANIFEST_DIR:-/tmp/scout}"
DATE_UTC="${1:-$(date -u +%F)}"
COLLECTOR="$WORKSPACE/skills/scout-signal-scan/scripts/log-social-signals.sh"
PROCESSOR="$WORKSPACE/scripts/process-scout-manifest.mjs"
MANIFEST_FILE="$MANIFEST_DIR/manifest-$DATE_UTC.json"
MARKER_FILE="$MANIFEST_DIR/ready-$DATE_UTC.marker"

if [[ ! -x "$COLLECTOR" ]]; then
  echo "collector not executable: $COLLECTOR" >&2
  exit 1
fi
if [[ ! -f "$PROCESSOR" ]]; then
  echo "processor missing: $PROCESSOR" >&2
  exit 1
fi

mkdir -p "$MANIFEST_DIR"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

collector_stdout="$TMP_DIR/collector.out"
collector_stderr="$TMP_DIR/collector.err"
processor_stdout="$TMP_DIR/processor.json"
collection_mode="collected"

if [[ -s "$MANIFEST_FILE" && -e "$MARKER_FILE" ]]; then
  collection_mode="reused_manifest"
  collector_start=$(date +%s)
  collector_end=$collector_start
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
    strongest: $processor[0].strongest
  }'
