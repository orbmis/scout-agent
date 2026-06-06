# process-scout-manifest.mjs explainer

This document explains what scripts/process-scout-manifest.mjs does and how its major pieces fit together.

## What the script is for

process-scout-manifest.mjs is the fast local processor for Scout's daily pipeline.

It takes a generated manifest JSON file, applies Scout's scoring and filtering rules, writes the daily output files, updates Tier 3 author state, optionally writes the weekly rising-authors file, removes the ready marker, and prints a small JSON summary to stdout.

In other words:

1. The collector builds a factual manifest.
2. This script turns that manifest into editorial output.
3. The outer cron or agent layer only needs to relay the result.

## Input and output

### Input

The script expects one argument:

    node scripts/process-scout-manifest.mjs /tmp/scout/manifest-YYYY-MM-DD.json

It also reads:

- USER.md
- skills/scout-signal-scan/config/tracked-entities.json
- prior signal files listed in manifest.previous_signals_files

### Output files

It writes:

- Signals/YYYY-MM-DD.md
- Signals/YYYY-MM-DD_filtered.md
- optionally Signals/rising-authors-YYYY-MM-DD.md

It may also append entries to:

- ~/.local/share/scout/tier3-authors.jsonl

At the end it deletes:

- /tmp/scout/ready-YYYY-MM-DD.marker

### Stdout output

It prints a compact JSON object with:

- output paths
- kept and filtered counts
- weekly report status
- strongest items

That JSON is what the outer runner script now uses as the source of truth.

## Top-level flow

The script has five main phases:

1. Load manifest and supporting files.
2. Normalize and enrich items.
3. Score, filter, tier, and deduplicate items.
4. Render the daily and filtered markdown files.
5. Update state, remove the marker, and emit a JSON summary.

## Phase 1: setup and shared data

At startup the script:

- reads the manifest JSON passed on the command line
- reads USER.md
- reads tracked-entities.json
- computes output paths for the day
- ensures the signals directory and state directory exist

It then expands the tracked-entity config into convenient runtime structures:

- trackedCompanies
- trackedProtocols
- trackedTechnicalMarkers
- trackedAnchorDomains
- trackedEipNumbers
- eipReferencePattern

This lets later functions work with simple arrays and sets instead of repeatedly opening config files.

## Phase 2: text cleanup and metadata helpers

Several early helper functions exist to normalize messy collector output.

### Text normalization

- stripHtml() removes HTML tags, collapses whitespace, and strips some known Discourse boilerplate.
- decodeHtml() decodes HTML entities without removing markup.
- textFor() combines title and text into one normalized text body.
- lowerText() is just the lowercased version of that combined text.

### Similarity and time helpers

- tokenize() converts text into a de-duplicated token list.
- similarity() computes a rough overlap score between two texts.
- parseTimeMs() parses timestamps safely.
- parseDiscourseThreadStats() extracts N posts / N participants style thread counts from forum text.

### URL and tracked-entity helpers

- normalizeUrl() canonicalizes URLs when possible.
- anchorKeyForUrl() reduces a URL to hostname plus pathname.
- anchorMatches() checks whether a URL belongs to one of the configured anchor domains.
- extractTrackedEipNumbers() finds EIP and ERC references in text.
- extractMetadata() builds the metadata block used later by the scoring logic.

extractMetadata() is important because it reconstructs:

- whether the text references tracked EIPs
- which anchor domains appear
- which tracked companies, protocols, and technical markers are present
- whether the text appears to contain code

That means the processor does not rely only on collector-time metadata; it can enrich certain derived items again locally.

## Phase 3: special handling for the Flashbots MEV Newsletter

One of the script's more specialized pieces is the Flashbots newsletter expansion logic.

The problem it solves is:

- the RSS item is one wrapper newsletter entry
- inside that entry there may be multiple underlying links worth scoring separately

The script handles that with these functions:

