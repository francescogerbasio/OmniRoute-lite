// tests/unit/build/lite-ci-install-order.test.ts
// Contract for the Lite CI install ordering (issue #13 / #23).
//
// The supply-chain gate is only preventive if NO dependency lifecycle script can run before it.
// The workflow therefore installs with `pnpm install --frozen-lockfile --ignore-scripts`, runs
// `pnpm run check:lockfile`, and only then loads prebuilt native modules for the test suites.
// These assertions keep that ordering from silently regressing (a plain `pnpm install`, a bare
// `pnpm rebuild`, or an `approve-builds` step would re-open script execution before the gate).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import { validateLockfile } from "../../../scripts/check/check-lockfile.mjs";

import * as yaml from "js-yaml";

const ROOT = path.join(import.meta.dirname, "../../..");
const WORKFLOW = path.join(ROOT, ".github/workflows/lite-ci.yml");
const workflow = yaml.load(fs.readFileSync(WORKFLOW, "utf8")) as {
  jobs: Record<
    string,
    { name?: string; steps: { name?: string; run?: string; env?: Record<string, string> }[] }
  >;
};

const core = workflow.jobs.core;
const stepIndex = (predicate: (step: { run?: string; name?: string }) => boolean) =>
  core.steps.findIndex(predicate);

test("the workflow keeps exactly the two required job names", () => {
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["contracts", "core"]);
  assert.equal(workflow.jobs.contracts.name, "Entrypoint contracts");
  assert.equal(workflow.jobs.core.name, "Typecheck + tests");
});

test("core installs with --frozen-lockfile --ignore-scripts", () => {
  const install = core.steps.find((step) => /\bpnpm install\b/.test(step.run ?? ""));
  assert.ok(install, "core must have an install step");
  assert.match(install.run ?? "", /--frozen-lockfile/);
  assert.match(install.run ?? "", /--ignore-scripts/);
});

test("the lockfile gate runs after install and before anything that could execute scripts", () => {
  const installIndex = stepIndex((step) => /\bpnpm install\b/.test(step.run ?? ""));
  const gateIndex = stepIndex((step) =>
    /pnpm run --silent check:lockfile|pnpm run check:lockfile/.test(step.run ?? "")
  );
  const smokeIndex = stepIndex((step) => /lite-ci-native-smoke\.test\.ts/.test(step.run ?? ""));

  assert.ok(installIndex !== -1, "install step missing");
  assert.ok(gateIndex !== -1, "lockfile gate step missing");
  assert.ok(gateIndex > installIndex, "the gate must run after the (script-free) install");
  assert.ok(smokeIndex > gateIndex, "native smoke (module loading) must run after the gate");
});

test("native smoke is enabled and proves the prebuilt modules", () => {
  const smoke = core.steps.find((step) => /lite-ci-native-smoke\.test\.ts/.test(step.run ?? ""));
  assert.ok(smoke, "native smoke step missing");
  assert.equal(smoke.env?.OMNIROUTE_LITE_CI_NATIVE_SMOKE, "1");
});

test("no step may re-enable dependency lifecycle scripts", () => {
  for (const step of core.steps) {
    const run = step.run ?? "";
    assert.doesNotMatch(
      run,
      /\bpnpm\s+rebuild\b/,
      `${step.name}: bare/pnpm rebuild re-enables build scripts`
    );
    assert.doesNotMatch(
      run,
      /\bpnpm\s+approve-builds\b/,
      `${step.name}: approve-builds must stay out of CI`
    );
    assert.doesNotMatch(run, /--pending/, `${step.name}: --pending rebuilds skipped scripts`);
    for (const match of run.matchAll(/\bpnpm\s+install\b[^\n]*/g)) {
      assert.match(
        match[0],
        /--ignore-scripts/,
        `${step.name}: every pnpm install must pass --ignore-scripts`
      );
    }
  }
});

test("the contracts job stays dependency-free", () => {
  for (const step of workflow.jobs.contracts.steps) {
    assert.doesNotMatch(
      step.run ?? "",
      /\bpnpm\s+install\b/,
      "contracts must not install dependencies"
    );
  }
});

