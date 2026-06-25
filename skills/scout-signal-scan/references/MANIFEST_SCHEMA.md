# Manifest schema (v1.0)

The manifest is the contract between this skill and the Scout agent. The skill commits to providing every field listed here, deterministically. The agent commits to reading only these fields and adding no interpretation that isn't supported by them.

## Top level

```json
{
  "schema_version": "1.2",
  "captured_at": "2026-05-16T08:00:12Z",
  "date_utc": "2026-05-16",
  "window_hours": { "social": 24 },
  "signals_dir": "/home/clawdbot/obsidian-vault/Signals",
  "previous_signals_files": [
    "/home/clawdbot/obsidian-vault/Signals/2026-05-15.md",
    "..."
  ],
  "weekly_report_due": false,
  "collection_diagnostics": { "...": "..." },
  "collection_filtered": {
    "url_dedup": [ "..." ]
  },
  "items": [ "..." ]
}
```

- **schema_version** — bump when fields change incompatibly
- **previous_signals_files** — last 14 days of dated files for the agent's topic-level dedup
- **weekly_report_due** — true on Sundays; the agent should also write the rising-authors report
- **collection_filtered.url_dedup** — raw items removed by the collector's rolling 14-day URL dedup, preserved for audit output

## Item shape

```json
{
  "source": "x" | "x-seed" | "rss" | "github" | "arxiv" | "telegram",
  "subsource": "@VitalikButerin" | "r/ethereum" | "ethresear.ch - Account Abstraction" | "ethereum/EIPs" | "arxiv:cs.CR" | "...",
  "group": "research_outputs" | "newsletters" | "core_protocol" | "company_blogs" | "forums",
  "tag": "newsletter" | "",
  "event": "release" | "eip-commit" | "",
  "url": "https://...",
  "title": "...",
  "text": "full text or description",
  "author": {
    "handle": "...",
    "display_name": "...",
    "bio": "...",
    "account_age_days": 1843,
    "followers": 12400,
    "is_seed_author": true,
    "seed_category": "aa_standards"
  },
  "engagement": {
    "likes": 42,
    "reposts": 8,
    "replies": 3,
    "quotes": 1,
    "seed_engaged_by": []
  },
  "created_at": "2026-05-15T07:23:11Z",
  "metadata": {
    "has_eip_reference": true,
    "eip_numbers": [4337, 7702],
    "has_code_block": false,
    "anchor_domain_links": ["eips.ethereum.org"],
    "tracked_companies": ["Crossmint"],
    "tracked_protocols": ["x402"],
    "technical_markers": ["smart wallet", "session key"]
  }
}
```

Fields not applicable to a given source may be omitted or empty. For example, RSS items have no `engagement`; GitHub release items have `event: "release"`; arxiv items have empty author handle (the subsource carries the category).

## Source-to-tier mapping (for agent reference)

The agent assigns tiers per AGENTS.md. The default mapping:

- `source: rss` with `group: research_outputs` or `group: core_protocol` or `group: forums` → **Tier 0** (primary source)
- `source: github` → **Tier 0** (primary source)
- `source: arxiv` → **Tier 0** (primary source)
- `source: rss` with `group: company_blogs` → **Tier 0** (primary source from a tracked builder)
- `source: rss` with `tag: newsletter` → **Tier 0** but flagged as pre-filtered (apply lower content-specificity weight)
- `source: x-seed` (always `is_seed_author: true`) → **Tier 1**
- `source: x` with `is_seed_author: true` → **Tier 1**
- `source: x` with `seed_engaged_by` non-empty → **Tier 2**
- `source: x` independent → **Tier 3** (must clear scoring threshold)
- `source: telegram` → **Tier 2 or 3** depending on engagement context

This mapping is a default; AGENTS.md may refine it.

## Diagnostics shape

```json
{
  "social_keyword": { "items_kept": 12 },
  "x_seed":        { "items_kept": 47 },
  "rss":           { "items_kept": 23 },
  "github":        { "items_kept": 3 },
  "arxiv":         { "items_kept": 1 },
  "telegram":      { "channels_scanned": -1, "channels_with_activity": 0, "items_kept": 0, "status": "no_activity" },
  "dedup":         { "total_before": 86, "total_after": 64 }
}
```

The agent should surface diagnostic context in the daily signal file's empty-tier handling (per AGENTS.md), not just say "no items found".

## Hard contract rules

1. **The skill never scores, tiers, or interprets.** Every `metadata` field is an observable presence/absence check.
2. **The skill applies hard negative filters at collection time.** Items violating ticker patterns, or pump-phrase patterns never appear in the manifest.
3. **The skill applies URL dedup against a rolling 14-day window.** Items already seen do not appear in the items array.
   They are recorded under collection_filtered.url_dedup for auditability.
4. **The skill does not apply topic-level dedup.** That requires reading prior Signals files, which is the agent's job.
5. **Manifest fields are stable.** Adding new fields is a minor version bump (1.1); changing or removing fields is a major bump.
