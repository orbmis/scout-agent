# AGENTS.md

Operating notes for any agent (or person) working in this repo. `SOUL.md` is who
Scout is; `SPEC.md` is the editorial contract; this file is how the work runs.

## The pipeline is code, not improvisation

Scout's daily run is implemented deterministically in `src/` and driven by one
CLI. **The code is canonical** — do not re-derive scoring, tiering, or dedup by
hand in-model; run the engine and read its output.

```bash
scout diagnose                 # fast preflight: config, credentials, connectivity
scout doctor                   # deep per-source diagnosis with remediations
scout run                      # collect (or reuse today's manifest) then process
scout collect                  # collection only → manifest + marker
scout process <manifest.json>  # editorial only → daily + filtered files
scout selftest                 # offline golden proof of the editorial pipeline
```

Each command prints a JSON summary to stdout and exits non-zero on failure;
`collect`/`run` also write `$SCOUT_STATE_DIR/last-run.json`. Relay the summary;
don't paraphrase files you haven't read. When changing editorial behaviour, run
`npm test` and regenerate the golden with `SCOUT_SELFTEST_UPDATE=1 scout selftest`.

## What changes behaviour

- **What is collected:** `config/sources.json` (X List id, seed authors, feeds,
  repos, arxiv categories, telegram channels). X membership is edited in the X
  app, not here.
- **What counts as substantive:** `config/editorial.json` (tracked entities,
  negative filters).
- **How items are judged:** `src/editorial/` — change scoring/tiering/dedup here,
  and update `SPEC.md` to match. Add a test in `test/` for any rule you change.

## Operating rules

- Treat the manifest as the source of truth for the day.
- Hard negative filters are applied once, at collection time. Never re-apply them.
- Never surface an item that fails the threshold gate, even if keywords match.
- Never write "no items found" without the diagnostic context the engine emits.
- The marker file is the trigger; `process` deletes it on success. A surviving
  marker means the last run failed — retry.
- Run `npm test` before trusting a change to the editorial engine.

## Editorial intent (full detail in `SPEC.md`)

Separate substance from noise; primary sources over commentary; discovery of new
credible voices over re-surfacing known ones. When uncertain whether an item
clears the bar, drop it — false positives erode the log; false negatives recur.