test("the existing regression suites are still wired", (t) => {
  const stepRun = (needle: string) =>
    core.steps.find((step) => (step.run ?? "").includes(needle))?.run ?? "";

  const dataIsolation = stepRun("data-isolation-lite.test.ts");
  for (const file of [
    "tests/unit/data-isolation-lite.test.ts",
    "tests/unit/cli-data-dir-env.test.ts",
    "tests/unit/cli-storage-key-provision.test.ts",
    "tests/unit/cli-storage-key-bootstrap.test.ts",
  ]) {
    assert.ok(dataIsolation.includes(file), `data-isolation step lost ${file}`);
  }

  const api = stepRun("chat-route-coverage.test.ts");
  for (const file of [
    "tests/unit/chat-route-coverage.test.ts",
    "tests/unit/api/v1-catchall-json-404.test.ts",
    "tests/unit/authz/client-api-policy.test.ts",
    "tests/unit/10017-sse-control-lines-leak-openai-clients.test.ts",
    "tests/unit/translator-stream-transform.test.ts",
    "tests/unit/tool-use-id-sanitization.test.ts",
    "tests/unit/stream-utilities.test.ts",
  ]) {
    assert.ok(api.includes(file), `API step lost ${file}`);
  }

  const contracts = workflow.jobs.contracts.steps
    .map((step) => step.run ?? "")
    .find((run) => run.includes("pnpm-entrypoints.test.ts"));
  assert.ok(contracts, "contracts job lost its test step");
  for (const file of [
    "tests/unit/pnpm-entrypoints.test.ts",
    "tests/unit/test-serial-quarantine.test.ts",
    "tests/unit/build/pre-commit-safety.test.ts",
    "tests/unit/build/gate-manifest.test.ts",
  ]) {
    assert.ok(contracts.includes(file), `contracts job lost ${file}`);
  }
  void t;
});

// ---------------------------------------------------------------------------
// pnpm semantics the ordering relies on (offline file: fixture)
// ---------------------------------------------------------------------------

function pnpmAvailable() {
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lite-order-"));
  const marker = path.join(dir, "marker.txt");
  // A project lifecycle script is the cleanest observable: pnpm runs it on a normal install and
  // skips it under --ignore-scripts, exactly like the dependency build scripts CI must suppress.
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      scripts: {
        postinstall: "node -e \"require('fs').writeFileSync(process.env.MARKER_PATH, 'ran')\"",
      },
    })
  );
  return { dir, marker };
}

const pnpmEnv = (marker: string) => ({ ...process.env, MARKER_PATH: marker });

test("--ignore-scripts suppresses lifecycle scripts; a normal install runs them", (t) => {
  if (!pnpmAvailable()) {
    t.skip("pnpm is not available on PATH");
    return;
  }
  const { dir, marker } = writeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  execFileSync("pnpm", ["install", "--ignore-scripts", "--offline"], {
    cwd: dir,
    env: pnpmEnv(marker),
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(fs.existsSync(marker), false, "--ignore-scripts must not run lifecycle scripts");

  fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
  execFileSync("pnpm", ["install", "--offline"], {
    cwd: dir,
    env: pnpmEnv(marker),
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    fs.existsSync(marker),
    true,
    "the fixture must be able to run its script at all, otherwise the assertion above is vacuous"
  );
});

test("the gate rejects a corrupted lockfile while no lifecycle script has run", (t) => {
  if (!pnpmAvailable()) {
    t.skip("pnpm is not available on PATH");
    return;
  }
  const { dir, marker } = writeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  execFileSync("pnpm", ["install", "--ignore-scripts", "--offline"], {
    cwd: dir,
    env: pnpmEnv(marker),
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(fs.existsSync(marker), false);

  // Inject an insecure resolution the way a compromised lockfile would.
  const lockPath = path.join(dir, "pnpm-lock.yaml");
  const sha512 = `sha512-${createHash("sha512").update("evil").digest("base64")}`;
  const evil = `  evil-pkg@1.0.0:\n    resolution:\n      tarball: http://evil.example/evil.tgz\n      integrity: ${sha512}\n`;
  const lock = fs.readFileSync(lockPath, "utf8");
  fs.writeFileSync(
    lockPath,
    lock.includes("packages:")
      ? lock.replace("packages:\n", `packages:\n${evil}`)
      : `${lock.trimEnd()}\npackages:\n${evil}`
  );

  // CI order: script-free install, then the gate. Whether pnpm itself rejects the edit is
  // irrelevant to the guarantee being asserted — no lifecycle script may have run.
  try {
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--offline"], {
      cwd: dir,
      env: pnpmEnv(marker),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // an out-of-date/corrupt lockfile may fail the install; that is not a failure of this test
  }
  assert.equal(fs.existsSync(marker), false, "no lifecycle script may run before the gate");

  const { errors } = validateLockfile(dir);
  assert.ok(errors.length > 0, "the gate must reject the corrupted lockfile");
  assert.ok(
    errors.some((error: { code: string }) => error.code === "insecure-transport"),
    `expected insecure-transport, got ${errors.map((error: { code: string }) => error.code).join(", ")}`
  );
});
