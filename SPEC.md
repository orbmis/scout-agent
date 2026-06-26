# Scout specification

The implementation in `src/` is the source of truth. This document explains the
contract and the editorial policy it implements, so a reader can understand and
modify the code with intent. Where prose and code disagree, the code wins.

## The manifest (schema 1.1)

The manifest is the only interface between collection (`scout collect`) and the
editorial engine (`scout process`). Written to
`$SCOUT_MANIFEST_DIR/manifest-YYYY-MM-DD.json`.

```jsonc
{
  "schema_version": "1.1",
  "captured_at": "2026-06-25T08:00:00Z",
  "date_utc": "2026-06-25",
  "window_hours": { "x_seed": 24, "rss": 48, "github": 24, "arxiv": 48 },
  "signals_dir": "/path/to/Signals",
  "previous_signals_files": ["…/2026-06-20.md", …],   // dated files, last 14 days
  "weekly_report_due": false,                          // true on Sundays (UTC)
  "collection_diagnostics": { … },                     // per-collector counts + status
  "items": [ Item, … ]
}
```

### Item shape

```jsonc
{
  "source": "x-seed" | "rss" | "github" | "arxiv",
  "subsource": "@handle" | "Feed Name" | "owner/repo" | "arxiv:cs.CR",
  "group": "research_outputs|newsletters|core_protocol|company_blogs|forums", // rss only
  "tag": "newsletter",                                  // rss only, optional
  "event": "release" | "eip-commit",                   // github only
  "url": "https://…",
  "title": "…",
  "text": "…",
  "author": {
    "handle": "…", "display_name": "…", "bio": "…",
    "account_age_days": 0, "followers": 0,
    "is_seed_author": true, "seed_category": "aa_standards"   // x-seed only
  },
  "engagement": { "likes": 0, "reposts": 0, "replies": 0, "quotes": 0,
                  "seed_engaged_by": [] },               // counts; x-seed-relevant
  "created_at": "ISO-8601",
  "metadata": {                                          // content-specificity flags
    "has_eip_reference": false, "eip_numbers": [],
    "has_code_block": false, "anchor_domain_links": [],
    "tracked_companies": [], "tracked_protocols": [], "technical_markers": []
  },
  "expanded_urls": []                                    // x-seed only (t.co expansion)
}
```

`metadata` is computed at collection time by `src/lib/metadata.mjs` from
`config/editorial.json → tracked`. It is the raw material for scoring.

The manifest is validated against `src/lib/manifest-schema.mjs` before it is
written (collection) and before it is consumed (processing); a malformed manifest
fails loudly with the offending field path.

## The run report (`last-run.json`)

Every `collect`/`run` writes `$SCOUT_STATE_DIR/last-run.json` (`src/report.mjs`):
per-collector `{items, status, ms}`, dedup before/after, timings, and `warnings[]`
(`slow_run` > 180s, `collector_error`, `zero_items_all_sources`). `ok` is false
only on a hard failure (every collector errored). This is what `scout` exit codes,
the `/live-test` canary, and humans all read. `canaryVerdict()` derives the
public-source pass/fail (RSS/GitHub/arxiv reachable and non-empty).

## Collection

The mechanical half. Each collector (`src/collectors/*.mjs`) shares one interface
— `collect({ windowHours, sources, secrets, filters, metadata, http }) →
{ items, diag }` — and:

1. Fetches within its lookback window via the injected `http` layer.
2. Applies **hard negative filters** (`config/editorial.json → negative`):
   tickers, pump phrases, emoji spam, promo CTAs. (`src/lib/filters.mjs`)
3. Enriches each item with `metadata`.
4. Returns items + a diagnostics object; failures degrade to `[]` with a status.

The orchestrator (`src/collect.mjs`) merges all collectors, dedups against a
rolling 14-day URL store (`src/lib/state.mjs`), writes the manifest, then commits
the seen-URL state **after** the manifest is safely written.

Hard filters are applied **once, here**. The editorial engine never re-applies them.

## Editorial scoring (`src/editorial/score.mjs`)

