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
import { PACK_ARTIFACT_REQUIRED_PATHS } from "../../../scripts/build/pack-artifact-policy.ts";

// @ts-expect-error — .ts helper; runtime shape is known.
import {
  buildPackArgs,
  evaluatePackArtifact,
  inspectManifest,
  parsePnpmPackJson,
  parseArgs,
  runPack,
  verifyReportMatchesManifest,
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

test("accepts exactly one array report and rejects unusable output", () => {
  const single = parsePnpmPackJson(
    JSON.stringify([
      {
        name: "fixture",
        version: "1.0.0",
        filename: "fixture-1.0.0.tgz",
        files: [{ path: "package.json" }],
      },
    ])
  );
  assert.deepEqual(single.files, ["package.json"]);

  // A second report must never be ignored: it could carry a policy-violating package.
  assert.throws(
    () =>
      parsePnpmPackJson(
        JSON.stringify([
          { name: "a", version: "1.0.0", filename: "a.tgz", files: [{ path: "package.json" }] },
          {
            name: "b",
            version: "1.0.0",
            filename: "b.tgz",
            files: [{ path: "node_modules/x.js" }],
          },
        ])
      ),
    /returned 2 reports; exactly one is required \(refusing to ignore packages\)/
  );
  assert.throws(() => parsePnpmPackJson("[]"), /returned 0 reports/);

  assert.throws(() => parsePnpmPackJson("not json"), /did not return valid JSON/);
  assert.throws(
    () => parsePnpmPackJson('{"name":"x"}'),
    /no package `name`|no package `version`|no tarball `filename`/
  );
  assert.throws(
    () => parsePnpmPackJson('{"name":"x","version":"1.0.0","filename":"x.tgz"}'),
    /no `files\[\]` list/
  );
  assert.throws(
    () => parsePnpmPackJson('{"name":"x","version":"1.0.0","filename":"x.tgz","files":[]}'),
    /empty file list/
  );
});

test("malformed file entries and metadata are rejected, never filtered", () => {
  const report = (files: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name: "x", version: "1.0.0", filename: "x.tgz", files, ...extra });

  for (const [files, expected] of [
    [[{ path: null }], /malformed files\[0\]/],
    [[{}], /malformed files\[0\]/],
    [["package.json"], /malformed files\[0\]/],
    [[{ path: "" }], /malformed files\[0\]/],
    [[{ path: "  " }], /malformed files\[0\]/],
    [[{ path: "ok" }, { path: 42 }], /malformed files\[1\]/],
  ] as const) {
    assert.throws(() => parsePnpmPackJson(report(files)), expected, JSON.stringify(files));
  }

  assert.throws(
    () => parsePnpmPackJson(report([{ path: "a" }], { name: "" })),
    /no package `name`/
  );
  assert.throws(
    () => parsePnpmPackJson(report([{ path: "a" }], { version: "" })),
    /no package `version`/
  );
  assert.throws(
    () => parsePnpmPackJson(report([{ path: "a" }], { filename: "" })),
    /no tarball `filename`/
  );
});

test("the packed identity must match the inspected manifest", () => {
  const manifest = { name: "omniroute", version: "3.8.52" };
  const pack = (name: string, version: string) => ({
    name,
    version,
    filename: "x.tgz",
    files: ["package.json"],
  });

  assert.deepEqual(verifyReportMatchesManifest(manifest, pack("omniroute", "3.8.52")), []);
  const mismatches = verifyReportMatchesManifest(manifest, pack("other", "9.9.9"));
  assert.equal(mismatches.length, 2);
  assert.match(mismatches[0], /packed name "other" does not match manifest name "omniroute"/);
  assert.match(mismatches[1], /packed version "9.9.9" does not match manifest version "3.8.52"/);
  assert.equal(verifyReportMatchesManifest(manifest, pack("omniroute", "9.9.9")).length, 1);
});

// ---------------------------------------------------------------------------
// policy evaluation / severity model
// ---------------------------------------------------------------------------

// The real production policy: these are the paths a built package must contain.
const REQUIRED = PACK_ARTIFACT_REQUIRED_PATHS;
const DIST_REQUIRED = REQUIRED.filter((file) => file.startsWith("dist/"));

