# scout-signal-scan setup

## Dependencies

Install on the host running OpenClaw:

```bash
sudo apt-get update
sudo apt-get install -y bash jq curl coreutils python3
```

Node is required only if you still use the legacy `reddit-readonly` skill, which is what `reddit-scan.sh` calls.

## Workspace and Obsidian paths

The orchestrator resolves paths in this order:

| Variable | Default | Purpose |
|---|---|---|
| `OPENCLAW_WORKSPACE` | auto-detected | Scout workspace root |
| `SCOUT_SIGNALS_DIR` | `/home/clawdbot/obsidian-vault/Signals` | where daily signal files land |
| `SCOUT_MANIFEST_DIR` | `/tmp/scout` | where JSON manifests are written |
| `SCOUT_STATE_DIR` | `~/.local/share/scout` | URL dedup + tier3 authors |
| `SCOUT_SEEN_WINDOW_DAYS` | 14 | URL dedup window |

## Secrets

The orchestrator sources `~/.config/social-scan/.env` at startup, so all child collectors inherit the values. Create the file:

```bash
mkdir -p ~/.config/social-scan
cat > ~/.config/social-scan/.env << 'EOF'
X_BEARER_TOKEN=YOUR_X_TOKEN_HERE
GITHUB_TOKEN=YOUR_GITHUB_TOKEN_HERE
EOF
chmod 600 ~/.config/social-scan/.env
```

### X API token

`x-list-scan.sh` uses the `GET /2/lists/:id/tweets` endpoint, which is available on X Basic tier (legacy, grandfathered) and on pay-per-use. Free tier does not have access.

The script makes a single API call per run, so cost is minimal — typically one read per day from a list of ~30 members returns up to 100 tweets per call.

### GitHub token (optional but recommended)

Unauthenticated GitHub API allows 60 requests per hour, which is tight given the number of repos polled (~15-25 calls per orchestrator run). With a token, the limit is 5000 per hour. A fine-grained PAT with read-only `public_repo` scope is sufficient.

## X List setup (one-time)

`x-list-scan.sh` reads from an X List you maintain in the X UI. Set this up before the first run.

1. **Create the List.** In the X web or mobile app, go to Lists and create a new List. Set visibility to **Public**. (Private Lists would require OAuth user-context auth, which Scout does not currently implement.)

2. **Add members.** Add seed authors as members. The seed authors that informed the original architecture are in `config/seed-authors.json` if you want a starting point, but the List membership is what determines who Scout watches — `seed-authors.json` is now editorial reference only, providing category labels for items.

3. **Get the List ID.** Visit the List in a browser. The URL looks like `https://x.com/i/lists/1234567890123456789`. The numeric portion is the List ID.

4. **Update the config.** Edit `config/x-list.json` and replace the placeholder values:

```json
{
  "list_id": "1234567890123456789",
  "list_url": "https://x.com/i/lists/1234567890123456789",
  "list_owner_handle": "your_handle",
  "max_results": 100
}
```

After this, adding or removing seed authors happens in the X app. The next collection run reflects the change without any code or config edits.

## Reddit access

`reddit-scan.sh` uses the existing `reddit-readonly` skill at `$OPENCLAW_WORKSPACE/skills/reddit-readonly/scripts/reddit-readonly.mjs`. No changes needed to that skill.

The Reddit subreddit allowlist is hardcoded in `scripts/reddit-scan.sh` (currently r/ethereum, r/ethdev, r/ethfinance, r/ethstaker, r/MachineLearning, r/LocalLLaMA). To add or remove subs, edit the `ALLOWED_SUBS` array in that script.

## Telegram

`log-social-signals.sh` looks for `$OPENCLAW_WORKSPACE/scripts/telegram-group-scan.sh` and runs it if executable. If absent, the manifest's telegram diagnostic reflects this (`status: "script_missing"`).

## Cron setup

Recommended cadence: 08:00 UTC for collection, 08:30 UTC for agent processing.

```cron
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

0 8 * * * /usr/bin/flock -n /tmp/scout-collect.lock bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/log-social-signals.sh >> /var/log/scout-collect.log 2>&1
```

The agent processing step depends on your OpenClaw deployment. The simplest pattern is a second cron job at 08:30 UTC that:

