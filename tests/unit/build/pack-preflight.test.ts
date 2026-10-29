// tests/unit/build/pack-preflight.test.ts
// Packaging preflight contracts (issue #13/#23, PR B).
//
// The preflight must prove what pnpm would really pack (Level B) without building, installing or
// executing lifecycle scripts, and it must never let an unbuilt artifact read as publishable.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error — .ts helper; runtime shape is known.
import {
  buildPackArgs,
  evaluatePackArtifact,
  inspectManifest,
  parsePnpmPackJson,
  parseArgs,
  runPack,
} from "../../../scripts/build/pack-preflight.ts";

const ROOT = path.join(import.meta.dirname, "../../..");
const CLI = path.join(ROOT, "scripts/build/pack-preflight.ts");

function makeDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omniroute-${prefix}-`));
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function preflightTempDirs(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((entry) => entry.startsWith("omniroute-pack-preflight-"));
}

// ---------------------------------------------------------------------------
// pnpm pack JSON (real pnpm 12 shape: a single object, not an array)
// ---------------------------------------------------------------------------

test("parses the pnpm 12 single-object report", () => {
  const report = parsePnpmPackJson(
    JSON.stringify({
      name: "fixture",
      version: "1.2.3",
      filename: "/tmp/out/fixture-1.2.3.tgz",
      files: [{ path: "package.json" }, { path: "dist/server.js" }],
    })
  );
  assert.equal(report.name, "fixture");
  assert.equal(report.version, "1.2.3");
  assert.equal(report.filename, "/tmp/out/fixture-1.2.3.tgz");
  assert.deepEqual(report.files, ["package.json", "dist/server.js"]);
});

test("accepts an array report but rejects unusable output", () => {
  const arrayReport = parsePnpmPackJson(
    JSON.stringify([{ name: "fixture", version: "1.0.0", files: [{ path: "package.json" }] }])
  );
  assert.deepEqual(arrayReport.files, ["package.json"]);

  assert.throws(() => parsePnpmPackJson("not json"), /did not return valid JSON/);
  assert.throws(() => parsePnpmPackJson('{"name":"x"}'), /no `files\[\]` list/);
  assert.throws(() => parsePnpmPackJson('{"files":[]}'), /empty file list/);
});

// ---------------------------------------------------------------------------
// policy evaluation / severity model
// ---------------------------------------------------------------------------

const REQUIRED = ["dist/server.js", "bin/omniroute.mjs", "config/app.json"];
const COMPLETE_FILES = ["package.json", "bin/omniroute.mjs", "config/app.json", "dist/server.js"];
// Hermetic policy: the synthetic paths above are not the product's allowlist.
const POLICY = {
  requiredPaths: REQUIRED,
  allowedExactPaths: ["package.json", "config/app.json", "bin/omniroute.mjs"],
  allowedPrefixes: ["dist/"],
};

test("a complete, policy-clean artifact is valid", () => {
  const evaluation = evaluatePackArtifact(COMPLETE_FILES, POLICY);
  assert.equal(evaluation.status, "valid");
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.missingRequired, []);
});

test("only missing dist/ artifacts is INCOMPLETE, never 'valid'", () => {
  const files = ["package.json", "bin/omniroute.mjs", "config/app.json"];
  const unbuilt = evaluatePackArtifact(files, POLICY);
  assert.equal(unbuilt.status, "incomplete");
  assert.equal(unbuilt.ok, true, "unbuilt checkouts must not fail the default preflight");
  assert.deepEqual(unbuilt.missingBuildArtifacts, ["dist/server.js"]);
  assert.deepEqual(unbuilt.missingSourceArtifacts, []);

  const strict = evaluatePackArtifact(files, { ...POLICY, requireComplete: true });
  assert.equal(strict.status, "incomplete");
  assert.equal(strict.ok, false, "--require-complete must reject an unbuilt artifact");
});

test("a missing non-build file is invalid even without a build", () => {
  const evaluation = evaluatePackArtifact(["package.json"], POLICY);
  assert.equal(evaluation.status, "invalid");
  assert.equal(evaluation.ok, false);
  assert.deepEqual(evaluation.missingSourceArtifacts, ["bin/omniroute.mjs", "config/app.json"]);
});

test("invalid dominates incomplete", () => {
  const evaluation = evaluatePackArtifact(
    ["bin/omniroute.mjs", "config/app.json", "tests/leaked.test.ts"],
    POLICY
  );
  assert.equal(evaluation.status, "invalid");
  assert.deepEqual(evaluation.leaked, ["tests/leaked.test.ts"]);
});

test("unexpected paths and node_modules are rejected", () => {
  const evaluation = evaluatePackArtifact(
    [...COMPLETE_FILES, "unexpected/secret.txt", "node_modules/dep/index.js"],
    POLICY
  );
  assert.equal(evaluation.status, "invalid");
  assert.ok(evaluation.unexpected.includes("unexpected/secret.txt"));
  assert.ok(evaluation.unexpected.includes("node_modules/dep/index.js"));
});

// ---------------------------------------------------------------------------
// invocation contract
// ---------------------------------------------------------------------------

test("pack args disable scripts and network access", () => {
  const dry = buildPackArgs({ dryRun: true });
  assert.deepEqual(dry, [
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--offline",
  ]);

  const real = buildPackArgs({ dryRun: false, destination: "/tmp/out" });
  assert.ok(!real.includes("--dry-run"));
  assert.deepEqual(real.slice(-2), ["--pack-destination", "/tmp/out"]);
  assert.ok(real.includes("--ignore-scripts"));
  assert.ok(real.includes("--ignore-pnpmfile"));
  assert.ok(real.includes("--offline"));
});

test("creates a real tarball in a temp dir, suppresses lifecycle scripts, and cleans up", (t) => {
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("pnpm is not available on PATH");
    return;
  }

  const fixture = makeDir("pack-fixture");
  t.after(() =>
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  );
  fs.mkdirSync(path.join(fixture, "files"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "files", "readme.txt"), "hi\n");
  const marker = (name: string) => `node -e "require('fs').writeFileSync('${name}.txt','x')"`;
  writeJson(path.join(fixture, "package.json"), {
    name: "fixture-pkg",
    version: "1.0.0",
    files: ["files"],
    scripts: {
      prepack: marker("prepack"),
      prepare: marker("prepare"),
      postpack: marker("postpack"),
    },
  });

  const before = preflightTempDirs();
  const report = runPack({ rootDir: fixture, dryRun: false });
  assert.ok(report.files.includes("files/readme.txt"));
  assert.ok(report.files.includes("package.json"));
  assert.ok(!fs.existsSync(path.join(fixture, "prepack.txt")), "prepack must not run");
  assert.ok(!fs.existsSync(path.join(fixture, "prepare.txt")), "prepare must not run");
  assert.ok(!fs.existsSync(path.join(fixture, "postpack.txt")), "postpack must not run");
  assert.deepEqual(preflightTempDirs(), before, "the temp pack destination must be removed");

  // Positive control: the markers CAN run, so their absence above is meaningful.
  const controlDestination = makeDir("pack-control");
  t.after(() =>
    fs.rmSync(controlDestination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  );
  execFileSync("pnpm", ["pack", "--json", "--pack-destination", controlDestination], {
    cwd: fixture,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(fs.existsSync(path.join(fixture, "prepack.txt")), "control: prepack runs by default");
  assert.ok(fs.existsSync(path.join(fixture, "prepare.txt")), "control: prepare runs by default");
  assert.ok(fs.existsSync(path.join(fixture, "postpack.txt")), "control: postpack runs by default");
});

test("subprocess failures propagate and still clean the temp destination", () => {
  const before = preflightTempDirs();
  assert.throws(
    () =>
      runPack({
        rootDir: process.cwd(),
        dryRun: false,
        execFile: () => {
          throw Object.assign(new Error("pnpm pack failed"), { stderr: "boom", status: 1 });
        },
      }),
    /pnpm pack failed/
  );
  assert.deepEqual(preflightTempDirs(), before, "temp destination removed on failure too");
});

// ---------------------------------------------------------------------------
// manifest level (Level A)
// ---------------------------------------------------------------------------

test("manifest inspection validates bin targets and files", (t) => {
  const fixture = makeDir("manifest");
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  writeJson(path.join(fixture, "package.json"), {
    name: "fixture",
    version: "1.0.0",
    bin: { fixture: "bin/fixture.mjs" },
    files: ["bin"],
  });
  const broken = inspectManifest(fixture);
  assert.ok(broken.errors.some((error: string) => error.includes("missing file")));

  fs.mkdirSync(path.join(fixture, "bin"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "bin", "fixture.mjs"), "#!/usr/bin/env node\n");
  const ok = inspectManifest(fixture);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.name, "fixture");
});

test("manifest inspection reports legacy npm lifecycle scripts without executing them", (t) => {
  const fixture = makeDir("manifest-npm");
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  writeJson(path.join(fixture, "package.json"), {
    name: "fixture",
    version: "1.0.0",
    bin: { fixture: "bin/fixture.mjs" },
    files: ["bin"],
    scripts: {
      prepublishOnly: "npm run build && npm run check:pack-artifact",
      prepare: "node ok.mjs",
    },
  });
  fs.mkdirSync(path.join(fixture, "bin"));
  fs.writeFileSync(path.join(fixture, "bin", "fixture.mjs"), "");

  const inspection = inspectManifest(fixture);
  assert.deepEqual(inspection.errors, []);
  assert.match(inspection.lifecycle.prepublishOnly, /npm run/);
  assert.ok(inspection.warnings.some((warning: string) => warning.includes("prepublishOnly")));
  assert.ok(
    !inspection.warnings.some((warning: string) => warning.includes("prepare")),
    "plain node scripts are not flagged"
  );
});

test("required manifest fields are enforced", (t) => {
  const fixture = makeDir("manifest-empty");
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  writeJson(path.join(fixture, "package.json"), { name: "fixture" });
  const inspection = inspectManifest(fixture);
  assert.ok(inspection.errors.some((error: string) => error.includes("no `version`")));
  assert.ok(inspection.errors.some((error: string) => error.includes("no `bin`")));
  assert.ok(inspection.errors.some((error: string) => error.includes("no `files`")));
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("CLI flags parse and unknown flags fail with usage exit code", () => {
  assert.deepEqual(parseArgs([], "/repo"), {
    real: false,
    requireComplete: false,
    json: false,
    root: "/repo",
    help: false,
  });
  const parsed = parseArgs(
    ["--real", "--require-complete", "--json", "--root", "fixture"],
    "/repo"
  );
  assert.equal(parsed.real, true);
  assert.equal(parsed.requireComplete, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.root, path.resolve("/repo", "fixture"));
  assert.throws(() => parseArgs(["--nope"], "/repo"), /unknown argument/);
});

test("CLI reports an invalid fixture artifact through the real pnpm pack path", (t) => {
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("pnpm is not available on PATH");
    return;
  }
  const fixture = makeDir("pack-cli");
  t.after(() =>
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  );
  fs.mkdirSync(path.join(fixture, "files"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "files", "readme.txt"), "hi\n");
  writeJson(path.join(fixture, "package.json"), {
    name: "fixture-pkg",
    version: "1.0.0",
    files: ["files"],
    bin: { fixture: "files/readme.txt" },
  });

  // A fixture can never satisfy the product's required-path list → invalid (missing non-dist).
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, "--json", "--root", fixture],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.evaluation.status, "invalid");
  assert.ok(report.evaluation.missingSourceArtifacts.length > 0);
  assert.ok(
    !report.evaluation.missingSourceArtifacts.some((file: string) => file.startsWith("dist/"))
  );
});
