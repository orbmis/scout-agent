# Scout

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
   │  scout collect   (the mechanical half — no judgement)       │
   │    x · rss · github · arxiv · telegram  →  merge  →  dedup  │
   └─────────────────────────────┬──────────────────────────────┘
                                 │  manifest-YYYY-MM-DD.json  (+ ready-*.marker)
   ┌─────────────────────────────┴──────────────────────────────┐
   │  scout process  (the editorial half — deterministic)        │
   │    score → tier (0–3) → dedup vs 14 days → render Markdown  │
   └─────────────────────────────┬──────────────────────────────┘
                                 │
                Signals/YYYY-MM-DD.md   +   YYYY-MM-DD_filtered.md
```

`scout run` does both (reusing today's manifest if it already exists).

## Project structure

```
scout-agent/
├── bin/scout.mjs            # the only entry point (collect | process | run | diagnose)
├── config/
│   ├── sources.json         # WHAT to collect: X List, seed authors, feeds, repos, arxiv, telegram
│   └── editorial.json       # HOW to judge: tracked entities + negative filters
├── src/
│   ├── config.mjs           # resolves all paths, windows, secrets, loaded config
│   ├── collect.mjs          # collection orchestrator → manifest + marker
│   ├── process.mjs          # editorial engine → daily + filtered files
│   ├── diagnose.mjs         # preflight checks (config, creds, connectivity)
│   ├── collectors/          # one module per source, identical interface
│   │   ├── x.mjs  rss.mjs  github.mjs  arxiv.mjs  telegram.mjs
│   ├── editorial/           # the deterministic editorial engine, split into units
│   │   ├── score.mjs  cluster.mjs  flashbots.mjs  render.mjs
│   ├── lib/                 # shared, injectable building blocks
│   │   ├── http.mjs  feed.mjs  metadata.mjs  filters.mjs  state.mjs  text.mjs
│   └── telegram_fetch.py    # the ONLY Python — a Telethon shim (MTProto needs it)
├── test/                    # node:test suite + fixtures (offline, no credentials)
├── SOUL.md  USER.md  AGENTS.md   # agent-facing identity / writing focus / operating notes
└── SPEC.md                  # the editorial contract + manifest schema
```

Everything except the Telegram shim is Node (ESM, stdlib only — no `npm install`).

## Dependencies

- **Node ≥ 18** (uses global `fetch`, ESM, `node:test`). Nothing else for the
  core pipeline — no third-party npm packages.
- **Python 3 + Telethon** only if you enable the Telegram collector. A dedicated
  venv and an authorized session are required (see [Telegram setup](#telegram-setup)).

## Install

```bash
git clone <this repo> && cd scout-agent
node --version          # confirm >= 18
npm test                # run the offline test suite
```

There is no build step and no dependency install.

## Configure

### Secrets

Create `~/.config/social-scan/.env` (or point `SOCIAL_SCAN_ENV_FILE` elsewhere):

```sh
X_BEARER_TOKEN=...      # required for the X collector (X Basic tier or pay-per-use)
GITHUB_TOKEN=...        # recommended (raises GitHub rate limit 60→5000/hr)
TELEGRAM_API_ID=...     # required only for Telegram (from my.telegram.org)
TELEGRAM_API_HASH=...
```

`scout` loads this file automatically; the host cron can also `source` it.
Without a given credential, that collector degrades cleanly to zero items with
an explicit `status` in the diagnostics — the run still succeeds.

### Sources & editorial rules

- **X coverage** is driven by a public **X List** (`config/sources.json` →
  `x.list_id`). Edit membership in the X app; no code change needed. The List
  must be public for bearer-token auth. `seed_authors` only maps handles to
  editorial categories.
- **Feeds, repos, arxiv categories, telegram channels**: edit
  `config/sources.json`.
- **Tracked entities and negative filters**: edit `config/editorial.json`.
  Patterns are JavaScript regex (not POSIX/grep).

### Environment overrides (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `OPENCLAW_WORKSPACE` | repo root | workspace root (for `USER.md`) |
| `SCOUT_SIGNALS_DIR` | `~/obsidian-vault/Signals` | where signal files are written |
| `SCOUT_MANIFEST_DIR` | `/tmp/scout` | manifest + marker location |
| `SCOUT_STATE_DIR` | `~/.local/share/scout` | rolling URL/author state |
| `SCOUT_SEEN_WINDOW_DAYS` | `14` | URL dedup window |
| `SEED_HOURS` / `RSS_HOURS` / `GITHUB_HOURS` / `ARXIV_HOURS` / `TELEGRAM_HOURS` | 24 / 48 / 24 / 48 / 4 | per-collector lookback |

## Run

```bash
scout diagnose                 # preflight: config, credentials, connectivity
scout collect                  # collect only → writes manifest + marker
scout process <manifest.json>  # editorial only → writes signal files
scout run                      # collect (or reuse today's manifest) then process
```

(or `node bin/scout.mjs <cmd>`, or `npm run <cmd>`). All commands print a JSON
summary to stdout; diagnostics go to stderr.

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
npm test          # offline unit + collector + end-to-end tests (no network, no creds)
scout diagnose    # live: checks bins, paths, credentials, and source connectivity
```

The test suite stubs the HTTP layer (`src/lib/http.mjs`) so collectors and the
editorial engine run fully offline against fixtures in `test/fixtures/`.

## Telegram setup

The Telegram collector shells out to `src/telegram_fetch.py` (Telethon). One-time:

```bash
python3 -m venv ~/.local/share/scout/telegram-venv
~/.local/share/scout/telegram-venv/bin/pip install telethon python-dotenv
# authorize once (interactive), writing a session to ~/.local/share/scout/telegram.session
```

Set `telegram.python_bin`, `telegram.session_path`, and `channels` in
`config/sources.json`. The shim never prompts interactively (safe for cron): if
the session is unauthorized it returns nothing and the run continues.

## Troubleshooting

| Symptom | First check |
|---|---|
| A collector returns 0 | `scout diagnose` — credential or connectivity for that source |
| `x_seed` status `no_token` | `X_BEARER_TOKEN` missing from `~/.config/social-scan/.env` |
| `x` returns 403 | the X List is private, or the token is wrong |
| `telegram` status `venv_missing`/`session_missing` | see [Telegram setup](#telegram-setup) |
| arxiv empty on Sat/Sun | expected — arxiv doesn't publish weekends |
| Signal file empty | inspect `manifest.collection_diagnostics`; see which collectors returned zero |
| Output looks wrong after a config change | `npm test`, then re-run on a saved manifest with `scout process` |

See [`SPEC.md`](SPEC.md) for the manifest schema and the exact scoring/tiering rules.
