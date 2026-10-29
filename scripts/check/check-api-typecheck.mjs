#!/usr/bin/env node
// scripts/check/check-api-typecheck.mjs
// API-route-scoped typecheck gate (#11601).
//
// `typecheck:core` uses a curated file allowlist, the dashboard typecheck gate
// only covers src/app/(dashboard)/**, and Next builds ignore TypeScript build
// errors. That leaves src/app/api/** without a blocking typecheck gate.
//
// This gate runs `tsc` scoped to src/app/api/**/*.{ts,tsx} via
// tsconfig.typecheck-api.json and compares live diagnostics against a frozen
// per-file/per-TS-code count baseline. New diagnostics or count increases fail;
// reductions are reported as improvements and can be ratcheted with --update.
//
// Run:
//   node scripts/check/check-api-typecheck.mjs
//   node scripts/check/check-api-typecheck.mjs --update

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyTscOutcome, runTsc } from "./lib/tscInvocation.mjs";
import { diffAgainstBaseline, parseTscOutput } from "./typecheckBaseline.mjs";

export { diffAgainstBaseline, parseTscOutput } from "./typecheckBaseline.mjs";

const ROOT = process.cwd();
const TSCONFIG = path.join(ROOT, "tsconfig.typecheck-api.json");
const BASELINE_PATH = path.join(ROOT, "config/quality/api-typecheck-baseline.json");
const UPDATE = process.argv.includes("--update");

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
}

function writeBaseline(counts) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + "\n");
}

/**
 * Runs the local compiler and classifies the result. Exported so the fail-closed decision can be
 * unit-tested with an injected process boundary.
 */
export function evaluateTsc(options = {}) {
  return classifyTscOutcome(
    runTsc({
      rootDir: ROOT,
      tsconfigPath: TSCONFIG,
      nodeExecutable: options.nodeExecutable,
      execFile: options.execFile,
    })
  );
}

/** Reports a fatal compiler outcome (never baselinable, never written by --update). */
function reportFatal(outcome) {
  process.stderr.write(
    `[api-typecheck] FAIL — ${outcome.reason}. The compiler result cannot be compared with the ` +
      `frozen baseline:\n` +
      outcome.detail.map((line) => `  ✗ ${line}\n`).join("") +
      `\nIf the compiler could not run, fix the local install (pnpm install --frozen-lockfile).\n`
  );
}

function main() {
  if (!fs.existsSync(TSCONFIG)) {
    process.stderr.write(`[api-typecheck] FAIL — tsconfig not found at ${TSCONFIG}\n`);
    process.exit(2);
  }

  console.log("[api-typecheck] Running tsc scoped to src/app/api/**…");
  let outcome;
  try {
    outcome = evaluateTsc();
  } catch (err) {
    process.stderr.write(
      `[api-typecheck] FAIL — could not run the local TypeScript compiler: ${err?.message ?? String(err)}\n` +
        `  → expected ${path.join(ROOT, "node_modules", "typescript", "bin", "tsc")}\n` +
        `  → fix the local install with 'pnpm install --frozen-lockfile'\n`
    );
    process.exit(2);
  }
  if (outcome.kind === "fatal") {
    reportFatal(outcome);
    process.exit(2);
  }

  const live = outcome.live;
  const liveErrorCount = outcome.liveErrorCount;
  const baseline = loadBaseline();
  const { regressions, improvements } = diffAgainstBaseline(live, baseline);
  console.log(`apiTypecheckErrors=${liveErrorCount}`);

  if (UPDATE) {
    writeBaseline(live);
    console.log(`[api-typecheck] baseline rewritten (${liveErrorCount} errors frozen).`);
    process.exit(0);
  }

  if (improvements.length > 0) {
    console.log(
      `[api-typecheck] ${improvements.length} baselined error(s) no longer present ` +
        `— run 'node scripts/check/check-api-typecheck.mjs --update' to ratchet the baseline down:\n` +
        improvements
          .map(
            (i) => `  - ${i.file} ${i.code} (baseline ${i.baselineCount} -> live ${i.liveCount})`
          )
          .join("\n")
    );
  }

  if (regressions.length > 0) {
    process.stderr.write(
      `[api-typecheck] FAIL — ${regressions.length} new/regressed TypeScript error(s) ` +
        `under src/app/api/ not covered by the frozen baseline:\n` +
        regressions
          .map((r) => `  ✗ ${r.file} ${r.code} (baseline ${r.baselineCount}, live ${r.liveCount})`)
          .join("\n") +
        `\n\nFix new API-route TypeScript regressions rather than widening the baseline.\n`
    );
    process.exit(1);
  }

  console.log(
    `[api-typecheck] OK — ${liveErrorCount} pre-existing error(s), all within frozen baseline.`
  );
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
