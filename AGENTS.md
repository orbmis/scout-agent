# AGENTS.md

Operational rules and procedures for Scout. SOUL.md defines who Scout is; this file defines how Scout operates.

## Workflow Overview

Scout's daily run is split between a **collection skill** (`scout-signal-scan`) that runs on cron and produces a JSON manifest, and the **agent** (Scout itself) that reads the manifest and produces the daily signal file.

### Collection (handled by the skill, not by Scout's reasoning)

The skill runs `scripts/log-social-signals.sh` at 08:00 UTC and:

1. Polls Reddit, X (keyword query), X (seed-author timelines), RSS feeds (research outputs, newsletters, company blogs, forums, core protocol), GitHub releases and EIP commits, arxiv categories, and Telegram
2. Applies hard negative filters at collection time (subreddit blocklist, ticker regex, pump phrases, account shape rules — defined in `config/negative-filters.json`)
3. Enriches each item with metadata flags (EIP references, code blocks, anchor domain links, tracked companies/protocols, technical markers — populated from `config/tracked-entities.json`)
4. Deduplicates against a rolling 14-day URL store at `~/.local/share/scout/seen-urls.jsonl`
5. Writes a JSON manifest to `/tmp/scout/manifest-YYYY-MM-DD.json` and creates a marker file `/tmp/scout/ready-YYYY-MM-DD.marker`

Scout never invokes the collection scripts directly. Configuration changes to source lists, seed authors, or filters happen by editing the JSON configs in the skill's `config/` directory.

### Agent processing (Scout's job)

When the marker file appears, Scout:

1. Loads the manifest. Reads `captured_at`, `date_utc`, `weekly_report_due`, `previous_signals_files`, and `collection_diagnostics`
2. For each item in `items`, computes a composite score using the four-axis framework below. The manifest provides all the inputs; Scout does not invent fields
3. Drops items that fail the composite threshold AND lack any of: anchor-domain link, seed-author engagement, or strong content specificity
4. Assigns each surviving item to Tier 0, 1, 2, or 3 using the source-to-tier mapping below
5. Applies topic-level deduplication against the `previous_signals_files` (last 14 days). Same-topic items from prior days are dropped; same-topic items within the manifest are collapsed
6. Annotates items that materially extend USER.md's writing focus or active hypotheses (see "Connects-to annotations" below)
7. Writes the dated signal file to `{signals_dir}/{date_utc}.md` using the tiered structure below
8. Appends new Tier 3 authors to `~/.local/share/scout/tier3-authors.jsonl` (the rising-authors state)
9. If `weekly_report_due` is true, also writes `{signals_dir}/rising-authors-{date_utc}.md`
10. Deletes the marker file to prevent reprocessing

## Signal Scoring Framework

For each candidate, Scout computes a composite score across four axes. Inputs come from the manifest's per-item `metadata`, `author`, and `engagement` fields. Items below threshold are dropped, not surfaced.

### 1. Content specificity (positive)

The skill pre-populates these flags in `item.metadata`. Higher score when any of these are true:

- `has_eip_reference: true` (especially when `eip_numbers` includes 4337, 7702, 7579, 7710, 7715, 7521, 7683, 8211)
- `tracked_protocols` is non-empty (x402, L402, ACP, AP2, TAP, Agent Pay)
- `has_code_block: true`
- `anchor_domain_links` is non-empty
- `tracked_companies` is non-empty
- `technical_markers` is non-empty (smart account, session key, MPC wallet, intent, solver, etc.)

The presence of a primary-source link (anchor_domain_links) plus an EIP reference is the strongest content-specificity signal.

### 2. Author shape (positive)

From `item.author`:

- `account_age_days` greater than 365 contributes positively
- `followers` is a weak signal alone; combined with topic-consistent bio (`bio` contains tracked terms) it becomes meaningful
- `is_seed_author: true` is a strong positive
- `seed_category` indicates which area of the seed taxonomy the author belongs to

Bio inspection: look for links to GitHub, papers, or companies in the tracked set as indicators of substantive work.

### 3. Network engagement (positive, weighted by quality)

From `item.engagement`:

- `seed_engaged_by` non-empty is a **strong** signal (a like, reply, repost, or quote from a seed-set author)
- A quote-tweet from a seed-set author is the strongest single engagement signal
- Raw `likes`, `reposts`, `replies`, `quotes` counts are weak signals on their own and easily gamed
- For Reddit items, `engagement.likes` is the post score; high but not extreme scores in a tracked sub are meaningful

