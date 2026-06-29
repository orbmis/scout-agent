# Scout

[![CI](https://github.com/orbmis/scout-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/orbmis/scout-agent/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-blue)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4)](https://prettier.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Scout is a daily **signal-monitoring agent**. It scans technical and editorial
sources for substantive developments in agentic payments, account abstraction,
agent wallets, and adjacent crypto infrastructure, then writes dated Markdown
signal files. Its job is editorial: separate substance from noise, elevate
primary sources over commentary, and surface new credible authors over time.

It is **not** a news aggregator, market summariser, or sentiment tracker.

- **What Scout is** (identity & philosophy): [`SOUL.md`](SOUL.md)
- **How it decides** (scoring, tiers, manifest contract): [`SPEC.md`](SPEC.md)
- **Who it serves** (writing focus driving annotations): [`USER.md`](USER.md)

## How it works

Two decoupled halves joined by a JSON **manifest**:

```
                 config/sources.json        config/editorial.json
                         │                          │
   ┌─────────────────────┴──────────────────────────┴───────────┐
   │  scout collect   (the mechanical half — no judgement)      │
   │       x · rss · github · arxiv  →  merge  →  dedup         │
   └─────────────────────────────┬──────────────────────────────┘
                                 │  manifest-YYYY-MM-DD.json  (+ ready-*.marker)
   ┌─────────────────────────────┴──────────────────────────────┐
   │  scout process  (the editorial half — deterministic)       │
   │    score → tier (0–3) → dedup vs 14 days → render Markdown │
   └─────────────────────────────┬──────────────────────────────┘
                                 │
                Signals/YYYY-MM-DD.md   +   YYYY-MM-DD_filtered.md
```

`scout run` does both (reusing today's manifest if it already exists).

## Project structure

```
scout-agent/
├── bin/scout.mjs            # the only entry point (collect | process | run | diagnose | doctor | selftest)
├── config/
│   ├── sources.json         # WHAT to collect: X List, seed authors, feeds, repos, arxiv
│   └── editorial.json       # HOW to judge: tracked entities + negative filters
├── src/
│   ├── config.mjs           # resolves all paths, windows, secrets, loaded config
│   ├── collect.mjs          # collection orchestrator → manifest + marker
│   ├── process.mjs          # editorial engine → daily + filtered files
│   ├── diagnose.mjs         # preflight checks (config, creds, connectivity)
│   ├── collectors/          # one module per source, identical interface
│   │   ├── x.mjs  rss.mjs  github.mjs  arxiv.mjs
│   ├── editorial/           # the deterministic editorial engine, split into units
│   │   ├── score.mjs  cluster.mjs  flashbots.mjs  render.mjs
│   └── lib/                 # shared, injectable building blocks
│       ├── http.mjs  feed.mjs  metadata.mjs  filters.mjs  state.mjs  text.mjs
├── test/                    # node:test suite + fixtures (offline, no credentials)
├── SOUL.md  USER.md  AGENTS.md   # agent-facing identity / writing focus / operating notes
└── SPEC.md                  # the editorial contract + manifest schema
```

The pipeline is 100% Node (ESM, stdlib only — **zero runtime dependencies**).

## Dependencies

- **Node ≥ 18** for the pipeline (uses global `fetch`, ESM, `node:test`). No
  third-party runtime packages.
- **Dev-only** tooling for contributors: ESLint + Prettier (installed with
  `npm install`; they ship nothing at runtime).

## Install

```bash
git clone <this repo> && cd scout-agent
node --version          # confirm >= 18
npm install             # dev tooling only (ESLint/Prettier); the pipeline itself needs none
npm test                # run the offline test suite
```

The pipeline has no build step and no runtime dependencies; `npm install` only
pulls the dev linters/formatters.

## Configure

### Secrets

Create `~/.config/social-scan/.env` (or point `SOCIAL_SCAN_ENV_FILE` elsewhere):

```sh
X_BEARER_TOKEN=...      # required for the X collector (X Basic tier or pay-per-use)
GITHUB_TOKEN=...        # recommended (raises GitHub rate limit 60→5000/hr)
```

`scout` loads this file automatically; the host cron can also `source` it.
Without a given credential, that collector degrades cleanly to zero items with
an explicit `status` in the diagnostics — the run still succeeds.

### Sources & editorial rules

- **X coverage** is driven by a public **X List** (`config/sources.json` →
  `x.list_id`). Edit membership in the X app; no code change needed. The List
  must be public for bearer-token auth. `seed_authors` only maps handles to
  editorial categories.
- **Feeds, repos, arxiv categories**: edit `config/sources.json`.
- **Tracked entities and negative filters**: edit `config/editorial.json`.
  Patterns are JavaScript regex (not POSIX/grep).

### Environment overrides (all optional)

| Variable                                                    | Default                    | Purpose                        |
| ----------------------------------------------------------- | -------------------------- | ------------------------------ |
| `OPENCLAW_WORKSPACE`                                        | repo root                  | workspace root (for `USER.md`) |
| `SCOUT_SIGNALS_DIR`                                         | `~/obsidian-vault/Signals` | where signal files are written |
| `SCOUT_MANIFEST_DIR`                                        | `/tmp/scout`               | manifest + marker location     |
| `SCOUT_STATE_DIR`                                           | `~/.local/share/scout`     | rolling URL/author state       |
| `SCOUT_SEEN_WINDOW_DAYS`                                    | `14`                       | URL dedup window               |
| `SEED_HOURS` / `RSS_HOURS` / `GITHUB_HOURS` / `ARXIV_HOURS` | 24 / 48 / 24 / 48          | per-collector lookback         |

## Run

```bash
scout diagnose                 # fast preflight: config, credentials, connectivity
scout doctor                   # deep per-source diagnosis with remediations
scout collect [--report f]     # collect only → writes manifest + marker
scout process <manifest.json>  # editorial only → writes signal files
scout run [--report f]         # collect (or reuse today's manifest) then process
scout selftest                 # offline golden proof of the editorial pipeline
```

(or `node bin/scout.mjs <cmd>`, or `npm run <cmd>`). All commands print a JSON
summary to stdout and exit non-zero on failure (`diagnose`/`doctor` when not
healthy, `collect`/`run` on a hard collection failure, `selftest` on a golden
mismatch). Useful flags: `--report <path>` writes the run report; `--now <iso|ms>`
pins the clock for reproducible runs.

Every `collect`/`run` also writes a machine-readable health report to
`$SCOUT_STATE_DIR/last-run.json` — per-collector counts, statuses, timings, and
`warnings[]` (e.g. `slow_run`, `collector_error`, `zero_items_all_sources`). This
is the single artifact both humans and CI read.

### Scheduling

Run `scout collect` on cron (the project ran at 08:00 UTC), then trigger
`scout process` (or `scout run`) when the marker appears:

```cron
0 8 * * * /usr/bin/flock -n /tmp/scout-collect.lock node /path/to/scout-agent/bin/scout.mjs collect >> /var/log/scout.log 2>&1
```

The marker (`ready-YYYY-MM-DD.marker`) is the trigger; `process` deletes it on
success. If processing fails the marker remains and the next trigger retries —
idempotent by design.

## Test & diagnose

```bash
npm test            # offline unit + collector + integration tests (no network, no creds)
npm run test:coverage   # same, with a coverage report
npm run lint        # ESLint
npm run format      # Prettier --write (use format:check in CI)
scout selftest      # one-command offline proof of the editorial pipeline (golden diff)
scout diagnose      # live: bins, paths, credentials, source connectivity
scout doctor        # live: per-feed reachability, GitHub rate limit, X List visibility
npm run live        # live end-to-end smoke test in a throwaway sandbox (add `-- --keep` to inspect)
```

The offline suite stubs the HTTP layer (`src/lib/http.mjs`) so collectors and the
editorial engine run fully offline against fixtures in `test/fixtures/`. To
refresh fixtures from live data, run any collector with
`SCOUT_HTTP_MODE=record SCOUT_HTTP_FIXTURES=<dir>`, then replay with
`SCOUT_HTTP_MODE=replay`.

`npm run live` is the **full live end-to-end test**: it runs the real
collect→process pipeline against live sources in an isolated sandbox (so the real
vault and dedup state are never touched), asserts the run report (public sources
reachable with items, the X collector healthy when a token is present, outputs
written, no errors), prints a verdict, and exits non-zero on failure. Use it on a
host with `~/.config/social-scan/.env` to exercise the credentialed X collector —
the part the secret-free `/live-test` CI canary deliberately can't cover.

**CI workflows:**

- `ci.yml` — lint + format check + tests (coverage) + `selftest` on Node 18/20, every push and PR.
- `gitleaks.yml` — fails if a credential is committed.
- `live-test.yml` — a **public-source live canary** when a maintainer comments
  `/live-test` on a PR: collects from RSS/GitHub/arxiv (no secrets), asserts the
  run report, posts the result as a comment.
- `dependabot.yml` — weekly update PRs for the dev tooling and the GitHub Actions.

Editing the golden manifest? regenerate with `SCOUT_SELFTEST_UPDATE=1 scout selftest`.

## Troubleshooting

| Symptom                                  | First check                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| A collector returns 0                    | `scout diagnose` — credential or connectivity for that source                 |
| `x_seed` status `no_token`               | `X_BEARER_TOKEN` missing from `~/.config/social-scan/.env`                    |
| `x` returns 403                          | the X List is private, or the token is wrong                                  |
| arxiv empty on Sat/Sun                   | expected — arxiv doesn't publish weekends                                     |
| Signal file empty                        | inspect `manifest.collection_diagnostics`; see which collectors returned zero |
| Output looks wrong after a config change | `npm test`, then re-run on a saved manifest with `scout process`              |

See [`SPEC.md`](SPEC.md) for the manifest schema and the exact scoring/tiering rules.
