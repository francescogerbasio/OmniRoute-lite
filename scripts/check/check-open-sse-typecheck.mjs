#!/usr/bin/env node
// scripts/check/check-open-sse-typecheck.mjs
// open-sse workspace typecheck gate (#8781).
//
// The open-sse workspace declares path aliases (e.g. `@/*` → `../src/*`) in its own
// tsconfig.json, but those aliases are not resolvable by Node's bare module resolution —
// they only work because Next.js/Turbopack bundles the entire tree. Additionally,
// package.json historically declared `main`/`exports` entries that do not exist on disk.
//
// This gate runs `tsc -p open-sse/tsconfig.json` and diffs the result against a frozen
// per-file/per-TS-code count baseline (config/quality/open-sse-typecheck-baseline.json),
// following this repo's stale-enforcement allowlist convention. A live count that EXCEEDS
// the baselined count for a given (file, TS code) pair is a regression and fails the gate;
// a live count that is lower is an improvement and does not fail (use --update to ratchet
// the baseline down).
//
// Run:
//   node scripts/check/check-open-sse-typecheck.mjs
//   node scripts/check/check-open-sse-typecheck.mjs --update   # re-freeze baseline

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyTscOutcome,
  getTscCommand as buildTscCommand,
  runTsc as executeTsc,
} from "./lib/tscInvocation.mjs";
import { diffAgainstBaseline, parseTscOutput } from "./typecheckBaseline.mjs";

export { diffAgainstBaseline, parseTscOutput } from "./typecheckBaseline.mjs";

const ROOT = process.cwd();
const TSCONFIG = path.join(ROOT, "open-sse", "tsconfig.json");
const BASELINE_PATH = path.join(ROOT, "config/quality/open-sse-typecheck-baseline.json");
const UPDATE = process.argv.includes("--update");

const OPEN_SSE_TSCONFIG = path.join(ROOT, "open-sse", "tsconfig.json");

/**
 * Execute the locally installed TypeScript CLI directly through Node.
 *
 * pnpm owns node_modules; resolving its TypeScript entrypoint explicitly avoids
 * remote npx downloads and Windows .cmd shim execution (EINVAL on recent Node).
 * No shell, package-manager subprocess, or PATH-dependent fallback is needed.
 *
 * Thin wrapper over the shared invocation helper (scripts/check/lib/tscInvocation.mjs) so this
 * module's positional signature stays stable for its existing tests/callers.
 */
export function getTscCommand(rootDir = ROOT, nodeExecutable = process.execPath) {
  return buildTscCommand({
    rootDir,
    tsconfigPath: path.join(rootDir, "open-sse", "tsconfig.json"),
    nodeExecutable,
  });
}

/**
 * Runs TypeScript with an injectable process boundary for fast regression tests.
 * A non-zero tsc exit can still contain expected, baselined diagnostics on stdout, so the
 * failure is reported to the caller instead of being swallowed.
 * @returns {{ stdout: string, failed: boolean }}
 */
export function runTsc(options = {}) {
  const { rootDir = ROOT, nodeExecutable = process.execPath, execFile } = options;
  const result = executeTsc({
    rootDir,
    tsconfigPath: path.join(rootDir, "open-sse", "tsconfig.json"),
    nodeExecutable,
    execFile,
  });
  return { stdout: result.stdout, failed: result.failed };
}

/**
 * Legacy predicate kept for callers/tests: a non-zero exit with no parseable diagnostics is a
 * failed invocation, not a report. main() uses the stricter shared classifier, which also
 * rejects unpositioned diagnostics mixed with parseable ones.
 */
export function isUnparsedTypecheckFailure({ failed, liveErrorCount }) {
  return failed === true && liveErrorCount === 0;
}

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
    executeTsc({
      rootDir: ROOT,
      tsconfigPath: OPEN_SSE_TSCONFIG,
      nodeExecutable: options.nodeExecutable,
      execFile: options.execFile,
    })
  );
}

/** Reports a fatal compiler outcome (never baselinable, never written by --update). */
function reportFatal(outcome) {
  process.stderr.write(
    `[open-sse-typecheck] FAIL — ${outcome.reason}. The compiler result cannot be compared with ` +
      `the frozen baseline:\n` +
      outcome.detail.map((line) => `  ✗ ${line}\n`).join("") +
      `\nIf the compiler could not run, fix the local install (pnpm install --frozen-lockfile).\n`
  );
}

function main() {
  if (!fs.existsSync(TSCONFIG)) {
    process.stderr.write(`[open-sse-typecheck] FAIL — tsconfig not found at ${TSCONFIG}\n`);
    process.exit(2);
  }

  console.log("[open-sse-typecheck] Running tsc scoped to open-sse/ workspace…");
  let outcome;
  try {
    outcome = evaluateTsc();
  } catch (err) {
    process.stderr.write(
      `[open-sse-typecheck] FAIL — could not run the local TypeScript compiler: ${err?.message ?? String(err)}\n` +
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
  console.log(`openSseTypecheckErrors=${liveErrorCount}`);

  if (UPDATE) {
    writeBaseline(live);
    console.log(`[open-sse-typecheck] baseline rewritten (${liveErrorCount} errors frozen).`);
    process.exit(0);
  }

  if (improvements.length > 0) {
    console.log(
      `[open-sse-typecheck] ${improvements.length} baselined error(s) no longer present ` +
        `— run 'node scripts/check/check-open-sse-typecheck.mjs --update' to ratchet the baseline down:\n` +
        improvements
          .map(
            (i) => `  - ${i.file} ${i.code} (baseline ${i.baselineCount} -> live ${i.liveCount})`
          )
          .join("\n")
    );
  }

  if (regressions.length > 0) {
    process.stderr.write(
      `[open-sse-typecheck] FAIL — ${regressions.length} new/regressed TypeScript error(s) ` +
        `under open-sse/ workspace not covered by the frozen baseline:\n` +
        regressions
          .map((r) => `  ✗ ${r.file} ${r.code} (baseline ${r.baselineCount}, live ${r.liveCount})`)
          .join("\n") +
        `\n\nIf this is a genuine new open-sse type error (e.g. an undeclared @/ alias),\n` +
        `fix it in the source, not in the baseline.\n` +
        `If it's pre-existing type looseness you're intentionally not fixing in this PR,\n` +
        `do NOT widen the baseline for new regressions — that defeats the gate.\n`
    );
    process.exit(1);
  }

  console.log(
    `[open-sse-typecheck] OK — ${liveErrorCount} pre-existing error(s), all within frozen baseline.`
  );
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
