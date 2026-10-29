// tests/unit/build/tsc-invocation.test.ts
// Contracts for the shared pnpm-native TypeScript invocation + fail-closed classifier used by
// the open-sse, API and dashboard typecheck gates.
//
// The bug this locks down: the gates used to spawn `npx tsc` and swallow the exit status, so a
// compiler that never ran (npx printing "This is not the tsc command you are looking for") or a
// fatal unpositioned diagnostic parsed as ZERO errors and PASSED. A failed invocation must never
// look like a clean typecheck.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import {
  getTscCommand,
  runTsc,
  findUnpositionedDiagnostics,
  classifyTscOutcome,
  TSC_BASELINABLE_STATUSES,
} from "../../../scripts/check/lib/tscInvocation.mjs";

const POSITIONED = "src/app/api/foo/route.ts(1,2): error TS2339: Property 'bar' does not exist.\n";
const UNPOSITIONED = "error TS6053: File '/tmp/missing.ts' not found.\n";
const INFO = "Found 1 error in 1 file.\n";

// ---------------------------------------------------------------------------
// command selection
// ---------------------------------------------------------------------------

test("runs the repository's local TypeScript through Node (no shell, no npx)", () => {
  const root = path.resolve("/repo");
  const { command, args } = getTscCommand({
    rootDir: root,
    tsconfigPath: path.join(root, "tsconfig.typecheck-api.json"),
    nodeExecutable: "/node/bin/node",
  });
  assert.equal(command, "/node/bin/node");
  assert.deepEqual(args, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "--pretty",
    "false",
    "--noEmit",
    "-p",
    path.join(root, "tsconfig.typecheck-api.json"),
  ]);
  assert.ok(!args.some((arg) => /\.cmd$/.test(arg)), "no Windows .cmd shim in argv");
});

test("handles roots with spaces without shell interpolation", () => {
  const root = "/repo path with spaces";
  const { command, args } = getTscCommand({
    rootDir: root,
    tsconfigPath: path.join(root, "tsconfig.typecheck-dashboard.json"),
  });
  assert.equal(command, process.execPath);
  assert.equal(args[0], path.join(root, "node_modules", "typescript", "bin", "tsc"));
  assert.equal(args.at(-1), path.join(root, "tsconfig.typecheck-dashboard.json"));
});

test("requires rootDir and tsconfigPath", () => {
  assert.throws(() => getTscCommand({ tsconfigPath: "/x.json" }), /rootDir/);
  assert.throws(() => getTscCommand({ rootDir: "/repo" }), /tsconfigPath/);
});

// ---------------------------------------------------------------------------
// runTsc result shape
// ---------------------------------------------------------------------------

test("successful execution reports status 0 and no failure", () => {
  const calls: { command: unknown; args: unknown; cwd: unknown }[] = [];
  const result = runTsc({
    rootDir: "/repo",
    tsconfigPath: "/repo/tsconfig.json",
    exists: () => true,
    execFile: (command: unknown, args: unknown, options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      return "";
    },
  });
  assert.equal(result.failed, false);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(calls[0].cwd, "/repo");
});

test("non-zero execution preserves stdout, status and stderr", () => {
  const result = runTsc({
    rootDir: "/repo",
    tsconfigPath: "/repo/tsconfig.json",
    exists: () => true,
    execFile: () => {
      throw Object.assign(new Error("tsc exit 2"), {
        stdout: POSITIONED,
        stderr: "warning text",
        status: 2,
      });
    },
  });
  assert.equal(result.failed, true);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, POSITIONED);
  assert.equal(result.stderr, "warning text");
});

test("launch failures without stdout or status are rethrown", () => {
  const err = Object.assign(new Error("spawn tsc ENOENT"), { code: "ENOENT" });
  assert.throws(
    () =>
      runTsc({
        rootDir: "/repo",
        tsconfigPath: "/repo/tsconfig.json",
        exists: () => true,
        execFile: () => {
          throw err;
        },
      }),
    (thrown) => thrown === err
  );
});

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

test("classifies a clean run as ok", () => {
  assert.equal(classifyTscOutcome({ stdout: "", failed: false }).kind, "ok");
  assert.equal(classifyTscOutcome({ stdout: INFO, failed: false }).kind, "ok");
});

test("non-zero with parseable diagnostics stays baselinable (statuses 1 and 2)", () => {
  for (const status of TSC_BASELINABLE_STATUSES) {
    const outcome = classifyTscOutcome({ stdout: POSITIONED, status, failed: true });
    assert.equal(outcome.kind, "type-errors", `status ${status}`);
    assert.equal(outcome.liveErrorCount, 1);
    assert.deepEqual(outcome.live, { "src/app/api/foo/route.ts": { TS2339: 1 } });
  }
});

test("non-zero without parseable diagnostics is fatal", () => {
  const outcome = classifyTscOutcome({ stdout: INFO, status: 1, failed: true });
  assert.equal(outcome.kind, "fatal");
  assert.match(outcome.reason, /without parseable diagnostics/);
});

test("an unpositioned compiler error is fatal even on its own", () => {
  const outcome = classifyTscOutcome({ stdout: UNPOSITIONED, status: 1, failed: true });
  assert.equal(outcome.kind, "fatal");
  assert.match(outcome.reason, /unpositioned/);
  assert.deepEqual(outcome.unpositioned, ["error TS6053: File '/tmp/missing.ts' not found."]);
});

test("an unpositioned error mixed with parseable diagnostics is still fatal", () => {
  const outcome = classifyTscOutcome({
    stdout: POSITIONED + UNPOSITIONED,
    status: 1,
    failed: true,
  });
  assert.equal(outcome.kind, "fatal", "mixed output must not be rescued by parseable errors");
  assert.match(outcome.reason, /unpositioned/);
});

test("exit 0 with reported diagnostics is inconsistent and fails closed", () => {
  const outcome = classifyTscOutcome({ stdout: POSITIONED, failed: false });
  assert.equal(outcome.kind, "fatal");
  assert.match(outcome.reason, /exited 0/);
});

test("spawn codes, signals and unexpected statuses are fatal even with parseable output", () => {
  const truncated = classifyTscOutcome({
    stdout: POSITIONED,
    code: "ENOBUFS",
    failed: true,
  });
  assert.equal(truncated.kind, "fatal");
  assert.match(truncated.reason, /ENOBUFS/);

  const signalled = classifyTscOutcome({
    stdout: POSITIONED,
    signal: "SIGTERM",
    failed: true,
  });
  assert.equal(signalled.kind, "fatal");
  assert.match(signalled.reason, /SIGTERM/);

  const weirdStatus = classifyTscOutcome({ stdout: POSITIONED, status: 7, failed: true });
  assert.equal(weirdStatus.kind, "fatal");
  assert.match(weirdStatus.reason, /unexpected compiler exit status/);
});

test("informational summary lines are not mistaken for diagnostics", () => {
  assert.deepEqual(
    findUnpositionedDiagnostics("Found 0 errors.\nFound 3 errors in 2 files.\n"),
    []
  );
  assert.deepEqual(findUnpositionedDiagnostics(POSITIONED), []);
});

test("a missing compiler file is reported before spawning", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tsc-missing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.throws(
    () =>
      runTsc({
        rootDir: dir,
        tsconfigPath: path.join(dir, "tsconfig.json"),
      }),
    /TypeScript compiler not found/
  );
});
