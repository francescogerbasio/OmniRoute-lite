// Targeted pnpm-only subprocess contracts for the Open SSE typecheck gate.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  getTscCommand,
  runTsc,
  isUnparsedTypecheckFailure,
} from "../../../scripts/check/check-open-sse-typecheck.mjs";
// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import { parseTscOutput } from "../../../scripts/check/typecheckBaseline.mjs";

test("uses the workspace-installed tsc through Node, not a remote CLI runner", () => {
  const root = path.resolve("/example/repo");
  const { command, args } = getTscCommand(root, "/node/bin/node");
  assert.equal(command, "/node/bin/node");
  assert.deepEqual(args, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "--pretty",
    "false",
    "--noEmit",
    "-p",
    path.join(root, "open-sse", "tsconfig.json"),
  ]);
});

test("the resolved TypeScript entry exists in this repository", () => {
  // Guard against a TypeScript major relocating `bin/tsc`: without this the gate would fail
  // with a raw ENOENT instead of a readable contract violation.
  const { command, args } = getTscCommand();
  assert.equal(command, process.execPath);
  assert.ok(fs.existsSync(args[0]), `missing TypeScript entrypoint: ${args[0]}`);
});

test("passes separate argv and cwd to the subprocess without shell", () => {
  const calls = [];
  const result = runTsc({
    rootDir: "/repo path with spaces",
    nodeExecutable: "/node executable",
    execFile(command, args, options) {
      calls.push({ command, args, options });
      return "all good";
    },
  });
  assert.deepEqual(result, { stdout: "all good", failed: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/node executable");
  assert.equal(calls[0].options.cwd, "/repo path with spaces");
  assert.deepEqual(calls[0].args.slice(1, 4), ["--pretty", "false", "--noEmit"]);
  assert.equal(calls[0].options.shell, undefined);
});

test("nonzero tsc with diagnostic stdout remains baselinable", () => {
  const message = "open-sse/demo.ts(3,1): error TS2304: Cannot find name 'demo'.\n";
  const result = runTsc({
    execFile() {
      throw Object.assign(new Error("tsc exit 2"), { stdout: message, status: 2 });
    },
  });
  assert.deepEqual(result, { stdout: message, failed: true });
  assert.equal(Object.keys(parseTscOutput(result.stdout)).length, 1);
  assert.equal(isUnparsedTypecheckFailure({ failed: result.failed, liveErrorCount: 1 }), false);
});

test("tool launch failures without diagnostics are not suppressed", () => {
  const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  assert.throws(
    () =>
      runTsc({
        execFile() {
          throw err;
        },
      }),
    (e) => e === err
  );
});

test("a nonzero exit without parseable diagnostics fails closed", () => {
  // Real shape observed from `tsc --noEmit -p <missing>`: exit 1 on stdout, no `file(l,c)` prefix.
  const stdout = "error TS5058: The specified path does not exist: '/missing/tsconfig.json'.\n";
  const parsed = parseTscOutput(stdout);
  const liveErrorCount = Object.keys(parsed).length;

  assert.deepEqual(parsed, {});
  assert.equal(
    isUnparsedTypecheckFailure({ failed: true, liveErrorCount }),
    true,
    "an unparsed compiler failure must not be treated as zero type errors"
  );
  assert.equal(isUnparsedTypecheckFailure({ failed: false, liveErrorCount: 0 }), false);
  assert.equal(isUnparsedTypecheckFailure({ failed: true, liveErrorCount: 2 }), false);
});
