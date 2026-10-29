// scripts/check/lib/tscInvocation.mjs
// Shared, pnpm-native TypeScript invocation + fail-closed outcome classification for the
// scoped typecheck gates (open-sse, api, dashboard).
//
// Why this exists: the gates used to spawn `npx tsc` and swallow the exit status. That allowed
//  - a missing/failed compiler (e.g. npx printing "This is not the tsc command you are looking
//    for") to parse as ZERO diagnostics and PASS the gate, and
//  - `--update` to freeze an empty baseline over a broken toolchain.
// A compiler failure must never be mistaken for a clean typecheck.
//
// The compiler is the repository's own pnpm-managed TypeScript: `node <root>/node_modules/
// typescript/bin/tsc`, executed through `process.execPath` (no shell, no PATH shim, no Windows
// `.cmd` EINVAL, no implicit download).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseTscOutput } from "../typecheckBaseline.mjs";

/**
 * tsc exit statuses that mean "diagnostics were reported" and may therefore be compared with a
 * frozen baseline (0 = clean). Anything else — ENOBUFS, signals, spawn codes, unknown statuses —
 * means the invocation itself failed and must not be baselined.
 */
export const TSC_BASELINABLE_STATUSES = new Set([1, 2]);

/**
 * TypeScript formats a diagnostic that has no source position as `error TSnnnn: message`
 * (missing tsconfig, no inputs, missing global types, …). Positioned diagnostics always carry a
 * `file(line,col):` prefix, and informational output (`Found N errors in N files.`, help, watch
 * summaries) does not match this shape.
 */
const UNPOSITIONED_DIAGNOSTIC = /^error TS\d+:/;

const EXEC_OPTIONS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

/**
 * Builds the local compiler command. No shell interpolation: arguments are passed separately.
 * @param {{ rootDir: string, tsconfigPath: string, nodeExecutable?: string }} options
 */
export function getTscCommand({ rootDir, tsconfigPath, nodeExecutable = process.execPath }) {
  if (!rootDir) throw new TypeError("getTscCommand: rootDir is required");
  if (!tsconfigPath) throw new TypeError("getTscCommand: tsconfigPath is required");
  return {
    command: nodeExecutable,
    args: [
      path.join(rootDir, "node_modules", "typescript", "bin", "tsc"),
      "--pretty",
      "false",
      "--noEmit",
      "-p",
      tsconfigPath,
    ],
  };
}

/**
 * Runs the local compiler and reports WHY it exited, so callers can fail closed.
 *
 * Returns `{ stdout, stderr, status, code, signal, failed }`.
 * Launch failures that produced no stdout at all (e.g. ENOENT for a missing compiler) are
 * rethrown so the caller can report them explicitly instead of treating them as a result.
 * @param {{ rootDir: string, tsconfigPath: string, nodeExecutable?: string,
 *           execFile?: typeof execFileSync }} options
 */
export function runTsc({
  rootDir,
  tsconfigPath,
  nodeExecutable = process.execPath,
  execFile = execFileSync,
  exists = fs.existsSync,
}) {
  const { command, args } = getTscCommand({ rootDir, tsconfigPath, nodeExecutable });
  // Report a missing compiler as its own failure: Node would otherwise start and fail with a
  // MODULE_NOT_FOUND stack on stderr, which is easy to mistake for a compiler diagnostic.
  // Only for real spawns — an injected execFile owns its own process boundary in tests.
  if (execFile === execFileSync && !exists(args[0])) {
    const missing = new Error(`TypeScript compiler not found at ${args[0]}`);
    missing.code = "TSC_MISSING";
    throw missing;
  }
  try {
    const stdout = execFile(command, args, { ...EXEC_OPTIONS, cwd: rootDir });
    return {
      stdout: String(stdout ?? ""),
      stderr: "",
      status: 0,
      code: undefined,
      signal: undefined,
      failed: false,
    };
  } catch (err) {
    // A spawn failure has neither stdout nor an exit status: the compiler never ran.
    if (err?.stdout === undefined && err?.status === undefined) throw err;
    return {
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
      status: err.status,
      code: err.code,
      signal: err.signal,
      failed: true,
    };
  }
}

/** @returns {string[]} unpositioned `error TSxxxx:` lines, trimmed */
export function findUnpositionedDiagnostics(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => UNPOSITIONED_DIAGNOSTIC.test(line));
}

function countDiagnostics(live) {
  return Object.values(live).reduce(
    (sum, codes) => sum + Object.values(codes).reduce((inner, count) => inner + count, 0),
    0
  );
}

/**
 * Classifies a compiler result into:
 *   - `ok`:          exit 0, no diagnostics → compare with baseline (passes if consistent)
 *   - `type-errors`: exit 1/2 with parseable diagnostics → existing baseline comparison
 *   - `fatal`:       the invocation cannot be trusted → gate fails before any baseline write
 *
 * Fatal cases: unpositioned diagnostics (even mixed with positional ones, which the per-file
 * baseline cannot represent), signals, spawn codes (e.g. ENOBUFS after truncated output),
 * unexpected exit statuses, a non-zero exit with no parseable diagnostics, and an exit 0 that
 * still reported diagnostics.
 * @param {{ stdout?: string, status?: number, code?: string, signal?: string, failed?: boolean }} result
 */
export function classifyTscOutcome({ stdout = "", status, code, signal, failed = false } = {}) {
  const live = parseTscOutput(stdout);
  const liveErrorCount = countDiagnostics(live);
  const unpositioned = findUnpositionedDiagnostics(stdout);
  const fatal = (reason, detail = []) => ({
    kind: "fatal",
    live,
    liveErrorCount,
    unpositioned,
    reason,
    detail,
  });

  // An unpositioned diagnostic is invisible to the per-file baseline, so it is never
  // baselinable — including when parseable errors are present in the same output.
  if (unpositioned.length > 0) {
    return fatal("unpositioned compiler diagnostic", unpositioned.slice(0, 5));
  }
  if (signal) return fatal(`compiler terminated by signal ${signal}`);
  if (code) return fatal(`compiler invocation failed (${code})`);
  if (!failed) {
    if (liveErrorCount > 0) {
      return fatal("compiler exited 0 but reported diagnostics", []);
    }
    return { kind: "ok", live, liveErrorCount, unpositioned };
  }
  if (!TSC_BASELINABLE_STATUSES.has(status)) {
    return fatal(`unexpected compiler exit status ${String(status)}`);
  }
  if (liveErrorCount === 0) {
    return fatal("compiler exited non-zero without parseable diagnostics");
  }
  return { kind: "type-errors", live, liveErrorCount, unpositioned };
}
