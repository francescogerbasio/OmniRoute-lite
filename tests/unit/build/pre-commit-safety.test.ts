import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const hook = readFileSync(new URL("../../../.husky/pre-commit", import.meta.url), "utf8");

function runHook(extra: Record<string, string> = {}) {
  // Execute the checked-in hook. Only the external tools are fixtures; no real
  // stash, index mutation or dependency installation is permitted by the probe.
  // The package manager is pnpm (packageManager field; issue #13) — npm/npx must
  // never be reachable from this hook, so only `pnpm` is answered here.
  const tools = `
command() { if [ "$1 $2" = "-v pnpm" ] && [ "$MOCK_PNPM_MISSING" = "1" ]; then return 1; fi; builtin command "$@"; }
pnpm() { printf 'PNPM:%s\\n' "$*"; return "$MOCK_LINT_EXIT"; }
node() { printf 'NODE:%s\\n' "$*"; }
sh() { printf 'SH:%s\\n' "$*"; }
`;
  return spawnSync("bash", ["-c", `${tools}\n${hook}`], {
    encoding: "utf8",
    env: { ...process.env, MOCK_PNPM_MISSING: "0", MOCK_LINT_EXIT: "0", ...extra },
  });
}

test("hook never stashes and never downloads a missing lint-staged", () => {
  const result = runHook();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PNPM:exec lint-staged --no-stash/);
  assert.match(result.stdout, /NODE:scripts\/check\/check-tracked-artifacts\.mjs/);
});

test("missing pnpm blocks the commit instead of silently skipping all checks", () => {
  const result = runHook({ MOCK_PNPM_MISSING: "1" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /NODE:|PNPM:/);
});

test("failed lint-staged preserves its exit even when the hook is executed directly", () => {
  const result = runHook({ MOCK_LINT_EXIT: "42" });
  assert.equal(result.status, 42);
  assert.doesNotMatch(result.stdout, /NODE:/);
});