- parseFlashbotsNewsletterItems()
- chooseFlashbotsNewsletterLink()
- summarizeFlashbotsNewsletterItem()
- expandFlashbotsNewsletterItem()

### How that works

parseFlashbotsNewsletterItems() walks the HTML and extracts top-level list items grouped under section headings.

chooseFlashbotsNewsletterLink() scores links inside each extracted item. It prefers things like:

- direct X status links
- arXiv links
- Ethereum research and EIP links
- GitHub links
- YouTube discussion links

It penalizes weak targets like:

- generic homepage links
- author profile links
- newsletter wrapper links
- vague labels like post or thread

expandFlashbotsNewsletterItem() then replaces one newsletter wrapper item with multiple more specific child items when possible. Each child gets:

- a better URL
- a better title
- a short summary
- fresh metadata extracted from that child text and URLs

This is a targeted fix for a source where one RSS entry can otherwise hide multiple signals.

## Phase 4: topic patterns and Connects-to heuristics

The script defines three main rule sets here:

- trackedTopicPatterns
- thinPatterns
- connectTopics

### trackedTopicPatterns

This is the main thematic vocabulary for Scout. It covers things like:

- account abstraction
- agent wallets
- delegation
- stablecoin payments
- identity and attestation
- tracked EIPs

These patterns help with:

- scoring topicality
- filtering weak newsletter items
- generating Connects-to annotations

### thinPatterns

These are low-substance patterns used as negative signals, such as:

- retweets with no content
- giveaways
- generic hype
- event promo language

### connectTopics and describeConnect()

connectTopics defines Simon-specific framing buckets.

describeConnect() uses those buckets to add a conservative Connects to line when an item materially strengthens one of the active themes. It has a few hand-written special cases for recurring topics like:

- memory access rights
- EIP-7702 gas behavior
- stablecoin and payment rails
- identity and attestation

## Phase 5: scoring

The main scoring function is scoreItem(item).

It computes four axis scores:

- content
- author
- engagement
- negative

It also computes a separate topical score.

### Content score

Content score increases when an item has signals like:

- anchor-domain links
- EIP references
- tracked protocols
- tracked companies
- technical markers
- code blocks
- GitHub provenance
- non-newsletter RSS provenance
- strong tracked-topic keyword overlap

### Author score

Author score increases when:

- the author is in the seed set
- the account is older
- the author has meaningful follower and bio shape

### Engagement score

Engagement score increases when:

- seed authors engaged with the item
- quote, repost, or reply volume is meaningful

Raw numbers matter, but they matter less than seed-graph context.

### Negative score

Negative score subtracts for:

- thin hype language
- very short text
- retweets without anchor substance
- event promo phrasing
- certain explicitly irrelevant or low-signal phrases
- Discourse threads with only a deleted or original-post shell

### Topical score

This is a second pass that checks whether the item is really within Scout's subject area, using:

- tracked topic patterns
- anchor domains
- tracked EIP numbers
- title and text cues

### Gate and threshold logic

The score is not enough by itself. An item must also satisfy anchor or gating rules.

hasRequiredAnchorSignal becomes true when an item has at least one strong legitimacy signal, such as:

- GitHub or arXiv source
- high-value RSS group
- anchor-domain link
- seed engagement
- seed authorship
- enough strong content-specificity markers

Thresholds differ slightly by source:

- GitHub and RSS threshold: 4
- everything else: 5

The script also requires topical >= 2.

### Hard-coded special cases

There are several special-case overrides in scoreItem(). Examples:

- Ethereum Magicians topics with only the original post are filtered
- newsletter items that are off-theme are filtered even if they came from a newsletter source

This is intentionally opinionated. The script encodes Scout's editorial policy, not a generic ranking engine.

## Phase 6: clustering and deduplication

After scoring, items go through three dedup layers.

### 1. Previous-file dedup

loadPreviousEntries() reads the prior signal files listed in the manifest.

dedupAgainstPrevious() checks for:

- exact source URL already covered
- same title already covered
- overlapping EIP discussion with sufficient text similarity

