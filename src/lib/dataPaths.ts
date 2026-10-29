import path from "path";
import os from "os";
import fs from "fs";

export const APP_NAME = "omniroute-lite";

/**
 * Upstream OmniRoute app name. The Lite fork must never adopt upstream's
 * `~/.omniroute` as its runtime data dir. This constant exists only so the
 * one-time migration helpers can locate the upstream directory as a
 * read-only source (opt-in); it must never be used to resolve a default.
 */
export const LEGACY_UPSTREAM_APP_NAME = "omniroute";

function fallbackHomeDir() {
  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (typeof envHome === "string" && envHome.trim().length > 0) {
    return path.resolve(envHome);
  }

  return os.tmpdir();
}

function safeHomeDir() {
  try {
    return os.homedir();
  } catch {
    return fallbackHomeDir();
  }
}

function normalizeConfiguredPath(dir: unknown): string | null {
  if (typeof dir !== "string") return null;
  const trimmed = dir.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

export function getLegacyDotDataDir() {
  // Pinned to the upstream app name on purpose: this is the migration *source*
  // (the old `~/.omniroute`), never the Lite default. See LEGACY_UPSTREAM_APP_NAME.
  return path.join(safeHomeDir(), `.${LEGACY_UPSTREAM_APP_NAME}`);
}

export function getDefaultDataDir() {
  const homeDir = safeHomeDir();

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, APP_NAME);
  }

  // Support XDG on Linux/macOS when explicitly configured.
  const xdgConfigHome = normalizeConfiguredPath(process.env.XDG_CONFIG_HOME);
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, APP_NAME);
  }

  // Lite default. Unlike upstream, an existing legacy directory is NEVER adopted
  // here — silently reusing `~/.omniroute` would cross-contaminate the operator's
  // upstream OmniRoute database and credentials with Lite traffic.
  return path.join(homeDir, `.${APP_NAME}`);
}

export function resolveDataDir({ isCloud = false }: { isCloud?: boolean } = {}): string {
  if (isCloud) return "/tmp";

  const configured = normalizeConfiguredPath(process.env.DATA_DIR);
  if (configured) return configured;

  return getDefaultDataDir();
}

/**
 * Resolve the data directory and guarantee it is writable.
 *
 * Unlike {@link resolveDataDir} (a pure, side-effect-free path resolver used by
 * many callers), this variant probes the resolved directory by attempting to
 * create it and verify write access. When a configured `DATA_DIR` is not
 * writable (`EACCES`/`EPERM`/`EROFS`), it FAILS CLOSED with an actionable
 * error instead of silently falling back: diverting the database (and its
 * encrypted credentials) to a directory the operator did not choose would be
 * indistinguishable from data loss. Any other error (e.g. `ENOTDIR`,
 * `ENOSPC`) also propagates.
 *
 * Use this only at the single startup site that owns directory creation
 * (currently `db/core.ts`); everywhere else keep using the pure resolver.
 */
/**
 * #10428: true when this process looks like a test run rather than a server start.
 *
 * `NODE_TEST_CONTEXT` is set by `node --test` in every spawned test process, `VITEST` by
 * vitest, and `NODE_ENV=test` by the npm scripts — between them they cover both runners
 * plus the AGENTS.md single-file command, which does NOT load
 * `tests/_setup/isolateDataDir.ts`.
 */
export function isTestContext(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    !!process.env.VITEST ||
    !!process.env.NODE_TEST_CONTEXT ||
    process.execArgv.includes("--test") ||
    process.argv.includes("--test")
  );
}

/**
 * `node --eval` / `node -e` (and their print variants) are common shapes used by
 * one-off import probes.
 * Such a process has no application entry point from which to establish storage intent,
 * so defaulting it to the operator's durable database is unsafe. A deliberate production
 * inspection can still opt in with an explicit DATA_DIR (preferred) or
 * OMNIROUTE_ALLOW_DEFAULT_DATA_DIR=1.
 */
