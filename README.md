# Scout Workspace

This is the OpenClaw workspace for **Scout**, a signal-monitoring agent that scans technical and editorial sources for substantive updates on agentic payments, account abstraction, and adjacent infrastructure. Outputs land in the Obsidian vault as dated daily signal files.

This file is the operator handbook. Read it first when coming back to the workspace after time away.

## What Scout does

Scout's job is editorial: separate substance from noise, elevate primary sources over commentary, and surface new credible voices to the seed set over time. It is not a market summariser, a news aggregator, or a sentiment tracker. The full identity statement lives in `SOUL.md`; this section is the high-level frame.

Scope:

- Account abstraction (ERC-4337, ERC-7702, ERC-7579, ERC-7710, ERC-7715, ERC-7521, ERC-7683, ERC-8211 and successors)
- Agentic commerce and machine-to-machine payments
- Agent wallets, signing infrastructure, and delegation
- Agent identity, attestation, reputation
- MEV and protocol economics where it intersects with the agent stack
- The intersection of agentic AI and crypto infrastructure

## How the system works

Two halves, decoupled by a JSON manifest:

1. **Collection (scout-signal-scan skill).** Runs on cron at 08:00 UTC. Polls six channels (allowlisted Reddit subs, X List of seed authors, RSS feeds, GitHub releases and EIP commits, arxiv categories, Telegram). Applies hard negative filters at collection time. Enriches each item with metadata flags (EIP references, anchor-domain links, tracked companies, protocols, technical markers). Dedups against a rolling 14-day URL store. Writes a JSON manifest at `/tmp/scout/manifest-YYYY-MM-DD.json` and creates a marker file `/tmp/scout/ready-YYYY-MM-DD.marker`.

2. **Agent processing (Scout itself).** Triggered by the marker file. Reads the manifest. Applies a four-axis scoring framework (content specificity, author shape, network engagement, negative markers). Assigns each surviving item to Tier 0 (primary source), Tier 1 (seed-author), Tier 2 (seed-engaged), or Tier 3 (independent). Applies topic-level dedup against the previous 14 days of signal files. Annotates items that materially connect to Simon's active writing focus per USER.md. Writes the daily file plus a `YYYY-MM-DD_filtered.md` audit file for excluded items. Appends new Tier 3 authors to the rising-authors state. On Sundays, also writes the weekly rising-authors report. Deletes the marker file on success.

The skill is mechanical; the agent is editorial. Neither does the other's job.

## File layout

```
workspace-saorin-scout/
├── README.md                                # this file
├── SOUL.md                                  # Scout's identity (read by agent)
├── AGENTS.md                                # operational rules (read by agent)
├── USER.md                                  # writing focus + hypotheses (read by agent)
│
├── scripts/
│   └── telegram-group-scan.sh               # legacy Telegram collector (called by orchestrator)
│
└── skills/
    ├── reddit-readonly/                     # Reddit API wrapper used by reddit-scan.sh
    │   └── scripts/
    │       └── reddit-readonly.mjs
    │
    └── scout-signal-scan/                   # the main collection skill
        ├── SKILL.md                         # what the skill does, how to invoke
        ├── README.md                        # skill-level architecture and operational notes
        ├── config/
        │   ├── arxiv.json
        │   ├── feeds.json
        │   ├── github-repos.json
        │   ├── negative-filters.json
        │   ├── seed-authors.json            # editorial reference (handle → category)
        │   ├── tracked-entities.json
        │   └── x-list.json                  # X List ID (runtime source for X coverage)
        ├── references/
        │   ├── AGENT_PROMPT.md              # instruction template for agent invocation
        │   ├── MANIFEST_SCHEMA.md           # JSON contract (currently v1.1)
        │   └── SETUP.md                     # dependencies, env vars, install
        └── scripts/
            ├── log-social-signals.sh        # orchestrator (cron entry point)
            ├── reddit-scan.sh               # allowlisted subreddit search
            ├── x-list-scan.sh               # X List (seed authors)
            ├── rss-scan.sh                  # RSS feeds (research, newsletters, blogs, forums)
            ├── github-scan.sh               # GitHub releases + EIP commits
            ├── arxiv-scan.sh                # arxiv categories with keyword filter
            ├── x-seed-scan.sh.retired       # per-handle approach (rollback)
            └── lib/
                ├── filters.sh               # shared negative filtering + metadata
                └── state.sh                 # rolling URL dedup
```

