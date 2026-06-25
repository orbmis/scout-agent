// report.mjs — builds the machine-readable run report (last-run.json) that powers
// both local diagnosis and CI assertions. Keep this the single source of "health".

const SLOW_RUN_MS = 180000; // healthy collection is 60–90s; warn past 3 min.
const COLLECTOR_NAMES = ["x_seed", "rss", "github", "arxiv", "telegram"];
export const PUBLIC_COLLECTORS = ["rss", "github", "arxiv"]; // no credentials required

// byName: { name: { items: [...], diag: {...}, ms: number } }
export function buildCollectReport({ date, capturedAt, byName, dedup, collectMs, totalMs }) {
  const collectors = {};
  for (const name of COLLECTOR_NAMES) {
    const r = byName[name] || { items: [], diag: {} };
    collectors[name] = { items: r.items.length, status: r.diag.status || "ok", ms: Math.round(r.ms || 0) };
  }

  const warnings = [];
  const errored = COLLECTOR_NAMES.filter((n) => collectors[n].status === "error");
  for (const n of errored) warnings.push({ severity: "error", code: "collector_error", collector: n });
  if (collectMs > SLOW_RUN_MS) warnings.push({ severity: "warn", code: "slow_run", ms: Math.round(collectMs) });
  if (dedup.total_before === 0) warnings.push({ severity: "warn", code: "zero_items_all_sources" });

  const hardFail = errored.length === COLLECTOR_NAMES.length; // everything errored

  return {
    command: "collect",
    date,
    captured_at: capturedAt,
    collectors,
    dedup,
    timings: { collect_ms: Math.round(collectMs), total_ms: Math.round(totalMs) },
    warnings,
    ok: !hardFail,
  };
}

// Merge the editorial result into a collect report for `scout run`.
export function withProcess(report, { processResult, processMs, totalMs }) {
  return {
    ...report,
    command: "run",
    editorial: {
      kept: processResult.keptCount,
      filtered: processResult.filteredCount,
      rising_written: processResult.risingWritten,
    },
    timings: { ...report.timings, process_ms: Math.round(processMs), total_ms: Math.round(totalMs) },
  };
}

// CI-friendly verdict for the public-source canary: every public collector must
// be reachable (no error status) and at least one must return items.
export function canaryVerdict(report) {
  const failures = [];
  let anyItems = false;
  for (const name of PUBLIC_COLLECTORS) {
    const c = report.collectors[name];
    if (!c) { failures.push(`${name}: missing from report`); continue; }
    if (c.status === "error") failures.push(`${name}: error status`);
    if (c.items > 0) anyItems = true;
  }
  if (!anyItems) failures.push("no public collector returned any items");
  return { pass: failures.length === 0, failures };
}
