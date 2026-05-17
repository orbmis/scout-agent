#!/usr/bin/env bash
set -euo pipefail
# github-scan.sh
# Polls GitHub for releases on tracked repos + new EIP files in ethereum/EIPs.
# Emits JSON array of items to stdout.
#
# Usage:
#   github-scan.sh <hours>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export SKILL_ROOT
# shellcheck source=./lib/filters.sh
source "$SCRIPT_DIR/lib/filters.sh"
filters_load

HOURS="${1:-24}"
if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then HOURS=24; fi
CUTOFF_TS=$(date -u -d "$HOURS hours ago" +%s)
CUTOFF_ISO=$(date -u -d "$HOURS hours ago" +"%Y-%m-%dT%H:%M:%SZ")

REPOS_FILE="$SKILL_ROOT/config/github-repos.json"

AUTH_HEADER=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi
COMMON_HEADERS=(-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -H "User-Agent: scout-github-scan")

OUT="[]"
REPOS_POLLED=0
RELEASES_FOUND=0
EIP_CHANGES=0

# ----- Release watch -----
RCOUNT=$(jq '.release_watch | length' "$REPOS_FILE")
for ((i=0; i<RCOUNT; i++)); do
  repo_json=$(jq -c ".release_watch[$i]" "$REPOS_FILE")
  owner=$(echo "$repo_json" | jq -r '.owner')
  repo=$(echo "$repo_json" | jq -r '.repo')
  REPOS_POLLED=$((REPOS_POLLED+1))

  response=$(curl -s --max-time 30 "${COMMON_HEADERS[@]}" "${AUTH_HEADER[@]}" \
    "https://api.github.com/repos/$owner/$repo/releases?per_page=5" 2>/dev/null || echo "[]")
  if ! echo "$response" | jq -e 'type == "array"' >/dev/null 2>&1; then continue; fi

  count=$(echo "$response" | jq 'length')
  for ((j=0; j<count; j++)); do
    rel=$(echo "$response" | jq -c ".[$j]")
    published=$(echo "$rel" | jq -r '.published_at // .created_at // ""')
    if [[ -z "$published" ]]; then continue; fi
    pub_ts=$(date -u -d "$published" +%s 2>/dev/null || echo 0)
    if [[ "$pub_ts" -lt "$CUTOFF_TS" ]]; then continue; fi

    name=$(echo "$rel" | jq -r '.name // .tag_name // ""')
    tag=$(echo "$rel" | jq -r '.tag_name // ""')
    url=$(echo "$rel" | jq -r '.html_url')
    body=$(echo "$rel" | jq -r '.body // ""')
    text="$name $body"

    if ! filters_text_passes "$text"; then continue; fi

    metadata=$(filters_extract_metadata "$text")
    RELEASES_FOUND=$((RELEASES_FOUND+1))

    entry=$(jq -nc \
      --arg source "github" \
      --arg subsource "$owner/$repo" \
      --arg event "release" \
      --arg url "$url" \
      --arg title "Release: $name ($tag)" \
      --arg text "$text" \
      --arg created "$published" \
      --argjson metadata "$metadata" \
      '{
        source: $source, subsource: $subsource, event: $event,
        url: $url, title: $title, text: $text,
        author: { handle: $subsource },
        engagement: {},
        created_at: $created,
        metadata: $metadata
      }')
    OUT=$(echo "$OUT" | jq --argjson e "$entry" '. + [$e]')
  done
done

# ----- EIP repo: new files in EIPS/ -----
EIP_OWNER=$(jq -r '.eip_repo.owner' "$REPOS_FILE")
EIP_REPO=$(jq -r '.eip_repo.repo' "$REPOS_FILE")

# Get commits to EIPS/ within window
commits=$(curl -s --max-time 30 "${COMMON_HEADERS[@]}" "${AUTH_HEADER[@]}" \
  "https://api.github.com/repos/$EIP_OWNER/$EIP_REPO/commits?path=EIPS&since=$CUTOFF_ISO&per_page=30" 2>/dev/null || echo "[]")
if echo "$commits" | jq -e 'type == "array"' >/dev/null 2>&1; then
  ccount=$(echo "$commits" | jq 'length')
  for ((k=0; k<ccount; k++)); do
    sha=$(echo "$commits" | jq -r ".[$k].sha")
    detail=$(curl -s --max-time 30 "${COMMON_HEADERS[@]}" "${AUTH_HEADER[@]}" \
      "https://api.github.com/repos/$EIP_OWNER/$EIP_REPO/commits/$sha" 2>/dev/null || echo "{}")
    msg=$(echo "$detail" | jq -r '.commit.message // ""')
    files=$(echo "$detail" | jq -c '[.files[]? | select(.filename | startswith("EIPS/")) | {filename, status}]')
    fcount=$(echo "$files" | jq 'length')
    if [[ "$fcount" == "0" ]]; then continue; fi

    author=$(echo "$detail" | jq -r '.commit.author.name // ""')
    when=$(echo "$detail" | jq -r '.commit.author.date // ""')

    # Description includes commit message and file changes
    file_summary=$(echo "$files" | jq -r '.[] | "- " + .status + ": " + .filename' | head -20)
    text="$msg"$'\n'"$file_summary"

    if ! filters_text_passes "$text"; then continue; fi
    metadata=$(filters_extract_metadata "$text")
    EIP_CHANGES=$((EIP_CHANGES+1))

    url="https://github.com/$EIP_OWNER/$EIP_REPO/commit/$sha"
    title=$(echo "$msg" | head -1)
    entry=$(jq -nc \
      --arg source "github" \
      --arg subsource "$EIP_OWNER/$EIP_REPO" \
      --arg event "eip-commit" \
      --arg url "$url" \
      --arg title "EIPs commit: $title" \
      --arg text "$text" \
      --arg created "$when" \
      --arg author "$author" \
      --argjson metadata "$metadata" \
      '{
        source: $source, subsource: $subsource, event: $event,
        url: $url, title: $title, text: $text,
        author: { handle: $author },
        engagement: {},
        created_at: $created,
        metadata: $metadata
      }')
    OUT=$(echo "$OUT" | jq --argjson e "$entry" '. + [$e]')
  done
fi

echo "[github-scan] repos_polled=$REPOS_POLLED releases=$RELEASES_FOUND eip_changes=$EIP_CHANGES" >&2
echo "$OUT"
