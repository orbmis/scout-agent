---
name: scout-signal-scan
description: Run the orchestrated multi-source signal collection pipeline for Scout. Polls allowlisted Reddit subreddits, an X List of seed authors, RSS feeds (research outputs, newsletters, company blogs, forums, core protocol), GitHub releases and EIP commits, arxiv categories with keyword filter, and Telegram. Applies hard negative filters at collection time. Dedups against a rolling 14-day URL store. Emits a JSON manifest the agent processes per AGENTS.md to produce the tiered daily signal file.
---

# scout-signal-scan

Collection pipeline for Scout. The skill **collects and filters**; the agent **scores, tiers, and writes the daily signal file** by reading the manifest this skill produces and following AGENTS.md.

## Daily run

```bash
bash scripts/log-social-signals.sh
```

This orchestrator runs all collectors in sequence, deduplicates against the rolling state store, and writes a JSON manifest to `/tmp/scout/manifest-YYYY-MM-DD.json`. It also touches `/tmp/scout/ready-YYYY-MM-DD.marker` so the agent knows the manifest is ready to process.

Wire this into cron at 08:00 UTC. The agent should be triggered shortly after (08:30 UTC or whenever your OpenClaw scheduler runs) to read the manifest and write the daily signal file per AGENTS.md.

## Collectors

Each can be run standalone for testing or debugging. All emit a JSON array of items to stdout and diagnostics to stderr.

```bash
bash scripts/reddit-scan.sh "<query>" <hours>   # allowlisted subreddits
bash scripts/x-list-scan.sh <hours>             # X List of seed authors
bash scripts/rss-scan.sh <hours>                # RSS feeds (research/newsletters/blogs/forums)
bash scripts/github-scan.sh <hours>             # releases + EIP commits
bash scripts/arxiv-scan.sh <hours>              # arxiv categories with keyword filter
```

## Configuration

All source lists and filters live in `config/`. These are the runtime source of truth for the scripts. AGENTS.md documents the same lists at a category level for the agent's editorial context; keep the two in sync.

- `config/negative-filters.json` — subreddit blocklist, regex patterns, account shape rules. Patterns use POSIX extended regex syntax (no `(?:...)` non-capturing groups; use `(...)` instead)
- `config/tracked-entities.json` — EIPs, protocols, companies, technical markers, anchor domains
- `config/x-list.json` — X List ID and metadata. The List itself, edited in the X app, is the runtime source of truth for who Scout watches on X
- `config/seed-authors.json` — editorial reference mapping X handles to categories (aa_standards, agent_payments, etc.). Used by x-list-scan to enrich items with `seed_category`. Handles in the List but not here get `seed_category: "uncategorised"`
- `config/feeds.json` — RSS feeds with per-source caps and category filters
- `config/github-repos.json` — repos for release watch and EIP file watch
- `config/arxiv.json` — categories and keyword filter

The Reddit allowlist is embedded in `scripts/reddit-scan.sh` rather than a config file, deliberately — it's short, change-controlled, and rarely edited.

## Manifest format

See `references/MANIFEST_SCHEMA.md`. Current schema version: **1.1**. Every field is a factual observation; the skill never emits scores, tier assignments, or interpretations. Those are the agent's job.

## Environment

The orchestrator sources `~/.config/social-scan/.env` at startup, so all child collectors inherit secrets and tokens. Set:

- `X_BEARER_TOKEN` — required for x-list-scan. X Basic tier (or pay-per-use) needed for the List Tweets endpoint
- `GITHUB_TOKEN` — optional but recommended. Raises GitHub API rate limit from 60/hour to 5000/hour

Other variables (with sensible defaults):

- `OPENCLAW_WORKSPACE` — Scout workspace path (auto-detected if standard)
- `SCOUT_SIGNALS_DIR` — Obsidian Signals folder (default: `~/obsidian-vault/Signals`)
- `SCOUT_MANIFEST_DIR` — manifest output dir (default: `/tmp/scout`)
- `SCOUT_STATE_DIR` — rolling URL/author state (default: `~/.local/share/scout`)
- `SCOUT_SEEN_WINDOW_DAYS` — URL dedup window (default: 14)