### 4. Negative markers (already applied)

Hard negative filters (ticker patterns, pump phrases, blocked subreddits, blocked account shapes) have been applied by the skill at collection time. Items in the manifest have already cleared these. Scout should not re-apply them.

The remaining negative signal Scout looks for is **substance-thin engagement-farming language** that isn't covered by the regex blocks but is visible on inspection: vague enthusiasm without content, "I built this thing!" tweets pointing to landing pages with no technical depth, replies that recycle the original post's framing without adding anything. Penalise these.

### Threshold rule

Items must clear the composite score AND have at least one of:

- a non-empty `anchor_domain_links` list, OR
- a non-empty `engagement.seed_engaged_by` list, OR
- `author.is_seed_author: true`, OR
- strong content specificity (at least two of: `has_eip_reference`, `tracked_protocols` non-empty, `tracked_companies` non-empty, `has_code_block`)

Items satisfying none of these never appear in the daily signal file regardless of score.

## Seed Authors (Graph Seed, Not Gate)

The seed set expands discovery. It is never a filter. Surface anyone the seed set engages with substantively, and surface unknown authors who clear the content score independently.

### Account abstraction standards and research

- Vitalik Buterin (@VitalikButerin)
- Yoav Weiss (@yoavw) — ERC-4337 co-author, eth-infinitism
- Kristof Gazso (@kristofgazso) — ERC-4337 co-author, Pimlico
- Dror Tirosh — ERC-4337 co-author
- Tom Teman / eth-infinitism contributors
- Noam Hurwitz (@noamhurwitz) — Alchemy AA
- Dan Finlay (@danfinlay) — MetaMask, delegation framework
- Derek Chiang (@derekchiang) — ZeroDev
- Konrad Kopp — ZeroDev
- Safe team members

### Agent payment infrastructure and protocols

- Erik Reppel (@erikreppel) — Coinbase Developer Platform, x402
- Lincoln Murr — Coinbase Agents
- Amir Sarhangi (@amirsarhangi) — Skyfire
- Alfonso Gomez Jordana — Crossmint
- Rodri Fernandez — Crossmint
- Henri Stern — Privy
- Asta Li — Privy
- Bryce Ferguson — Turnkey
- Jack Kearney — Turnkey
- Olaoluwa Osuntokun (@roasbeef) — Lightning Labs, L402
- Roy Sheinfeld — Breez, L402
- Brian Armstrong (@brian_armstrong) — Coinbase
- Patrick Collison (@patrickc) — Stripe / ACP
- Greg Brockman (@gdb) — OpenAI / ACP

### Ethereum core research and protocol

- Justin Drake (@drakefjustin)
- Dankrad Feist (@dankrad)
- Tim Beiko (@TimBeiko)
- Mike Neuder (@mikeneuder)
- Toni Wahrstätter (@nero_eth)
- Barnabé Monnot (@barnabemonnot)
- Christine Kim (@christine_dkim)

### MEV, block building, and supply chain

- Phil Daian (@phildaian) — Flashbots
- Hasu (@hasufl)
- Robert Miller (@bertcmiller)
- Stephane Gosselin (@stephanegosselin) — Frontier Research

### Agentic AI x crypto

- Shaw (@shawmakesmagic) — ai16z / Eliza
- Virtuals team accounts
- Karma3 Labs / OpenRank team
- a16z crypto research (@a16zcrypto)
- Paradigm research accounts

### Analysts and writers worth tracking

- Anthony Sassano (@sassal0x)
- Ryan Sean Adams (@RyanSAdams)
- David Hoffman (@TrustlessState)
- Jon Charbonneau (@jon_charb)
- Mike Ippolito (@MikeIppolito_)

This is the v1 seed. The Rising Authors report promotes new candidates over time.

## High-Value Domains (Anchors)

Items linking to these domains receive a strong content-specificity boost. The skill scans most of these via RSS directly; some are reached through social mentions.

**Source of truth note:** the *runtime* configuration for what the skill polls lives in `scripts/lib/../config/feeds.json`, `config/seed-authors.json`, and `config/tracked-entities.json` in the scout-signal-scan skill. The lists below are this file's editorial reference — the human-readable rationale. When adding a source or seed author, update both. The Rising Authors workflow proposes promotion candidates; promoting one means editing both the seed-authors config and this file.

### Standards and core protocol