External paths Scout reads from or writes to:

```
/tmp/scout/                                  # ephemeral, created by orchestrator
├── manifest-YYYY-MM-DD.json                 # written by skill, read by agent
└── ready-YYYY-MM-DD.marker                  # trigger flag, deleted by agent

~/.local/share/scout/                        # persistent state
├── seen-urls.jsonl                          # skill-managed, 14-day rolling
└── tier3-authors.jsonl                      # agent-managed, append-only

~/.config/social-scan/                       # secrets
└── .env                                     # X_BEARER_TOKEN, GITHUB_TOKEN

/home/clawdbot/obsidian-vault/Signals/       # agent output
├── YYYY-MM-DD.md                            # daily signal file
├── YYYY-MM-DD_filtered.md                   # excluded-item audit file
└── rising-authors-YYYY-MM-DD.md             # weekly, Sundays only
```

## X seed coverage: the List

Scout's X coverage is driven by a public X List. Editing the List in the X app (web or mobile) changes who Scout watches; no code or config change needed.

- List visibility: **must be public** for bearer-token auth. Private would require OAuth user-context flow which isn't implemented
- List ID is stored in `skills/scout-signal-scan/config/x-list.json`
- The script `x-list-scan.sh` makes a single API call per run, regardless of List size
- `seed-authors.json` is editorial reference only — it provides category labels (aa_standards, agent_payments, etc.) for items where the author handle matches. Handles in the List but not catalogued there get `seed_category: "uncategorised"`. This is informational, not a bug

## Files read by the agent vs by humans

Scout itself reads:

- `SOUL.md` — identity and philosophy
- `AGENTS.md` — operational rules, scoring framework, source-to-tier mapping, output format
- `USER.md` — Simon's writing focus, active hypotheses, tracked companies (used for Connects-to annotations)
- `skills/scout-signal-scan/references/AGENT_PROMPT.md` — instruction template when processing a manifest
- `skills/scout-signal-scan/references/MANIFEST_SCHEMA.md` — for understanding the manifest contract

Humans read:

- This README — workspace operational overview
- `skills/scout-signal-scan/README.md` — skill architecture and operational notes
- `skills/scout-signal-scan/SKILL.md` — what the skill does, how to invoke
- `skills/scout-signal-scan/references/SETUP.md` — install and dependencies

The JSON files in `config/` are read by the skill scripts at runtime and serve as the source of truth for filters, tracked entities, RSS feeds, GitHub repos, arxiv categories, and the X List ID. AGENTS.md documents the editorial intent of these at a category level; the two should be kept in sync but the JSON is operationally authoritative.

## Cron schedule

```cron
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Collection: 08:00 UTC daily
0 8 * * * /usr/bin/flock -n /tmp/scout-collect.lock bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/log-social-signals.sh >> /var/log/scout-collect.log 2>&1
```

A second mechanism (cron, OpenClaw scheduler, or a watch loop) checks for the marker file periodically and invokes Scout with the prompt from `AGENT_PROMPT.md` when one is present.

## Required environment

Secrets at `~/.config/social-scan/.env`:

- `X_BEARER_TOKEN` (required) — X Basic tier or pay-per-use needed for the List Tweets endpoint
- `GITHUB_TOKEN` (recommended) — raises GitHub API rate limit from 60/hour to 5000/hour

The orchestrator sources this file at startup so all child collectors inherit the values.

Other env vars (sensible defaults if unset):

- `OPENCLAW_WORKSPACE` — autodetected if standard
- `SCOUT_SIGNALS_DIR` — Obsidian Signals folder (default: `/home/clawdbot/obsidian-vault/Signals`)
- `SCOUT_MANIFEST_DIR` — manifest output dir (default: `/tmp/scout`)
- `SCOUT_STATE_DIR` — rolling URL/author state (default: `~/.local/share/scout`)
- `SCOUT_SEEN_WINDOW_DAYS` — URL dedup window (default: 14)
- Per-collector windows: `REDDIT_HOURS` (24), `SEED_HOURS` (24), `RSS_HOURS` (48), `GITHUB_HOURS` (24), `ARXIV_HOURS` (48)

## Dependencies

System: bash, jq, curl, python3, node (for the reddit-readonly skill), flock (for cron mutex).