Each item gets a composite score across four axes, plus a topical gate.

- **Content specificity (+):** anchor-domain links (+3), tracked EIP reference
  (+3), tracked protocols (+2), tracked companies (+1), technical markers
  (+ up to 2), code block (+1), source bonuses (github +2, non-newsletter RSS +1),
  on-topic keywords (+2).
- **Author shape (+):** `is_seed_author` (+2), account age > 1y (+1) / > 5y
  (+0.5), large following with on-topic bio (+0.5).
- **Network engagement (+):** `seed_engaged_by` non-empty (+3) is the strongest;
  quote/repost/total-engagement thresholds add fractions. Raw counts alone are weak.
- **Negative markers (−):** engagement-farming, RT-without-substance, link-only
  tweets, event promos, and a set of topic-specific demotions.

**Topical gate:** an item must reach `topical ≥ 2` **and** clear a source
threshold (`4` for github/rss, `5` otherwise), **and** carry at least one
_required anchor signal_ — one of: github/arxiv source; RSS from a primary group;
non-empty `anchor_domain_links`; `seed_engaged_by`; `is_seed_author`; or ≥2 strong
content-specificity flags. Items satisfying none never surface, regardless of score.

Each item is labelled `weak | moderate | strong` with a dominant axis.

## Tiers (`src/editorial/cluster.mjs → assignTier`)

| Tier                    | Meaning                            | Rule                                                                               |
| ----------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| **0 — Primary Source**  | read first                         | RSS from research/core/forums/company groups or any newsletter; all github & arxiv |
| **1 — Seed-Set Signal** | "what people I trust say"          | `author.is_seed_author`                                                            |
| **2 — Seed-Adjacent**   | "what they're paying attention to" | `engagement.seed_engaged_by` non-empty                                             |
| **3 — Independent**     | "who don't I know yet"             | everything else that clears threshold; feeds rising-authors                        |

## Dedup

- **Intra-day clustering:** items covering the same development collapse to the
  strongest one. Primary sources key on URL; X items key on EIP / topic buckets
  and per-author time bursts (`topicKeyFor`, `threadClusterKey`).
- **Cross-day:** an item is dropped if a signal file from the last 14 days
  (`previous_signals_files`) already covered the same URL, title, or EIP thread
  without materially new detail (`dedupAgainstPrevious`).
- **Flashbots newsletter:** its RSS body bundles many links; `flashbots.mjs`
  expands it into the individual signals it references before scoring.

## Outputs

Written to `signals_dir` every run:

- **`YYYY-MM-DD.md`** — the daily file: tiered entries (source, author, link,
  engagement, summary, why-it-matters, score, dominant axis, optional
  "Connects to …" annotation), then collection diagnostics, then an editorial note.
  Empty tiers state _why_ using the diagnostics, never a bare "no items".
- **`YYYY-MM-DD_filtered.md`** — every excluded item with its exclusion class
  (`below_threshold`, `missing_anchor_signal`, `topic_dedup`,
  `collapsed_to_cluster`), reason, and scoring note. For auditing/tuning.
- **`rising-authors-YYYY-MM-DD.md`** — on Sundays only.

New Tier-3 authors are appended to `$SCOUT_STATE_DIR/tier3-authors.jsonl` for the
weekly rising-authors workflow.

## State files

| File                  | Owner     | Purpose                                             |
| --------------------- | --------- | --------------------------------------------------- |
| `seen-urls.tsv`       | `collect` | `ts⇥url`, rolling 14-day URL dedup, pruned each run |
| `tier3-authors.jsonl` | `process` | append-only log of Tier-3 appearances               |

## Tracked scope (config/editorial.json)

Account abstraction EIPs (4337, 7702, 7579, 7710, 7715, 7521, 7683, 8211, plus
6900/6492 in the match pattern); agent-payment protocols (x402, L402, ACP, AP2,
TAP, …); agent-wallet / signing / identity / AA infrastructure companies; and a
list of technical markers and anchor domains. Edit there to change what Scout
considers substantive — no code change required.
