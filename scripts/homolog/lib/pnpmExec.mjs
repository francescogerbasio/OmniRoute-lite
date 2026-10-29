// scripts/homolog/lib/pnpmExec.mjs
// Tool execution for the homologation suite (maintainer-only, live VPS run).
//
// Why a platform guard: the suite drives its tools with `pnpm exec <tool>`, which needs the
// `pnpm` binary to be spawned WITHOUT a shell. On Windows `pnpm` is a `pnpm.cmd` shim and
// Node >= 20 refuses to spawn a `.cmd` without `shell: true`; with `shell: true` Node joins the
// command and arguments into one command line, so the suite's dynamic values (HOMOLOG_BASE_URL,
// the ephemeral API key, model IDs read from the live catalog) would be interpreted by cmd.exe.
// That is a command-injection surface (Node DEP0190), and it buys nothing: homologation targets
// a Linux VPS and is documented as Linux/macOS-only. So unsupported platforms fail closed here,
// before any network call or ephemeral credential is created, instead of maintaining an unsafe
// execution path.

import { spawnSync } from "node:child_process";

export const SUPPORTED_HOMOLOG_PLATFORMS = new Set(["linux", "darwin"]);

/**
 * Throws on platforms where `pnpm exec` cannot be spawned safely (no shell).
 * @param {string} [platform]
 */
export function assertSupportedPlatform(platform = process.platform) {
  if (!SUPPORTED_HOMOLOG_PLATFORMS.has(platform)) {
    const error = new Error(
      `[homolog] unsupported platform "${platform}". The homologation suite is Linux/macOS-only: ` +
        `it spawns pnpm with separate argv and no shell, and Windows would require spawning through ` +
        `a shell (command-injection risk for the suite's dynamic arguments). Run it from ` +
        `Linux/macOS or a container.`
    );
    error.code = "ERR_HOMOLOG_UNSUPPORTED_PLATFORM";
    throw error;
  }
}

/**
 * Runs a workspace-installed tool through `pnpm exec` with separate argv and no shell.
 * `platform`/`spawn` are injectable so the unsupported-platform path is testable without
 * executing real homologation or spawning anything.
 * @param {string} tool
 * @param {string[]} args
 * @param {Record<string, unknown>} [options] spawnSync options
 * @param {{ platform?: string, spawn?: typeof spawnSync }} [deps]
 */
export function runPnpmExec(
  tool,
  args,
  options = {},
  { platform = process.platform, spawn = spawnSync } = {}
) {
  assertSupportedPlatform(platform);
  // The no-shell guarantee is enforced here, not just documented: a caller-supplied shell
  // would hand the suite's dynamic arguments to a command interpreter.
  if (options?.shell) {
    const error = new Error(
      `[homolog] refusing to spawn "${tool}" with a command interpreter enabled. The ` +
        `homologation suite requires separate argv and no shell so dynamic values are never ` +
        `interpreted; remove the shell option from the spawn options.`
    );
    error.code = "ERR_HOMOLOG_SHELL_FORBIDDEN";
    throw error;
  }
  return spawn("pnpm", ["exec", tool, ...args], options);
}
