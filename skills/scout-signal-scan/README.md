# scout-signal-scan

OpenClaw skill that produces a structured, deduplicated JSON manifest of recent signal candidates across Reddit, X, RSS feeds, GitHub, arxiv, and Telegram, for Scout to score and tier per AGENTS.md.

The skill **collects, filters, enriches, and emits a manifest**. The agent **scores, tiers, dedupes by topic, and writes the daily signal file**. The manifest is the contract between them.

## Architecture

```
              cron (08:00 UTC)
                    │
                    ▼
    ┌────────────────────────────────┐
    │  log-social-signals.sh         │
    │  (orchestrator, sources .env)  │
    └──────────┬─────────────────────┘
               │
   ┌───────────┼───────────┬──────────┬─────────────┬──────────┐
   ▼           ▼           ▼          ▼             ▼          ▼
reddit-scan  x-seed     rss-scan   github-scan   arxiv-scan  telegram
(allowlist)  (handles)  (feeds)    (releases/    (categories) (legacy)
                                    EIPs)
   │           │           │          │             │          │
   └───────────┴───────────┴──────────┴─────────────┴──────────┘
                                │
                          merge + URL dedup
                                │
                                ▼
               /tmp/scout/manifest-YYYY-MM-DD.json
                                │
                          (marker file)
                                │
                                ▼
                  agent (Scout) per AGENTS.md
                                │
                                ▼
         /Signals/YYYY-MM-DD.md (tiered output)
```

## Folder structure

```
scout-signal-scan/
├── SKILL.md
├── README.md
├── config/
│   ├── arxiv.json
│   ├── feeds.json
│   ├── github-repos.json
│   ├── negative-filters.json
│   ├── seed-authors.json
│   └── tracked-entities.json
├── references/
│   ├── SETUP.md
│   ├── MANIFEST_SCHEMA.md
│   └── AGENT_PROMPT.md
└── scripts/
    ├── log-social-signals.sh      # orchestrator (cron entry point)
    ├── reddit-scan.sh             # allowlisted subreddit search
    ├── x-seed-scan.sh             # X seed-author timelines
    ├── rss-scan.sh                # RSS feeds
    ├── github-scan.sh             # releases + EIP commits
    ├── arxiv-scan.sh              # arxiv categories with keyword filter
    └── lib/
        ├── filters.sh             # shared negative filtering + metadata
        └── state.sh               # rolling URL dedup
```

## Collectors

| Collector | Source | Window default | Notes |
|---|---|---|---|
| reddit-scan | r/ethereum, r/ethdev, r/ethfinance, r/ethstaker, r/MachineLearning, r/LocalLLaMA | 24h | Allowlisted subs only; query passed from orchestrator. Allowlist is in the script, not a config file |
| x-seed-scan | seed-authors.json | 24h | Pulls recent timelines per seed handle. Requires X Basic tier |
| rss-scan | feeds.json | 48h | 27 feeds across research outputs, newsletters, company blogs, forums, core protocol |
| github-scan | github-repos.json | 24h | Releases across tracked repos + commits to ethereum/EIPs |
| arxiv-scan | arxiv.json | 48h | cs.CR, cs.DC, cs.MA, cs.GT with keyword filter. Silent on weekends (arxiv's `<skipDays>`) |
| telegram | legacy script in workspace | 4h | Optional; runs only if `$WORKSPACE/scripts/telegram-group-scan.sh` is executable |

## What changed in the current iteration

The skill replaces an earlier `social-scan-skill` (also called `social-scan-bd`). Architectural shift:

- **Collection vs scoring split.** The old skill produced human-readable output directly. The new skill produces a JSON manifest; the agent does scoring, tiering, and topic-level dedup
- **Source diversification.** Old: Reddit + X keyword + Telegram. New: allowlisted Reddit + X seed timelines + RSS + GitHub + arxiv + Telegram
- **Hard negative filters applied at collection.** Subreddit blocklist, ticker regex, pump phrases, account shape rules — items violating these never reach the manifest
- **Metadata enrichment.** Each item carries flags for EIP references, anchor-domain links, tracked companies, tracked protocols, technical markers, code blocks
- **State-based URL dedup.** Rolling 14-day window prevents the same URL surfacing twice across runs
- **Manifest contract.** Schema versioned (currently 1.1); fields are factual observations, not interpretations

The keyword-based X search from the old skill was retired during validation — it duplicated seed-scan for known accounts and produced noisy discovery for unknowns. X coverage is now entirely via `x-seed-scan.sh`.

## What stays the agent's job

The skill never:

- Scores items
- Assigns tiers
- Clusters by topic (that needs prior Signals files; the agent has those)
- Annotates "Connects to" against USER.md
- Writes the final daily signal file
- Writes the weekly rising-authors report

All of that is the agent's editorial work, governed by AGENTS.md. The skill's contract is: every item in the manifest has observable, deterministic metadata that the agent can score against; no item that violates a hard negative filter ever appears.

## Manifest contract

See `references/MANIFEST_SCHEMA.md`. Current schema version: **1.1**.

Schema 1.1 changes from 1.0:

- `source: "x"` removed (keyword X search retired); X items now always have `source: "x-seed"`
- `collection_diagnostics.social_keyword` renamed to `collection_diagnostics.reddit`
- `window_hours` expanded to per-collector windows rather than a single value

## Setup

See `references/SETUP.md`.

Key dependencies: bash, jq, curl, python3, and (for Reddit) the existing `reddit-readonly` skill at `$OPENCLAW_WORKSPACE/skills/reddit-readonly/scripts/reddit-readonly.mjs`.

Secrets live in `~/.config/social-scan/.env` and are sourced by the orchestrator so all child collectors inherit them. Set `X_BEARER_TOKEN` (required) and `GITHUB_TOKEN` (recommended; raises rate limit from 60/hour to 5000/hour).

## Agent invocation

See `references/AGENT_PROMPT.md` for the instruction template the agent uses when processing a fresh manifest.

## Operational notes

- Healthy run wall-clock: 60-120 seconds, dominated by RSS fetches
- Healthy diagnostics: each collector emits a one-line summary to stderr; the orchestrator captures these into `collection_diagnostics`
- Empty arxiv results on Sat/Sun are expected (arxiv doesn't publish weekends)
- Reddit items will essentially only ever reach Tier 3 — the seed-authorship and seed-engagement signals available on X aren't structurally available on Reddit, so Reddit items must clear the threshold on content specificity alone
- Negative-filter regex patterns use POSIX extended regex; no `(?:...)` non-capturing groups. The lib calls grep with `-E`, which doesn't support PCRE syntax
