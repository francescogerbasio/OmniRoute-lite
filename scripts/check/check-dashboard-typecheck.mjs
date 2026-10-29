#!/usr/bin/env node
// scripts/check/check-dashboard-typecheck.mjs
// Dashboard-scoped typecheck gate (#7033).
//
// `typecheck:core` (the only blocking CI typecheck gate) runs against a curated
// 27-file `"files"` allowlist in tsconfig.typecheck-core.json — none of it lives
// under `src/app/(dashboard)`, and `next.config.mjs` sets
// `typescript.ignoreBuildErrors: true`, so `next build` never type-checks either.
// Net effect: orphaned-identifier regressions in dashboard TSX (deleted `useState`
// decls with live usages left behind) are invisible to both CI type-check paths
// and only surface at runtime — exactly what happened in #6625/#6909.
//
// This gate runs `tsc` scoped to `src/app/(dashboard)/**/*.{ts,tsx}` via
// tsconfig.typecheck-dashboard.json and diffs the result against a frozen
// per-file/per-TS-code count baseline (config/quality/dashboard-typecheck-baseline.json),
// following this repo's stale-enforcement allowlist convention (see
// scripts/check/check-known-symbols.ts). A live count that EXCEEDS the baselined
// count for a given (file, TS code) pair is a regression and fails the gate; a
// live count that is lower is an improvement and does not fail (use --update to
// ratchet the baseline down).
//
// Run:
//   node scripts/check/check-dashboard-typecheck.mjs
//   node scripts/check/check-dashboard-typecheck.mjs --update   # re-freeze baseline

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyTscOutcome, runTsc } from "./lib/tscInvocation.mjs";
import { diffAgainstBaseline, parseTscOutput } from "./typecheckBaseline.mjs";

// Parsing/comparison live in typecheckBaseline.mjs (shared with the API and Open SSE gates).
// Re-exported here so this module's existing public API and tests keep working.
export { diffAgainstBaseline, parseTscOutput };

const ROOT = process.cwd();
const TSCONFIG = path.join(ROOT, "tsconfig.typecheck-dashboard.json");
const BASELINE_PATH = path.join(ROOT, "config/quality/dashboard-typecheck-baseline.json");
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
    `[dashboard-typecheck] FAIL — ${outcome.reason}. The compiler result cannot be compared ` +
      `with the frozen baseline:\n` +
      outcome.detail.map((line) => `  ✗ ${line}\n`).join("") +
      `\nIf the compiler could not run, fix the local install (pnpm install --frozen-lockfile).\n`
  );
}

function main() {
  if (!fs.existsSync(TSCONFIG)) {
    process.stderr.write(`[dashboard-typecheck] FAIL — tsconfig not found at ${TSCONFIG}\n`);
    process.exit(2);
  }

  console.log("[dashboard-typecheck] Running tsc scoped to src/app/(dashboard)/**…");
  let outcome;
  try {
    outcome = evaluateTsc();
  } catch (err) {
    process.stderr.write(
      `[dashboard-typecheck] FAIL — could not run the local TypeScript compiler: ${err?.message ?? String(err)}\n` +
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
  console.log(`dashboardTypecheckErrors=${liveErrorCount}`);

  if (UPDATE) {
    writeBaseline(live);
    console.log(`[dashboard-typecheck] baseline rewritten (${liveErrorCount} errors frozen).`);
    process.exit(0);
  }

  if (improvements.length > 0) {
    console.log(
      `[dashboard-typecheck] ${improvements.length} baselined error(s) no longer present ` +
        `— run 'node scripts/check/check-dashboard-typecheck.mjs --update' to ratchet the baseline down:\n` +
        improvements
          .map(
            (i) => `  - ${i.file} ${i.code} (baseline ${i.baselineCount} -> live ${i.liveCount})`
          )
          .join("\n")
    );
  }

  if (regressions.length > 0) {
    process.stderr.write(
      `[dashboard-typecheck] FAIL — ${regressions.length} new/regressed TypeScript error(s) ` +
        `under src/app/(dashboard)/ not covered by the frozen baseline:\n` +
        regressions
          .map((r) => `  ✗ ${r.file} ${r.code} (baseline ${r.baselineCount}, live ${r.liveCount})`)
          .join("\n") +
        `\n\nIf this is a genuine new dashboard TSX bug (e.g. an orphaned identifier), fix it.\n` +
        `If it's pre-existing type looseness you're intentionally not fixing in this PR,\n` +
        `do NOT widen the baseline for new regressions — that defeats the gate.\n`
    );
    process.exit(1);
  }

  console.log(
    `[dashboard-typecheck] OK — ${liveErrorCount} pre-existing error(s), all within frozen baseline.`
  );
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
