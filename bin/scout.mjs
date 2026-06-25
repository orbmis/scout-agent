#!/usr/bin/env node
// scout — the single entry point.
//
//   scout collect [date]     run all collectors, write the manifest + marker
//   scout process <manifest> run the editorial engine over a manifest
//   scout run [date]         collect (or reuse today's manifest) then process
//   scout diagnose           check config, credentials, and connectivity
//
// Dates are UTC YYYY-MM-DD; default is today.

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { collect } from "../src/collect.mjs";
import { processManifest } from "../src/process.mjs";
import { runDiagnostics } from "../src/diagnose.mjs";
import { utcDate } from "../src/lib/text.mjs";

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const config = loadConfig();

  switch (cmd) {
    case "collect": {
      const date = arg || utcDate();
      const { manifestFile, diagnostics } = await collect(config, { date });
      out({ command: "collect", date, manifest: manifestFile, collection_diagnostics: diagnostics });
      return;
    }

    case "process": {
      if (!arg) throw new Error("usage: scout process <manifest.json>");
      out({ command: "process", ...processManifest(config, arg) });
      return;
    }

    case "run": {
      const date = arg || utcDate();
      const manifestFile = path.join(config.manifestDir, `manifest-${date}.json`);
      const markerFile = path.join(config.manifestDir, `ready-${date}.marker`);
      let collectionMode = "collected";
      let diagnostics;

      if (fs.existsSync(manifestFile) && fs.statSync(manifestFile).size > 0 && fs.existsSync(markerFile)) {
        collectionMode = "reused_manifest";
        diagnostics = JSON.parse(fs.readFileSync(manifestFile, "utf8")).collection_diagnostics;
      } else {
        ({ diagnostics } = await collect(config, { date }));
      }

      const result = processManifest(config, manifestFile);
      out({ command: "run", date, manifest: manifestFile, collection_mode: collectionMode, collection_diagnostics: diagnostics, ...result });
      return;
    }

    case "diagnose": {
      out(await runDiagnostics(config));
      return;
    }

    default:
      console.error("usage: scout <collect|process|run|diagnose> [arg]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