Per-collector time windows (override via env if needed):

- `REDDIT_HOURS` (default 24)
- `SEED_HOURS` (default 24) — applies to x-list-scan
- `RSS_HOURS` (default 48)
- `GITHUB_HOURS` (default 24)
- `ARXIV_HOURS` (default 48)

Full setup details in `references/SETUP.md`.

## Known behaviour worth understanding

**X List must be public.** `x-list-scan.sh` uses bearer-token (app-only) authentication. Reading a private List requires OAuth user-context flow, which Scout's auth setup does not currently implement. If you make the List private, the script will fail with a 403.

**Link-only tweets have thin metadata.** Tweets that are just a URL (often pointing to an X Article or another tweet) return only the URL as text. The metadata extraction works on whatever text and expanded URLs the API returns; if the substance lives behind the link, it won't appear in the manifest's `metadata` fields. The agent should use `is_seed_author: true` plus `engagement` signals to decide whether to surface these even when metadata is empty.

**arxiv on weekends.** arxiv does not publish new items on Saturdays or Sundays (declared in `<skipDays>` in the feed). Zero items kept from the arxiv collector on Sat/Sun is expected, not a failure.

**Reddit's structural tier ceiling.** Reddit items lack the seed-authorship and seed-engagement signals available on X. Reddit items will essentially only ever reach Tier 3, because the agent's threshold rule requires content specificity alone to clear the bar for Reddit.

**EIP pattern allowlist (under review).** The `eip_pattern` in `config/tracked-entities.json` currently matches only a fixed allowlist of EIP numbers (4337, 7702, 7579, 7710, 7715, 7521, 7683, 8211, 6900, 6492). Commits to other EIPs in the github collector will have `has_eip_reference: false` and empty `eip_numbers`. Broadening the pattern is on the maintenance list.

## What the agent must do with the manifest

The agent (Scout) reads `manifest-YYYY-MM-DD.json` and follows AGENTS.md to:

1. Apply the four-axis scoring framework using manifest metadata
2. Assign Tier 0 (primary source), 1 (seed-author), 2 (seed-engaged), or 3 (independent)
3. Apply topic-level dedup against the prior 14 days of Signals files (listed in the manifest)
4. Add "Connects to" annotations from USER.md hypotheses
5. Write the dated signal file
6. Append unknown high-scoring authors to the tier3-authors state file
7. If `weekly_report_due` is true, also write the rising-authors report

See `references/AGENT_PROMPT.md` for the exact instruction template.

## Diagnostics

The orchestrator captures per-collector stderr and surfaces it in `collection_diagnostics`. Each collector also writes its own diagnostic line to stderr when run standalone, e.g.:

```
[reddit-scan] subs_polled=6 successful=6 raw=42 kept=18
[x-list-scan] tweets_returned=97 kept=10 dropped_timewindow=86 dropped_filters=1
[rss-scan] feeds_polled=27 successful=26 failed=1
[github-scan] repos_polled=10 releases=0 eip_changes=2
[arxiv-scan] cats_polled=4 items_kept=0
```

Total wall-clock for a healthy run is typically 60-90 seconds, dominated by RSS fetches. x-list-scan completes in a few seconds (single API call) compared to ~24 seconds for the retired x-seed-scan's per-handle approach. If runs trend above 180s on cron, check `~/.config/social-scan/.env` is being sourced and individual collector timings via the per-collector test invocations.

## Notes for reuse

- The skill is workspace-aware. Other OpenClaw instances should set `OPENCLAW_WORKSPACE`
- Negative filters are intentionally hard blocks. Editing requires changing the JSON config, which is the right level of friction
- Per-source RSS caps prevent any single feed dominating the manifest
- The Defiant feed is filtered to its Blockchains category only (see feeds.json)
- All scripts surface diagnostics to stderr; the orchestrator captures these into the manifest's `collection_diagnostics`
- Adding a new X account to watch: add them to the List in the X app. No code or config edit needed unless you want them categorised (in which case add to `seed-authors.json`)

