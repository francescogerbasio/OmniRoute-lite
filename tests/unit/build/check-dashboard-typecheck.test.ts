// tests/unit/build/check-dashboard-typecheck.test.ts
// Unit tests for the pure parsing/diff helpers in check-dashboard-typecheck.mjs.
// No child process is spawned — synthetic tsc-style output only, so the suite is
// fast and hermetic. Proves the gate actually DETECTS the #6625/#6909 bug class
// (an orphaned identifier — used but not declared — in a dashboard TSX file),
// not just that the script runs.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTscOutput,
  diffAgainstBaseline,
} from "../../../scripts/check/check-dashboard-typecheck.mjs";

test("parseTscOutput: parses a TS2304 orphaned-identifier error (the #6625/#6909 bug class)", () => {
  const raw =
    `src/app/(dashboard)/dashboard/settings/components/ProxyRegistryManager.tsx(564,7): error TS2304: Cannot find name 'setPoolLoaded'.\n` +
    `src/app/(dashboard)/dashboard/settings/components/ProxyRegistryManager.tsx(1204,12): error TS2304: Cannot find name 'poolLoaded'.\n`;

  const counts = parseTscOutput(raw);

  assert.deepEqual(counts, {
    "src/app/(dashboard)/dashboard/settings/components/ProxyRegistryManager.tsx": {
      TS2304: 2,
    },
  });
});

test("parseTscOutput: ignores non-error lines (summary/info output)", () => {
  const raw =
    `Some info line that is not an error\n` +
    `src/app/(dashboard)/dashboard/foo.tsx(1,1): error TS2339: Property 'bar' does not exist.\n` +
    `Found 1 error in 1 file.\n`;

  const counts = parseTscOutput(raw);

  assert.deepEqual(counts, {
    "src/app/(dashboard)/dashboard/foo.tsx": { TS2339: 1 },
  });
});

test("parseTscOutput: returns empty map for clean output", () => {
  assert.deepEqual(parseTscOutput(""), {});
  assert.deepEqual(parseTscOutput("Found 0 errors.\n"), {});
});

test("diffAgainstBaseline: flags a brand-new orphaned-identifier error as a regression", () => {
  const baseline = {};
  const live = {
    "src/app/(dashboard)/dashboard/settings/components/ProxyRegistryManager.tsx": {
      TS2304: 5,
    },
  };

  const { regressions, improvements } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 1);
  assert.equal(
    regressions[0].file,
    "src/app/(dashboard)/dashboard/settings/components/ProxyRegistryManager.tsx"
  );
  assert.equal(regressions[0].code, "TS2304");
  assert.equal(regressions[0].liveCount, 5);
  assert.equal(regressions[0].baselineCount, 0);
  assert.equal(improvements.length, 0);
});

test("diffAgainstBaseline: does NOT flag a frozen pre-existing error within its baselined count", () => {
  const baseline = { "src/app/(dashboard)/dashboard/foo.tsx": { TS2339: 3 } };
  const live = { "src/app/(dashboard)/dashboard/foo.tsx": { TS2339: 3 } };

  const { regressions, improvements } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 0);
});

test("diffAgainstBaseline: flags a count INCREASE beyond the frozen baseline as a regression", () => {
  const baseline = { "src/app/(dashboard)/dashboard/foo.tsx": { TS2339: 2 } };
  const live = { "src/app/(dashboard)/dashboard/foo.tsx": { TS2339: 3 } };

  const { regressions } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].baselineCount, 2);
  assert.equal(regressions[0].liveCount, 3);
});

test("diffAgainstBaseline: reports (does not fail on) a count DECREASE as an improvement", () => {
  const baseline = { "src/app/(dashboard)/dashboard/foo.tsx": { TS2339: 3 } };
  const live = { "src/app/(dashboard)/dashboard/foo.tsx": { TS2339: 1 } };

  const { regressions, improvements } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 1);
  assert.equal(improvements[0].baselineCount, 3);
  assert.equal(improvements[0].liveCount, 1);
});

test("diffAgainstBaseline: a baselined error that fully disappears is reported as an improvement, not a failure", () => {
  const baseline = { "src/app/(dashboard)/dashboard/foo.tsx": { TS2339: 2 } };
  const live = {};

  const { regressions, improvements } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 1);
  assert.equal(improvements[0].liveCount, 0);
  assert.equal(improvements[0].baselineCount, 2);
});

// ---------------------------------------------------------------------------
// real gate process: fail-closed ordering and --update protection
// ---------------------------------------------------------------------------

const GATE = path.resolve(
  import.meta.dirname,
  "../../../scripts/check/check-dashboard-typecheck.mjs"
);
const TSCONFIG_NAME = "tsconfig.typecheck-dashboard.json";
const BASELINE_REL = "config/quality/dashboard-typecheck-baseline.json";
const POSITIONED = "src/app/api/foo/route.ts(1,2): error TS2339: Property 'bar' does not exist.\n";
const UNPOSITIONED = "error TS6053: File '/tmp/missing.ts' not found.\n";

function makeFixture(stdout: string, exitCode: number, withCompiler = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dashboard-gate-"));
  fs.writeFileSync(path.join(dir, TSCONFIG_NAME), "{}\n");
  fs.mkdirSync(path.join(dir, "config", "quality"), { recursive: true });
  const baselineText = JSON.stringify({ "src/app/api/keep.ts": { TS2339: 1 } }, null, 2) + "\n";
  fs.writeFileSync(path.join(dir, BASELINE_REL), baselineText);
  if (withCompiler) {
    const tscDir = path.join(dir, "node_modules", "typescript", "bin");
    fs.mkdirSync(tscDir, { recursive: true });
    fs.writeFileSync(
      path.join(tscDir, "tsc"),
      `process.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${exitCode});\n`
    );
  }
  return { dir, baselinePath: path.join(dir, BASELINE_REL), baselineText };
}

function runGate(dir: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [GATE, ...args], { cwd: dir, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("mixed parseable + unpositioned output fails closed and --update leaves the baseline intact", (t) => {
  const { dir, baselinePath, baselineText } = makeFixture(POSITIONED + UNPOSITIONED, 1);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = runGate(dir, ["--update"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /FAIL — unpositioned compiler diagnostic/);
  assert.equal(
    fs.readFileSync(baselinePath, "utf8"),
    baselineText,
    "baseline must not be rewritten"
  );
});

test("an unpositioned-only failure exits 2 without touching the baseline", (t) => {
  const { dir, baselinePath, baselineText } = makeFixture(UNPOSITIONED, 1);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = runGate(dir);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(fs.readFileSync(baselinePath, "utf8"), baselineText);
});

test("a legitimate positioned-only run still ratchets the baseline with --update", (t) => {
  const { dir, baselinePath } = makeFixture(POSITIONED, 2);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = runGate(dir, ["--update"]);
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  assert.deepEqual(written, { "src/app/api/foo/route.ts": { TS2339: 1 } });
});

test("a missing local compiler fails explicitly instead of reporting zero errors", (t) => {
  const { dir, baselinePath, baselineText } = makeFixture("", 0, false);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = runGate(dir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /could not run the local TypeScript compiler/);
  assert.equal(fs.readFileSync(baselinePath, "utf8"), baselineText);
});
