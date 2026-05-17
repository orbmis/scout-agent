# scout-signal-scan setup

## Dependencies

Install on the host running OpenClaw:

```bash
sudo apt-get update
sudo apt-get install -y bash jq curl coreutils python3
```

Node is required only if you still use the legacy `reddit-readonly` skill, which is what `social-scan-portable.sh` calls.

## Workspace and Obsidian paths

The orchestrator resolves paths in this order:

| Variable | Default | Purpose |
|---|---|---|
| `OPENCLAW_WORKSPACE` | auto-detected | Scout workspace root |
| `SCOUT_SIGNALS_DIR` | `/home/clawdbot/obsidian-vault/Signals` | where daily signal files land |
| `SCOUT_MANIFEST_DIR` | `/tmp/scout` | where JSON manifests are written |
| `SCOUT_STATE_DIR` | `~/.local/share/scout` | URL dedup + tier3 authors |
| `SCOUT_SEEN_WINDOW_DAYS` | 14 | URL dedup window |

## X API token

Either:

```bash
mkdir -p ~/.config/social-scan
cat > ~/.config/social-scan/.env << 'EOF'
X_BEARER_TOKEN=YOUR_TOKEN_HERE
EOF
```

or:

```bash
mkdir -p ~/.config/social-scan
printf 'YOUR_TOKEN_HERE\n' > ~/.config/social-scan/x-bearer-token.txt
```

The seed-author scanner uses roughly 2 API calls per seed handle per run (user lookup + recent tweets). For 30 handles that's 60 calls. X Basic tier (recent search + user lookup) accommodates this comfortably. Free tier does not have access to the user timeline endpoint.

## GitHub token (optional but recommended)

```bash
export GITHUB_TOKEN=ghp_yourtoken
```

Unauthenticated GitHub API allows 60 requests per hour, which is tight given the number of repos polled. With a token (any scope), the limit is 5000 per hour.

## Reddit access

`social-scan-portable.sh` uses the existing `reddit-readonly` skill at `$OPENCLAW_WORKSPACE/skills/reddit-readonly/scripts/reddit-readonly.mjs`. No changes needed to that skill.

## Telegram

`log-social-signals.sh` looks for `$OPENCLAW_WORKSPACE/scripts/telegram-group-scan.sh` and runs it if executable. If absent, the manifest's telegram diagnostic reflects this (`status: "script_missing"`).

## Cron setup

Recommended cadence: 08:00 UTC for collection, 08:30 UTC for agent processing.

```cron
0 8 * * * /usr/bin/flock -n /tmp/scout-collect.lock bash /home/clawdbot/.openclaw/workspace-saorin-scout/skills/scout-signal-scan/scripts/log-social-signals.sh >> /var/log/scout-collect.log 2>&1
```

The agent processing step depends on your OpenClaw deployment. The simplest pattern is a second cron job at 08:30 UTC that:

1. Checks for `/tmp/scout/ready-$(date -u +%F).marker`
2. If present, invokes the agent with the instruction template from `references/AGENT_PROMPT.md`
3. The agent deletes the marker on success

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
bash scripts/log-social-signals.sh
cat /tmp/scout/manifest-$(date -u +%F).json | jq '.collection_diagnostics'
cat /tmp/scout/manifest-$(date -u +%F).json | jq '.items | length'
cat /tmp/scout/manifest-$(date -u +%F).json | jq '.items[0]'
```

You should see diagnostics for each collector, a non-zero item count (unless you've already run today and dedup caught everything), and a well-formed item with full author and metadata fields.

## Troubleshooting

- **All collectors return empty:** check `OPENCLAW_WORKSPACE` is set and contains `skills/reddit-readonly`. Check X token is readable. Check network access to anchor domains.
- **RSS scan failure on a specific feed:** that feed's URL has likely changed. Update `config/feeds.json`.
- **arxiv returns nothing:** the keyword filter may be too strict, or recent submissions in those categories may not match. Loosen filters in `config/arxiv.json` to debug.
- **GitHub returns 403:** rate-limited. Set `GITHUB_TOKEN`.
- **Telegram diagnostic shows `script_missing`:** install or symlink `telegram-group-scan.sh` into the workspace.