test("production defaults accept every required artifact (Codex P2 regression)", () => {
  // Before the fix the defaults used the ROOT-only allowlists, so all 16 dist/ build artifacts
  // were flagged unexpected and a fully built package evaluated as INVALID.
  assert.ok(DIST_REQUIRED.length > 0, "the policy must exercise real dist/ build outputs");
  const evaluation = evaluatePackArtifact(REQUIRED);
  assert.deepEqual(evaluation.unexpected, []);
  assert.equal(evaluation.missingRequired.length, 0);
  assert.equal(evaluation.status, "valid");
  assert.equal(evaluation.ok, true);
});

test("a complete required set is VALID", () => {
  const evaluation = evaluatePackArtifact(REQUIRED);
  assert.equal(evaluation.status, "valid");
  assert.equal(evaluation.missingBuildArtifacts.length, 0);
});

test("only a missing dist/ build artifact is INCOMPLETE, and --require-complete fails", () => {
  const files = REQUIRED.filter((file) => file !== DIST_REQUIRED[0]);
  const unbuilt = evaluatePackArtifact(files);
  assert.equal(unbuilt.status, "incomplete");
  assert.equal(unbuilt.ok, true, "an unbuilt checkout must not fail the default preflight");
  assert.deepEqual(unbuilt.missingBuildArtifacts, [DIST_REQUIRED[0]]);
  assert.deepEqual(unbuilt.missingSourceArtifacts, []);
  assert.equal(unbuilt.unexpected.length, 0, "legitimate dist paths must not be flagged");

  const strict = evaluatePackArtifact(files, { requireComplete: true });
  assert.equal(strict.status, "incomplete");
  assert.equal(strict.ok, false, "--require-complete must reject an unbuilt artifact");
});

test("a missing non-build file is invalid even without a build", () => {
  const sourceFile = REQUIRED.find((file) => !file.startsWith("dist/"))!;
  const evaluation = evaluatePackArtifact(REQUIRED.filter((file) => file !== sourceFile));
  assert.equal(evaluation.status, "invalid");
  assert.equal(evaluation.ok, false);
  assert.deepEqual(evaluation.missingSourceArtifacts, [sourceFile]);
});

test("an unexpected file under dist/ is still rejected", () => {
  const evaluation = evaluatePackArtifact([...REQUIRED, "dist/evil.sh"]);
  assert.equal(evaluation.status, "invalid");
  assert.ok(evaluation.unexpected.includes("dist/evil.sh"));
});

test("node_modules leakage is rejected even under permitted dist prefixes", () => {
  const evaluation = evaluatePackArtifact([
    ...REQUIRED,
    "node_modules/dep/index.js",
    "dist/src/lib/node_modules/dep/index.js",
  ]);
  assert.equal(evaluation.status, "invalid");
  assert.ok(evaluation.unexpected.includes("node_modules/dep/index.js"));
  assert.ok(evaluation.unexpected.includes("dist/src/lib/node_modules/dep/index.js"));
});

test("root restrictions remain enforced", () => {
  const rootLeak = evaluatePackArtifact([...REQUIRED, "docs/private.md", "random.txt"]);
  assert.equal(rootLeak.status, "invalid");
  assert.ok(rootLeak.unexpected.includes("docs/private.md"));
  assert.ok(rootLeak.unexpected.includes("random.txt"));

  const testLeak = evaluatePackArtifact([...REQUIRED, "tests/leaked.test.ts"]);
  assert.equal(testLeak.status, "invalid");
  assert.deepEqual(testLeak.leaked, ["tests/leaked.test.ts"]);
});

test("invalid dominates incomplete", () => {
  const files = REQUIRED.filter((file) => file !== DIST_REQUIRED[0]);
  const evaluation = evaluatePackArtifact([...files, "tests/leaked.test.ts"]);
  assert.equal(evaluation.status, "invalid");
  assert.deepEqual(evaluation.leaked, ["tests/leaked.test.ts"]);
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
  // pnpm forwards the `--` separator from `pnpm run <script> -- --flag`.
  assert.equal(parseArgs(["--", "--require-complete"], "/repo").requireComplete, true);
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