Workspace: `skills/reddit-readonly/` (Reddit API wrapper); `scripts/telegram-group-scan.sh` (legacy Telegram collector, optional).

External: `/home/clawdbot/telegram-sync/` is the dependency for telegram-group-scan.sh; not required for the rest of the pipeline.

## Tokens and tier requirements

- **X API:** Basic tier ($200/month at time of writing, grandfathered) or pay-per-use. Free tier doesn't have access to the List Tweets endpoint. The script makes one API call per run, so volume is trivial regardless of tier.
- **GitHub API:** unauthenticated 60/hour, authenticated 5000/hour. The orchestrator burns 15-25 calls per run, so unauthenticated breaks down quickly on a busy day.
- **Reddit:** no token; uses the reddit-readonly skill which scrapes public JSON endpoints.
- **arxiv, RSS feeds, Telegram:** no tokens, public access.

## Manifest contract (current: v1.1)

The manifest is the contract between the skill and the agent. Schema versioned; current version is 1.1.

Top-level fields: `schema_version`, `captured_at`, `date_utc`, `window_hours` (per-collector), `signals_dir`, `previous_signals_files` (last 14 days), `weekly_report_due` (true on Sundays), `collection_diagnostics`, `items[]`.

Each item has `source`, `subsource`, `url`, `title`, `text`, `author` (with seed flags), `engagement`, `created_at`, `metadata` (with content-specificity flags), and on X items also `expanded_urls`.

Full schema in `skills/scout-signal-scan/references/MANIFEST_SCHEMA.md`. Source-to-tier mapping is documented there.

## What changed in the rebuild

The workspace was rebuilt during a session in May 2026. Major changes from the prior `social-scan-skill` setup:

- **Skill renamed and re-architected.** `social-scan-skill` (also called `social-scan-bd`) is retired; the new skill is `scout-signal-scan`
- **Collection split from scoring.** The old skill produced human-readable output directly. The new skill produces a JSON manifest; the agent does the editorial work
- **Four new collectors.** rss-scan, github-scan, arxiv-scan, and x-list-scan now sit alongside the Reddit collector
- **X keyword search retired.** The old broad X keyword search produced noisy discovery; X coverage is now entirely via the List
- **X List replaces per-handle scanning.** The interim x-seed-scan approach (iterating `seed-authors.json` with ~60 API calls per run) was replaced by reading a public X List with a single API call. Seed curation moves from JSON-on-server to X-UI-on-phone
- **Reddit narrowed to allowlist.** No more site-wide Reddit search; only a small set of substantive subs (r/ethereum, r/ethdev, r/ethfinance, r/ethstaker, r/MachineLearning, r/LocalLLaMA)
- **Tier 0 introduced.** Four tiers now, with primary sources (RSS research, GitHub, arxiv, company blogs) as Tier 0 above the seed-author Tier 1
- **State files.** Rolling URL dedup at `~/.local/share/scout/seen-urls.jsonl`, agent-managed rising-authors state at `tier3-authors.jsonl`
- **Connects-to annotations.** Items that materially extend Simon's writing focus or active hypotheses get a single annotation line per USER.md
- **URL expansion on X.** x-list-scan uses `entities.urls.expanded_url` so anchor-domain detection works on tweets that share external links

## Operational gotchas worth remembering

- **arxiv on weekends.** arxiv doesn't publish Sat/Sun (declared in `<skipDays>` in the feed). Zero items kept from arxiv on those days is expected, not a failure
- **Reddit's tier ceiling.** Reddit items lack seed-authorship and seed-engagement signals. They essentially only ever reach Tier 3, surfacing only on content specificity
- **Link-only tweets.** X tweets that are just a URL return only the URL as text. The API isn't truncating — the author wrote nothing else. Metadata extraction works on whatever the API returns plus expanded URLs; if the substance is behind the link, it won't appear in metadata fields. Use seed authorship and engagement as signal in these cases
- **The X List must be public.** Private Lists would require OAuth user-context auth which isn't implemented. Making the List private will break the collector with a 403
- **EIP pattern allowlist.** The `eip_pattern` in `tracked-entities.json` matches only specific EIPs (4337, 7702, 7579, 7710, 7715, 7521, 7683, 8211, 6900, 6492). Commits to other EIPs in github-scan will show empty `eip_numbers`. Broadening this is on the maintenance list
- **POSIX vs PCRE regex.** Patterns in `negative-filters.json` use POSIX extended regex. No `(?:...)` non-capturing groups; use `(...)`. grep is called with `-E`, not `-P`
- **Wall-clock run time.** Healthy orchestrator run is 60-90 seconds, dominated by RSS fetches. If trending above 180s on cron, check that `.env` is being sourced and run per-collector timing diagnostics
- **Marker file semantics.** The marker is the trigger; the agent deletes it on success. If the agent fails mid-processing, the marker stays and the next trigger re-attempts. Idempotent by design

