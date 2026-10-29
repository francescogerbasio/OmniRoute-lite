// tests/unit/build/check-api-typecheck.test.ts
// Hermetic tests for the API typecheck gate's parsing and baseline-diff logic.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTscOutput,
  diffAgainstBaseline,
} from "../../../scripts/check/check-api-typecheck.mjs";
import { diffAgainstBaseline as diffOpenSseAgainstBaseline } from "../../../scripts/check/check-open-sse-typecheck.mjs";

test("parseTscOutput: parses an API-route TS2554 regression", () => {
  const raw =
    `src/app/api/v1/models/route.ts(42,7): error TS2554: Expected 2 arguments, but got 3.\n` +
    `src/app/api/v1/models/route.ts(52,7): error TS2554: Expected 2 arguments, but got 3.\n`;

  assert.deepEqual(parseTscOutput(raw), {
    "src/app/api/v1/models/route.ts": { TS2554: 2 },
  });
});

test("parseTscOutput: ignores non-error lines", () => {
  const raw =
    `src/app/api/foo/route.ts(1,1): error TS2339: Property 'bar' does not exist.\n` +
    `Found 1 error in 1 file.\n`;

  assert.deepEqual(parseTscOutput(raw), {
    "src/app/api/foo/route.ts": { TS2339: 1 },
  });
});

test("parseTscOutput: returns an empty map for clean output", () => {
  assert.deepEqual(parseTscOutput("Found 0 errors.\n"), {});
});

test("diffAgainstBaseline: flags a new API diagnostic", () => {
  const live = { "src/app/api/v1/models/route.ts": { TS2554: 1 } };
  const { regressions, improvements } = diffAgainstBaseline(live, {});

  assert.deepEqual(regressions, [
    {
      file: "src/app/api/v1/models/route.ts",
      code: "TS2554",
      liveCount: 1,
      baselineCount: 0,
    },
  ]);
  assert.equal(improvements.length, 0);
});

test("diffAgainstBaseline: accepts an unchanged frozen diagnostic count", () => {
  const baseline = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const live = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const { regressions, improvements } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 0);
});

test("diffAgainstBaseline: fails a count increase", () => {
  const baseline = { "src/app/api/foo/route.ts": { TS2339: 1 } };
  const live = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const { regressions } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 1);
  assert.equal(regressions[0].baselineCount, 1);
  assert.equal(regressions[0].liveCount, 2);
});

test("diffAgainstBaseline: reports a count decrease as an improvement", () => {
  const baseline = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const live = { "src/app/api/foo/route.ts": { TS2339: 1 } };
  const { regressions, improvements } = diffAgainstBaseline(live, baseline);

  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 1);
  assert.equal(improvements[0].liveCount, 1);
});

test("diffAgainstBaseline: reports a disappeared diagnostic as an improvement", () => {
  const baseline = { "src/app/api/foo/route.ts": { TS2339: 2 } };
  const { regressions, improvements } = diffAgainstBaseline({}, baseline);

  assert.equal(regressions.length, 0);
  assert.equal(improvements.length, 1);
  assert.equal(improvements[0].liveCount, 0);
  assert.equal(improvements[0].baselineCount, 2);
});

test("diffAgainstBaseline: ignores underscore-prefixed baseline metadata", () => {
  const baseline = {
    _relax_velocity_2026_08_30:
      "per-file TS diagnostic counts raised by 20% (289 -> 455); velocity phase",
    "src/app/api/foo/route.ts": { TS2339: 1 },
  };
  const live = { "src/app/api/foo/route.ts": { TS2339: 1 } };

  for (const compare of [diffAgainstBaseline, diffOpenSseAgainstBaseline]) {
    assert.deepEqual(compare(live, baseline), {
      regressions: [],
      improvements: [],
    });
  }
});

test("diffAgainstBaseline: rejects a string in place of a real file diagnostic map", () => {
  const malformedBaseline = {
    "src/app/api/foo/route.ts": "TS2339: 1",
  };

  assert.throws(
    () => diffAgainstBaseline({}, malformedBaseline),
    /src\/app\/api\/foo\/route\.ts.*plain object/
  );
  assert.throws(
    () => diffOpenSseAgainstBaseline({}, malformedBaseline),
    /src\/app\/api\/foo\/route\.ts.*plain object/
  );
});

test("diffAgainstBaseline: rejects non-plain roots and file maps", () => {
  const inheritedRoot = Object.create({
    "src/app/api/inherited/route.ts": { TS2339: 1 },
  });
  const inheritedFileMap = Object.create({ TS2339: 1 });

  for (const malformedBaseline of [[], "not an object", null, inheritedRoot]) {
    assert.throws(
      () => diffAgainstBaseline({}, malformedBaseline),
      /typecheck baseline must be a plain object/
    );
  }
  for (const malformedFileMap of [[], null, inheritedFileMap]) {
    assert.throws(
      () =>
        diffAgainstBaseline(
          {},
          {
            "src/app/api/foo/route.ts": malformedFileMap,
          }
        ),
      /src\/app\/api\/foo\/route\.ts.*plain object/
    );
  }
});

test("diffAgainstBaseline: rejects prototype property keys", () => {
  const malformedBaseline = JSON.parse('{"__proto__":{"TS2339":1}}');

  assert.throws(
    () => diffAgainstBaseline({}, malformedBaseline),
    /unsupported property key "__proto__"/
  );
});

test("diffAgainstBaseline: rejects non-TypeScript diagnostic keys", () => {
  for (const code of ["2339", "TSX2339", "TS23x", "constructor"]) {
    assert.throws(
      () =>
        diffAgainstBaseline(
          {},
          {
            "src/app/api/foo/route.ts": { [code]: 1 },
          }
        ),
      /invalid TypeScript code/
    );
  }
});

test("diffAgainstBaseline: rejects invalid diagnostic counts", () => {
  for (const count of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, "1"]) {
    assert.throws(
      () =>
        diffAgainstBaseline(
          {},
          {
            "src/app/api/foo/route.ts": { TS2339: count },
          }
        ),
      /finite nonnegative integer/
    );
  }
});

test("diffAgainstBaseline: validates live diagnostics with the same schema", () => {
  assert.throws(
    () =>
      diffAgainstBaseline(
        { "src/app/api/foo/route.ts": { TS2339: -1 } },
        { "src/app/api/foo/route.ts": { TS2339: 1 } }
      ),
    /live diagnostics.*finite nonnegative integer/
  );
});

test("diffAgainstBaseline: accepts zero counts without fabricating a second improvement", () => {
  assert.deepEqual(
    diffAgainstBaseline(
      { "src/app/api/foo/route.ts": { TS2339: 0 } },
      { "src/app/api/foo/route.ts": { TS2339: 1 } }
    ),
    {
      regressions: [],
      improvements: [
        {
          file: "src/app/api/foo/route.ts",
          code: "TS2339",
          liveCount: 0,
          baselineCount: 1,
        },
      ],
    }
  );
});

// ---------------------------------------------------------------------------
// real gate process: fail-closed ordering and --update protection
// ---------------------------------------------------------------------------

const GATE = path.resolve(import.meta.dirname, "../../../scripts/check/check-api-typecheck.mjs");
const TSCONFIG_NAME = "tsconfig.typecheck-api.json";
const BASELINE_REL = "config/quality/api-typecheck-baseline.json";
const POSITIONED = "src/app/api/foo/route.ts(1,2): error TS2339: Property 'bar' does not exist.\n";
const UNPOSITIONED = "error TS6053: File '/tmp/missing.ts' not found.\n";

function makeFixture(stdout: string, exitCode: number, withCompiler = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-gate-"));
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