1. Checks for `/tmp/scout/ready-$(date -u +%F).marker`
2. If present, invokes the agent with the instruction template from `references/AGENT_PROMPT.md`
3. The agent deletes the marker on success

Set `PATH` explicitly at the top of the crontab. Cron's default `PATH` is minimal and may not include `jq`, `python3`, or `node` depending on your system.

## Per-collector time windows

Defaults are set in `log-social-signals.sh` and can be overridden via environment variables in the crontab if needed:

| Variable | Default | Collector |
|---|---|---|
| `REDDIT_HOURS` | 24 | reddit-scan |
| `SEED_HOURS` | 24 | x-list-scan |
| `RSS_HOURS` | 48 | rss-scan |
| `GITHUB_HOURS` | 24 | github-scan |
| `ARXIV_HOURS` | 48 | arxiv-scan |

## State files

After first run, you should see:

```
~/.local/share/scout/seen-urls.jsonl
~/.local/share/scout/tier3-authors.jsonl
```

`seen-urls.jsonl` is pruned to the 14-day window at every run. `tier3-authors.jsonl` is append-only and the agent reads it weekly to produce the rising-authors report.

## Validation

After installing, run the orchestrator once manually and inspect the manifest:

```bash
sudo -u clawdbot bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/log-social-signals.sh
MANIFEST=/tmp/scout/manifest-$(date -u +%F).json
jq '.schema_version, .window_hours, .collection_diagnostics' $MANIFEST
jq '.items | length' $MANIFEST
jq '[.items[].source] | unique' $MANIFEST
jq '.items[0]' $MANIFEST
```

Expected outcomes:

- `schema_version`: `"1.1"`
- `window_hours`: object with five keys (reddit, x_seed, rss, github, arxiv)
- `collection_diagnostics`: shows non-zero `items_kept` for at least reddit, x_seed, and rss; zero for arxiv on weekends; small number for github
- Unique sources: should include `"x-seed"`, `"reddit"`, `"rss"`, `"github"`, and possibly `"arxiv"` and `"telegram"`
- First item: full schema with author, engagement, metadata fields populated

## Per-collector testing

Each collector runs standalone for debugging:

```bash
# X List
sudo -u clawdbot bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/x-list-scan.sh 24

# Reddit
sudo -u clawdbot bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/reddit-scan.sh "" 24

# RSS
sudo -u clawdbot bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/rss-scan.sh 48

# GitHub
sudo -u clawdbot bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/github-scan.sh 24

# arxiv
sudo -u clawdbot bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/arxiv-scan.sh 48
```

Each emits a JSON array to stdout and a one-line diagnostic to stderr.

## Troubleshooting

- **All collectors return empty:** check `OPENCLAW_WORKSPACE` is set and contains `skills/reddit-readonly`. Check X token is readable. Check network access to anchor domains.
- **x-list-scan returns empty with API error:** verify the List exists and is public. Check the `list_id` in `config/x-list.json` matches the URL. A 403 means the List is private or the token is wrong.
- **x-list-scan returns items but all `seed_category: "uncategorised"`:** the handles in your List don't match any in `seed-authors.json`. This is informational, not broken. Either accept it or backfill `seed-authors.json` with categorisation for List members.
- **RSS scan failure on a specific feed:** that feed's URL has likely changed. Update `config/feeds.json`.
- **arxiv returns nothing on a weekday:** the keyword filter may be too strict. Loosen filters in `config/arxiv.json` to debug. Zero items on weekends is normal (arxiv's `<skipDays>`).
- **GitHub returns 403:** rate-limited. Set `GITHUB_TOKEN`.
- **Telegram diagnostic shows `script_missing`:** install or symlink `telegram-group-scan.sh` into the workspace.
- **Lots of `grep: warning: ? at start of expression` in stderr:** a config file contains PCRE-style `(?:...)` non-capturing groups. Find with `grep -rn '(?:' /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/config/`. Replace with `(...)` capturing groups.
- **Cron run times out at 180s while manual runs complete:** check that `~/.config/social-scan/.env` is being sourced. Check cron `PATH` includes `jq`, `python3`, `node`. Run per-collector timing breakdown to identify the bottleneck.