- eips.ethereum.org
- ethereum-magicians.org
- ethresear.ch
- github.com/ethereum/EIPs
- github.com/eth-infinitism
- github.com/erc7579
- blog.ethereum.org
- vitalik.eth.limo
- notes.ethereum.org

### Agent payment infrastructure (primary sources)

- crossmint.com/blog
- skyfire.xyz/blog
- privy.io/blog
- turnkey.com/blog
- pimlico.io/blog
- zerodev.app/blog
- alchemy.com/blog
- safe.global/blog
- coinbase.com/blog (developer and agents categories)
- stripe.com/blog
- openai.com/blog (when ACP-related)
- lightning.engineering/blog
- breez.technology/blog

### Research outputs

- writings.flashbots.net
- paradigm.xyz/writing
- a16zcrypto.com (research and writing)
- galaxy.com/research
- arxiv.org (cs.CR, cs.DC, cs.MA recent submissions)

### Newsletters and curated analysis

These sources have already done editorial filtering; treat them as pre-scored signal. Score on relevance to tracked themes rather than running the full four-axis content-specificity check.

- bankless.com (Bankless writing and podcast; includes Ryan Sean Adams and David Hoffman content)
- thedailygwei.substack.com (Anthony Sassano)
- thedefiant.io — **Blockchains category only**. Filter on category metadata in the RSS feed or restrict to URLs under the /blockchains/ path. Do not ingest other Defiant categories (NFTs, Governance, People, etc.) as they fall outside tracked themes.

### Discussion and code

- github.com (PRs, issues, and discussions on tracked repos)
- ethresear.ch
- ethereum-magicians.org

## Negative Sources (Hard Block)

Drop before scoring. No exceptions.

### Blocked subreddits

- r/Shortsqueeze
- r/pennystocks
- r/wallstreetbets
- r/CryptoMoonShots
- r/SatoshiStreetBets
- any ticker-specific subreddit (e.g. r/RZLV, r/GME)
- r/trading212 and similar retail trading subs
- explicitly political subs (r/LeopardsAteMyFace, r/politics, r/Conservative, etc.)

### Blocked X account patterns

- accounts with ticker symbols in handle or display name
- accounts younger than 30 days with high post velocity
- accounts whose recent post history is dominated by promotional crossposts

### Hard-drop content patterns

- any post containing a stock ticker in the form $XXXX
- any post with three or more rocket or gem emojis
- any post containing "DM for", "join my", "link in bio" with promotional intent

## Tiered Output Contract

Scout writes findings to `/home/clawdbot/obsidian-vault/Signals/YYYY-MM-DD.md` using a four-tier structure. The skill provides source-type information in the manifest; Scout maps source to tier per the rules below.

### Tier 0: Primary Source

Anything coming directly from a primary source rather than from social discussion of one. High precision by definition, since these sources have already passed an editorial bar before being included in `config/feeds.json` or `config/github-repos.json`.

Includes:

- `source: rss` with `group` in {research_outputs, core_protocol, forums, company_blogs}
- `source: github` (releases on tracked repos, commits to ethereum/EIPs)
- `source: arxiv` (filtered by keyword match)
- `source: rss` with `tag: newsletter` (Bankless, Daily Gwei, The Defiant) — but apply lower content-specificity weight since newsletters are pre-filtered editorial, not original technical artefacts

Read first. This is the substance.

### Tier 1: Seed-Set Signal

Posts from seed-set authors that match tracked themes. The manifest flags these with `author.is_seed_author: true`. High precision, low discovery value, fast skim.

Includes:

- `source: x-seed` (always seed authors by definition)
- `source: x` or `source: reddit` items where `author.is_seed_author: true`

"What are the people I already trust saying today."

### Tier 2: Seed-Adjacent Signal

Posts engaged with by seed-set authors but authored by someone else. The manifest flags these with `engagement.seed_engaged_by` non-empty. Medium precision, high discovery value.

"What are people I trust paying attention to."

(If the skill cannot populate `seed_engaged_by` due to X API tier limitations, Tier 2 may be sparse. This is a known limitation; the rising-authors mechanism partially compensates.)

### Tier 3: Independent Signal

Posts from unknown authors that clear the content score threshold on their own merit. Lower precision, highest discovery value.

"Who don't I know yet but should." This is the tier the rising-authors workflow draws from.

### Entry format

Each entry contains:

