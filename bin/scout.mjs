#!/usr/bin/env node
// scout — the single entry point.
//
//   scout collect [date] [--report f]   run collectors, write manifest + marker
//   scout process <manifest>            run the editorial engine over a manifest
//   scout run [date] [--report f]       collect (or reuse today's manifest) then process
//   scout diagnose                      fast preflight (config, credentials, connectivity)
//   scout doctor                        deep per-source diagnosis with remediations
//   scout selftest                      offline golden proof of the editorial pipeline
//
// Flags: --report <path> (collect/run), --now <iso|epoch-ms> (pin the clock).
// Dates are UTC YYYY-MM-DD; default is today. Exit code is non-zero on failure.

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { cmd: positional[0], arg: positional[1], flags };
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function writeReport(config, report, reportPath) {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(path.join(config.stateDir, "last-run.json"), JSON.stringify(report, null, 2));
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

async function main() {
  const { cmd, arg, flags } = parseArgs(process.argv.slice(2));
  if (flags.now) process.env.SCOUT_NOW = flags.now;

  // Imports after SCOUT_NOW is set so loadConfig picks up the pinned clock.
  const { loadConfig } = await import("../src/config.mjs");
  const { collect } = await import("../src/collect.mjs");
  const { processManifest } = await import("../src/process.mjs");
  const { runDiagnostics } = await import("../src/diagnose.mjs");
  const { runDoctor } = await import("../src/doctor.mjs");
  const { runSelftest } = await import("../src/selftest.mjs");
  const { withProcess } = await import("../src/report.mjs");
  const { performance } = await import("node:perf_hooks");
  const { utcDate } = await import("../src/lib/text.mjs");

  const config = loadConfig();

  switch (cmd) {
    case "collect": {
      const date = arg || utcDate(new Date(config.nowMs));
      const { manifestFile, report } = await collect(config, { date, nowMs: config.nowMs });
      writeReport(config, report, flags.report);
      out({ command: "collect", date, manifest: manifestFile, report });
      process.exit(report.ok ? 0 : 1);
    }

    case "process": {
      if (!arg) throw new Error("usage: scout process <manifest.json>");
      out({ command: "process", ...processManifest(config, arg) });
      return;
    }

    case "run": {
      const date = arg || utcDate(new Date(config.nowMs));
      const manifestFile = path.join(config.manifestDir, `manifest-${date}.json`);
      const markerFile = path.join(config.manifestDir, `ready-${date}.marker`);
      const totalStart = performance.now();
      let report;

      if (fs.existsSync(manifestFile) && fs.statSync(manifestFile).size > 0 && fs.existsSync(markerFile)) {
        const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        report = { command: "run", date, collection_mode: "reused_manifest", collectors: {}, dedup: m.collection_diagnostics?.dedup || {}, timings: {}, warnings: [], ok: true };
      } else {
        ({ report } = await collect(config, { date, nowMs: config.nowMs }));
        report.collection_mode = "collected";
      }

      const procStart = performance.now();
      const result = processManifest(config, manifestFile);
      report = withProcess(report, { processResult: result, processMs: performance.now() - procStart, totalMs: performance.now() - totalStart });
      writeReport(config, report, flags.report);
      out({ command: "run", date, manifest: manifestFile, report, ...result });
      process.exit(report.ok ? 0 : 1);
    }

    case "diagnose": {
      const r = await runDiagnostics(config);
      out(r);
      process.exit(r.summary?.ready_to_collect ? 0 : 1);
    }

    case "doctor": {
      const r = await runDoctor(config);
      out(r);
      process.exit(r.ok ? 0 : 1);
    }

    case "selftest": {
      const r = runSelftest(config);
      out(r);
      process.exit(r.ok ? 0 : 1);
    }

    default:
      console.error("usage: scout <collect|process|run|diagnose|doctor|selftest> [arg] [--report f] [--now t]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
