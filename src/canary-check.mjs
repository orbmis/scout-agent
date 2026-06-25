// canary-check.mjs — reads a run report (last-run.json), applies the public-source
// canary verdict, writes a Markdown summary, and exits non-zero on failure.
// Used by the /live-test GitHub workflow.
//
//   node src/canary-check.mjs <report.json>
//   CANARY_SUMMARY_FILE=summary.md  (optional — where to write the Markdown)

import fs from "node:fs";
import { canaryVerdict } from "./report.mjs";

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: node src/canary-check.mjs <report.json>");
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const verdict = canaryVerdict(report);

const lines = [
  `### Scout live canary — ${verdict.pass ? "✅ pass" : "❌ fail"}`,
  "",
  "| collector | items | status | ms |",
  "|---|---|---|---|",
  ...Object.entries(report.collectors).map(([n, c]) => `| ${n} | ${c.items} | ${c.status} | ${c.ms} |`),
  "",
  `Dedup: ${report.dedup?.total_before ?? "?"} → ${report.dedup?.total_after ?? "?"} · collect ${report.timings?.collect_ms ?? "?"} ms`,
];
if (report.warnings?.length) lines.push("", `Warnings: ${report.warnings.map((w) => w.code).join(", ")}`);
if (!verdict.pass) lines.push("", `Failures: ${verdict.failures.join("; ")}`);
const summary = lines.join("\n");

if (process.env.CANARY_SUMMARY_FILE) fs.writeFileSync(process.env.CANARY_SUMMARY_FILE, summary);
console.log(summary);
process.exit(verdict.pass ? 0 : 1);
