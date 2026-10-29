// Targeted pnpm-only subprocess contracts for the Open SSE typecheck gate.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getTscCommand, runTsc } from "../../../scripts/check/check-open-sse-typecheck.mjs";

test("uses the workspace-installed tsc through Node, not a remote CLI runner", () => {
  const root = path.resolve("/example/repo");
  const { command, args } = getTscCommand(root, "/node/bin/node");
  assert.equal(command, "/node/bin/node");
  assert.deepEqual(args, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "--pretty", "false", "--noEmit", "-p",
    path.join(root, "open-sse", "tsconfig.json"),
  ]);
});

test("passes separate argv and cwd to the subprocess without shell", () => {
  const calls = [];
  const out = runTsc({
    rootDir: "/repo path with spaces",
    nodeExecutable: "/node executable",
    execFile(command, args, options) {
      calls.push({ command, args, options });
      return "all good";
    },
  });
  assert.equal(out, "all good");
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
  assert.equal(result, message);
});

test("tool launch failures without diagnostics are not suppressed", () => {
  const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  assert.throws(() => runTsc({ execFile() { throw err; } }), (e) => e === err);
});