function isEvalProbeContext(): boolean {
  return process.execArgv.some(
    (arg) =>
      arg === "--eval" ||
      arg === "-e" ||
      arg === "-pe" ||
      arg === "-ep" ||
      arg.startsWith("--eval=") ||
      arg === "--print" ||
      arg === "-p" ||
      arg.startsWith("--print=")
  );
}

/** Process-wide redirect target, so repeated calls share one DB instead of one per call. */
let testContextDataDir: string | null = null;
let testContextCleanupRegistered = false;

export function resolveWritableDataDir({ isCloud = false }: { isCloud?: boolean } = {}): string {
  const resolved = resolveDataDir({ isCloud });
  const configured = normalizeConfiguredPath(process.env.DATA_DIR);

  // Cloud/serverless never owns a writable home dir; leave its sentinel alone.
  if (isCloud) return resolved;

  // Issue #11 policy: pointing DATA_DIR explicitly at upstream's `~/.omniroute`
  // stays legal (it is the operator's deliberate choice for migration/inspection),
  // but it must never happen silently — sharing this directory shares provider
  // credentials, storage and the CLI token salt with upstream OmniRoute.
  if (configured && isSamePath(configured, getLegacyDotDataDir())) {
    console.warn(
      `[DATA_DIR] ⚠️  DATA_DIR points at upstream OmniRoute's directory ('${configured}'). ` +
        `OmniRoute Lite will share provider credentials, storage and the CLI token salt ` +
        `with upstream OmniRoute. This is intended only for a deliberate one-time ` +
        `migration/inspection — unset DATA_DIR to isolate Lite in its default directory.`
    );
  }

  // #10428: a test/eval-probe run that never chose a DATA_DIR would otherwise open the
  // OPERATOR'S REAL database (~/.omniroute-lite/storage.sqlite — live provider credentials).
  // Redirect to a throwaway dir instead of throwing: the documented single-file command
  // (`node --import tsx/esm --test tests/unit/x.test.ts`) does not load the isolation
  // setup, and a hard failure there would only teach people to disable the guard.
  // `OMNIROUTE_ALLOW_DEFAULT_DATA_DIR=1` opts back in, so the intent is recorded.
  if (
    !configured &&
    (isTestContext() || isEvalProbeContext()) &&
    process.env.OMNIROUTE_ALLOW_DEFAULT_DATA_DIR !== "1"
  ) {
    if (!testContextDataDir) {
      testContextDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_NAME}-testctx-`));
      if (!testContextCleanupRegistered) {
        testContextCleanupRegistered = true;
        process.once("exit", () => {
          if (!testContextDataDir) return;
          try {
            fs.rmSync(testContextDataDir, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 25,
            });
          } catch {
            // An unclean exit is left to the operating system's temp-directory policy.
          }
        });
      }
      console.warn(
        `[DATA_DIR] test/eval context without DATA_DIR → using '${testContextDataDir}' instead of ` +
          `'${resolved}'. Set DATA_DIR explicitly (or load tests/_setup/isolateDataDir.ts) to silence this.`
      );
    }
    return testContextDataDir;
  }

  // No explicit override → already the default user dir; nothing to fall back to.
  if (!configured) return resolved;

  try {
    fs.mkdirSync(resolved, { recursive: true });
    // An existing directory makes mkdirSync a no-op even when it is NOT writable
    // (read-only mount, wrong owner). Prove writability explicitly so a bad
    // operator-supplied path fails closed here, at the one site that owns
    // directory creation, instead of failing later mid-DB-write.
    fs.accessSync(resolved, fs.constants.W_OK);
    return resolved;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new Error(
        `[DATA_DIR] Configured DATA_DIR '${resolved}' is not writable (${code}). ` +
          `Refusing to fall back to a different directory: the database and its encrypted ` +
          `credentials must live where the operator chose. Fix the permissions on this path, ` +
          `or set DATA_DIR to a writable location and restart.`
      );
    }
    throw err;
  }
}

export function isSamePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const normalizedA = path.resolve(a);
  const normalizedB = path.resolve(b);

  if (process.platform === "win32") {
    return normalizedA.toLowerCase() === normalizedB.toLowerCase();
  }

  return normalizedA === normalizedB;
}
