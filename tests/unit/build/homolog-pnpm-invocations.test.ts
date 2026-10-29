// tests/unit/build/homolog-pnpm-invocations.test.ts
// Maintainer-suite contract: the homologation runner must drive its external tools through
// `pnpm exec` (workspace-installed binaries) instead of `npx`, which can resolve or download a
// package the repository never declared.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "../../..");
const RUNNER = path.join(ROOT, "scripts/homolog/run.mjs");

const source = fs.readFileSync(RUNNER, "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);

const TOOLS = ["httpyac", "promptfoo", "playwright", "junit-to-ctrf", "ctrf"];

test("the homologation runner never spawns npx or npm", () => {
  // Quoted command tokens: what a regression would actually add back.
  assert.doesNotMatch(source, /["']npx(?:\.cmd)?["']/, "homolog must not spawn npx");
  assert.doesNotMatch(source, /["']npm(?:\.cmd)?["']/, "homolog must not spawn npm");
  assert.doesNotMatch(source, /\bnpm\s+(?:exec|install|run)\b/, "no npm execution forms");
});

test("every external tool runs through pnpm exec", () => {
  assert.match(
    source,
    /const PNPM_COMMAND = process\.platform === "win32" \? "pnpm\.cmd" : "pnpm"/
  );
  assert.match(source, /spawnSync\(PNPM_COMMAND, \["exec", tool, \.\.\.args\]/);

  for (const tool of TOOLS) {
    const invocation = new RegExp(`runPnpmExec\\(\\s*"${tool.replace("-", "\\-")}"`);
    assert.match(source, invocation, `${tool} must be invoked via runPnpmExec`);
    // The bare `npx <tool>` form must be gone.
    assert.doesNotMatch(source, new RegExp(`"npx",\\s*\\[\\s*"${tool.replace("-", "\\-")}"`));
  }
});

test("every tool the runner drives is a declared dependency", () => {
  for (const tool of TOOLS) {
    assert.ok(
      declared.has(tool),
      `${tool} must be declared in package.json (pnpm exec resolves it locally; no implicit download)`
    );
  }
});