If a prior file already covered the same development, the item is filtered with topic_dedup.

### 2. Intra-day topical clustering

Within the current day, the script tries to collapse multiple items about the same development.

Supporting helpers:

- inferTopicBuckets()
- threadClusterKey()

These create cluster keys from things like:

- EIP numbers
- payment and identity themes
- author plus time bucket for bursty X threads

Inside the main loop, the script compares a candidate item against any existing kept item in the same cluster. The stronger item survives; the weaker one is marked collapsed_to_cluster.

### 3. Source-aware topic keys

Primary-source items usually cluster on exact URL.

Less structured social items cluster on derived topic keys like:

- eip:7702
- payments
- identity
- taskmarket

That is why the clustering logic treats primary sources and social commentary differently.

## Phase 7: tier assignment

assignTier(item) maps surviving items into the four output tiers:

- Tier 0: primary sources
- Tier 1: seed authors
- Tier 2: seed-adjacent
- Tier 3: independent

Rules are straightforward:

- high-value RSS groups, GitHub, and arXiv go to Tier 0
- seed authors go to Tier 1
- items with seed engagement go to Tier 2
- everything else that survives goes to Tier 3

## Phase 8: rendering summaries and markdown

The script then prepares human-readable output.

Key helpers:

- summarize()
- whyMatter()
- formatAuthor()
- formatSource()
- titleFor()
- renderEntry()
- renderTier()

### summarize()

Creates a concise summary, with slightly different handling for GitHub text.

### whyMatter()

Adds a short explanation of why the item matters in Scout's editorial frame. This is rule-based rather than model-generated.

### renderEntry()

Each kept item becomes a markdown block containing:

- source and tier
- author
- canonical link
- engagement context
- summary
- why it matters
- score strength
- dominant axis
- captured timestamp
- optional Connects-to line

### Daily note layout

The daily note contains:

- header and scan metadata
- Tier 0 to Tier 3 sections
- collection diagnostics
- a short editorial note

If a tier is empty, renderTier() inserts an explanatory line using collection diagnostics rather than leaving the section blank.

### Filtered note layout

The filtered note groups excluded items by:

- below_threshold
- missing_anchor_signal
- topic_dedup
- collapsed_to_cluster

Each filtered item includes:

- source
- author
- link
- timestamp
- exclusion class
- reason
- scoring note

At the end it writes a summary count for each exclusion class.

## Phase 9: state updates and cleanup

After writing the markdown files, the script:

1. appends new Tier 3 authors to tier3-authors.jsonl
2. optionally writes a weekly rising-authors file when weekly_report_due is true
3. removes the ready marker if it exists

The current weekly file generation is intentionally minimal. It writes a placeholder note rather than doing a full multi-appearance report.

## Final JSON summary

The last thing the script does is print a JSON object containing:

- dailyPath
- filteredPath
- risingWritten
- risingAuthorsPath
- keptCount
- filteredCount
- strongest

This is the contract used by scripts/run-daily-scout.sh and by the outer cron agent turn.

## Design strengths

The script has a few strong properties:

- it is deterministic and fast
- it moves editorial logic out of the model runtime
- it keeps auditability by writing the filtered file
- it separates collection-time facts from processor-time decisions
- it is explicit enough to debug with normal shell tools

## Design limitations

A few limitations are worth noting:

- many heuristics are hard-coded and brittle
- the weekly rising-authors output is still a placeholder
- topic similarity is simple token overlap, not semantic clustering
- some reasoning rules are very specific to current Scout themes and may age poorly
- there is overlap between collector metadata and processor metadata reconstruction

## Practical mental model

The easiest way to think about the script is:

- normalize inputs
- explode one complex newsletter source into better child items
- score everything with handcrafted rules
- reject thin or duplicate items
- sort survivors into tiers
- write one polished note and one audit note
- emit a machine-readable summary for the outer workflow

That is why the script is a good fit for the cron path: it makes the heavy editorial processing local, cheap, and predictable.