## Daily quick-start commands

```bash
# Manual collection run
sudo -u clawdbot bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/log-social-signals.sh

# Inspect today's manifest
MANIFEST=/tmp/scout/manifest-$(date -u +%F).json
jq '.collection_diagnostics' $MANIFEST
jq '.items | length' $MANIFEST
jq '[.items[].source] | unique' $MANIFEST

# Test an individual collector
sudo -u clawdbot bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/x-list-scan.sh 24

# Check state
wc -l ~/.local/share/scout/seen-urls.jsonl
tail ~/.local/share/scout/tier3-authors.jsonl

# Check cron health
tail /var/log/scout-collect.log
```

## Pending changes / maintenance backlog

Things flagged during the rebuild that haven't been actioned yet:

- **EIP regex broadening.** `eip_pattern` should be widened from the fixed allowlist to `\b(?:ERC|EIP)-?([0-9]{3,5})\b` so all EIPs populate `eip_numbers`, with the agent doing the tracked-EIP intersection check. The change affects all collectors, not just github-scan; verify across the full pipeline before committing. Slated for review on Thursday.
- **Handle resolution diagnostic.** The retired `x-seed-scan.sh` reported "processed 28/30 handles" without saying which 2 failed. No longer relevant for x-list-scan (single API call), but if you ever revive per-handle scanning, add a one-line stderr message for unresolved handles.
- **`seed-authors.json` currency.** All items in current List runs are `seed_category: "uncategorised"` because the List membership doesn't match the categorised handles. Decide whether to (a) backfill the file with categories for current List members, (b) retire the file entirely, or (c) accept the uncategorised default. Option (a) preserves editorial categorisation; (c) is no-op.
- **Lingering `(?:` patterns.** As of last test, grep warnings still fire from somewhere despite `negative-filters.json` being updated. Run `grep -rn '(?:' /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/config/` to find the remaining offender.
- **Telegram diagnostic improvement.** The current telegram block reports `script_missing`, `no_activity`, `script_failed`, or `ok` with item counts. It doesn't distinguish channels-with-activity-but-no-matching-content from channels-with-no-activity. Low priority but worth refining if Telegram becomes more important.
- **Orchestrator state-filter performance.** `state_filter_new_items` makes sequential jq calls per item. Fine at current ~80 items per run; would drag at 500+. Optimisation not urgent.
- **`tracked-entities.json` company list.** Hasn't been reviewed for currency since the original session. Companies move quickly in this space; some entries may be defunct or have changed names.

## Where to look when something is broken

| Symptom | First place to look |
|---|---|
| Daily signal file missing | `tail /var/log/scout-collect.log`, check marker file exists, check agent was invoked |
| Daily signal file empty | `jq .collection_diagnostics` on the manifest; see which collectors returned zero |
| Cron timed out | Run per-collector timing breakdown; check `.env` is being sourced and cron `PATH` includes `jq`, `python3`, `node` |
| One collector returning nothing | Run it standalone; check stderr for the one-line diagnostic |
| x-list-scan returns 403 | The X List is private or the token is wrong. Confirm List visibility in X UI and verify `X_BEARER_TOKEN` |
| x-list-scan returns empty | Check `list_id` in `config/x-list.json` matches the actual List URL; check List has members; check time window isn't too tight |
| RSS feed returning nothing | `curl -s -w "HTTP %{http_code}, %{size_download} bytes\n" <feed_url>`; URL may have moved |
| GitHub rate-limited | Check `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/rate_limit`; if low, token isn't being read |
| Manifest schema mismatch | Compare `manifest.schema_version` against `MANIFEST_SCHEMA.md`'s declared version |
| Scout surfacing junk | Likely a filter gap; inspect the surfacing item's metadata and either tighten the threshold or add a negative filter |
