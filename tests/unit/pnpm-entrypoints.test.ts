import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Source contract for issue #13 (Phase 1): every ACTIVE package.json script and every
 * tracked husky hook must use pnpm. pnpm is the only supported package manager here
 * (`packageManager` field, pnpm-lock.yaml, pnpm-workspace.yaml) and there is no root
 * package-lock.json, so an npm/npx entry point is a real defect, not a style nit.
 *
 * Scope is deliberate: the inherited upstream GitHub workflows are disabled and are
 * migrated in Phase 2, as are the npm-based `electron/` app and the pack-artifact
 * validator (which interprets `npm_execpath` as an npm-compatible CLI and verifies
 * `npm pack` output). Those are allowlisted below WITH a reason — and the allowlist is
 * stale-enforced, so an exemption disappears the moment its script stops using npm.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const scripts: Record<string, string> = pkg.scripts;

/** An npm/npx command token — `pnpm` never matches (`\b` fails between "p" and "n"). */
const NPM_TOKEN = /\bnpm(?:\.cmd)?(?=\s|:|$)/;
const NPX_TOKEN = /\bnpx\b/;

/** Scripts intentionally left on npm until Phase 2. Keep in sync with the issue. */
const NPM_ALLOWED: Record<string, string> = {
  "electron:dev":
    "electron/ is npm-installed with its own package-lock.json and its own npm script bodies; desktop entry points migrate with the electron app (Phase 2).",
  "electron:build":
    "electron/ is npm-installed with its own package-lock.json and its own npm script bodies; desktop entry points migrate with the electron app (Phase 2).",
  "electron:build:win":
    "electron/ is npm-installed with its own package-lock.json and its own npm script bodies; desktop entry points migrate with the electron app (Phase 2).",
  "electron:build:mac":
    "electron/ is npm-installed with its own package-lock.json and its own npm script bodies; desktop entry points migrate with the electron app (Phase 2).",
  "electron:build:linux":
    "electron/ is npm-installed with its own package-lock.json and its own npm script bodies; desktop entry points migrate with the electron app (Phase 2).",
  "audit:electron":
    "`pnpm audit` reads pnpm-lock.yaml; electron/ only has package-lock.json. Migrates when electron/ joins the pnpm workspace (Phase 2).",
  prepublishOnly:
    "validate-pack-artifact.ts treats npm_execpath as an npm-compatible CLI and verifies `npm pack` output; converting this would make it pack with pnpm. Migrates with the pack tooling (Phase 2).",
};

function npmScripts(): string[] {
  return Object.entries(scripts)
    .filter(([, body]) => NPM_TOKEN.test(body) || NPX_TOKEN.test(body))
    .map(([name]) => name)
    .sort();
}

const readHook = (name: string) => readFileSync(path.join(ROOT, ".husky", name), "utf8");

test("no active package.json script shells out to npm or npx", () => {
  const offenders = npmScripts().filter((name) => !Object.hasOwn(NPM_ALLOWED, name));
  assert.deepEqual(
    offenders,
    [],
    `these scripts must use pnpm (see issue #13): ${offenders.join(", ")}`
  );
});

test("the npm allowlist carries no stale exemption", () => {
  for (const name of Object.keys(NPM_ALLOWED)) {
    assert.ok(Object.hasOwn(scripts, name), `allowlisted script no longer exists: ${name}`);
    assert.match(
      scripts[name],
      /npm/,
      `${name} is no longer npm-based — drop it from NPM_ALLOWED instead of leaving dead policy`
    );
  }
});

test("packageManager pins pnpm", () => {
  assert.match(pkg.packageManager ?? "", /^pnpm@\d+\./, "packageManager must pin pnpm");
});

test("build/test/quality entry points delegate through pnpm run", () => {
  assert.equal(scripts["prebuild"], "pnpm run check:native-deps");
  assert.equal(scripts["prebuild:fast"], "pnpm run check:native-deps");
  assert.match(scripts["build:release"], / pnpm run build && pnpm run build:cli /);

  for (const name of ["test", "test:unit", "test:unit:ci", "test:unit:fast"]) {
    assert.ok(
      scripts[name].endsWith("&& pnpm run test:unit:serial"),
      `${name} must chain the serial quarantine through pnpm`
    );
  }
  assert.match(scripts["test:coverage"], / pnpm run test:coverage:runner$/);
  assert.match(scripts["test:coverage:runner"], /&& pnpm run test:unit:serial$/);
  assert.equal(
    scripts["test:all"],
    "pnpm run test:unit && pnpm run test:vitest && pnpm run test:vitest:ui && pnpm run test:ecosystem && pnpm run test:e2e"
  );
  assert.equal(scripts["check"], "pnpm run lint && pnpm run test");
  assert.ok(scripts["check:docs-all"].startsWith("pnpm run check:docs-sync &&"));
  assert.equal(
    scripts["quality:gate"],
    "pnpm run quality:collect && pnpm run quality:ratchet -- --allow-missing"
  );
});

test("shard fan-out and out-of-tree tools stay pnpm-native", () => {
  // concurrently maps the `pnpm:` shortcut to `pnpm run` (no npm shim involved).
  assert.match(scripts["test:unit:shard"], /"pnpm:test:unit:shard:1" "pnpm:test:unit:shard:2"/);
  // markdownlint-cli2 and node-gyp are NOT in node_modules/.bin, so `pnpm exec` would
  // fail; `pnpm dlx` is the faithful replacement for `npx --yes`.
  assert.ok(scripts["lint:md"].startsWith("pnpm dlx markdownlint-cli2 "));
  assert.equal(
    scripts["build:native:tproxy"],
    "cd src/mitm/tproxy/native && pnpm dlx node-gyp rebuild"
  );
  // pnpm 12 supports --audit-level and exits non-zero at/above it, same as npm.
  assert.ok(scripts["audit:deps"].startsWith("pnpm audit --audit-level=critical"));
  assert.match(scripts["audit:deps"], /&& pnpm run audit:electron$/);
});

test("the gate inventory matches the pnpm script bodies verbatim", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "config/quality/gate-manifest.json"), "utf8")
  );
  for (const entry of manifest.aliases) {
    if (!Object.hasOwn(scripts, entry.name)) continue;
    assert.equal(
      entry.command,
      scripts[entry.name],
      `gate-manifest.json drifted from package.json for ${entry.name}`
    );
  }
});

test("pre-push uses pnpm and stays a no-op", () => {
  const hook = readHook("pre-push");
  assert.doesNotMatch(hook, NPM_TOKEN, "pre-push must not reference npm");
  assert.match(hook, /\bpnpm\b/, "pre-push guard/reminder must speak pnpm");

  // Lightweight invariant: apart from comments, echoes and the PATH guard, the hook only
  // exits. If a gate is ever added here it must be a deliberate change, not a drive-by.
  const executable = hook
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(
      (line) =>
        !line.startsWith("#") &&
        !line.startsWith("echo ") &&
        !line.startsWith("if ") &&
        line !== "fi"
    );
  assert.deepEqual(executable, ["exit 0", "exit 0"], "pre-push must not run gates");
});

test("pre-commit stays pnpm-only", () => {
  const hook = readHook("pre-commit");
  assert.doesNotMatch(hook, NPM_TOKEN, "pre-commit must not reference npm");
  assert.match(hook, /pnpm exec lint-staged --no-stash/);
  assert.match(hook, /pnpm run check:any-budget:t11/);
});