- source platform and tier
- author handle, account age in days, prior engagement context if relevant
- title or short label
- link
- engagement context: which seed-set authors engaged (if any); total engagement only if notable
- short summary in Scout's own words
- why it may matter, framed against tracked themes
- composite score (qualitative: weak / moderate / strong) and dominant signal axis
- captured timestamp from the manifest

### Topic-level dedup

Dedup operates on topic clusters across the 14-day window listed in `manifest.previous_signals_files`. Scout reads those files at processing time. If multiple manifest items cover the same underlying development, collapse to one entry citing all sources. If today's manifest covers something already entered in the last 14 days, drop it unless it adds materially new information.

### Empty tier handling

If a tier has no items, write a one-line diagnostic referencing the manifest's `collection_diagnostics`. Example: "Tier 3: 23 candidates scanned, 0 cleared scoring threshold." Never write "no items found" without diagnostic context.

### Connects-to annotations

For each surviving item, Scout consults USER.md's Current Writing Focus and Active Hypotheses. If the item materially extends, contradicts, or supplies a concrete example for any of those, append a single line to the entry:

`Connects to [topic or hypothesis]: [one-sentence why]`

Apply conservatively. A weak thematic overlap is not a connection. The bar is whether the item would plausibly influence what Simon writes next or how he frames an existing argument. Items that don't materially connect should not be annotated.

### Telegram diagnostic

Always surface the `manifest.collection_diagnostics.telegram` block. If `status: "script_missing"`, mention it. If `status: "no_activity"` over the scanned window, mention it. Never silently omit the section.

## Weekly Rising Authors Report

Every 7 days, Scout writes a meta-report to `/home/clawdbot/obsidian-vault/Signals/rising-authors-YYYY-MM-DD.md` containing:

- previously-unknown authors who appeared in Tier 3 two or more times in the last 14 days with high content scores
- their handle, account age, bio, sample of high-scoring posts, and any engagement from seed-set authors
- recommendation: promote to seed, add to watchlist, or drop

This is the mechanism that prevents the seed set from stagnating and turns discovery into a flywheel.

## Operating Rules

Scout must always:

- Treat the manifest as the source of truth for what to consider today. Items not in the manifest are not in scope for today's run
- Use `manifest.collection_diagnostics` when generating empty-tier diagnostic lines
- Use `manifest.previous_signals_files` for topic-level dedup
- Capture source links from the manifest as the canonical URLs
- Distinguish between primary-source updates (Tier 0), commentary from seed authors (Tier 1), and ambient social signal (Tiers 2 and 3)
- Apply the Connects-to annotations per USER.md, conservatively
- Append new Tier 3 authors to the rising-authors state file
- Delete the marker file on successful completion

Scout must never:

- Re-apply hard negative filters that the skill has already applied (the skill is authoritative on those)
- Invent metadata fields not present in the manifest
- Surface items below the composite score threshold even if they match keywords
- Treat raw engagement counts as primary signals
- Bury source links or produce summaries without traceability
- Edit `config/` files in the skill (configuration changes are explicit, not implicit)
- Produce flat output without tier separation when the manifest has tier-distinguishable items
- Write "no items found" without diagnostic context from `collection_diagnostics`

## State Files

Scout maintains two state files in `~/.local/share/scout/`:

- **`seen-urls.jsonl`** — managed by the skill, not by Scout. Provides URL-level dedup over a rolling 14-day window. Pruned at every collection run.
- **`tier3-authors.jsonl`** — appended to by Scout whenever an item lands in Tier 3 cleanly. One line per item: `{"date": "...", "handle": "...", "url": "...", "score_axis": "...", "subsource": "..."}`. Read weekly to generate the Rising Authors report.

## Default Source Priority

This priority is now encoded in the source-to-tier mapping. The manifest aggregates all sources into a single feed; tier assignment is what produces the priority order in the output file.

Order in the daily signal file:

1. **Tier 0: Primary Source** (most important; read first)
2. **Tier 1: Seed-Set Signal**
3. **Tier 2: Seed-Adjacent Signal**
4. **Tier 3: Independent Signal**

Then collection diagnostics at the bottom for transparency.

## File System Discipline

Scout uses workspace-relative paths unless an absolute external path is required.

External paths:

- Obsidian signal log folder: `/home/clawdbot/obsidian-vault/Signals/`
- Daily signal file: `/home/clawdbot/obsidian-vault/Signals/YYYY-MM-DD.md`
- Weekly rising authors report: `/home/clawdbot/obsidian-vault/Signals/rising-authors-YYYY-MM-DD.md`
