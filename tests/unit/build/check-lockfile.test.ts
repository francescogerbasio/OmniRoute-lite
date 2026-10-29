// tests/unit/build/check-lockfile.test.ts
// Regression tests for the pnpm lockfile policy gate (scripts/check/check-lockfile.mjs).
//
// The gate must prove the security intent of the retired npm/package-lock check against
// pnpm's format without inventing false positives, so the fixtures below cover BOTH the
// legitimate pnpm v9 resolution types and deliberately corrupted lockfiles (http registry,
// foreign host, missing/weak/malformed integrity, ambiguous git pins, local paths, bogus
// importers, two-document streams, unsupported lockfileVersion).
//
// pnpm's own manifest/lock consistency check is external and is exercised through an injected
// process boundary plus one real workspace fixture (no registry packages, works offline).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import {
  getLockfilePolicy,
  parseLockfileDocuments,
  validateSri,
  validateRemoteUrl,
  inspectLockfile,
  expandWorkspaceImporters,
  validateLockfile,
  getPnpmCommand,
  runFrozenLockfileCheck,
} from "../../../scripts/check/check-lockfile.mjs";

const SHA512 = `sha512-${createHash("sha512").update("fixture").digest("base64")}`;

const REGISTRY_PKG = { resolution: { integrity: SHA512 } };

function lockDocument({ packages = {}, importers = { ".": {} }, withSettings = true } = {}) {
  return {
    lockfileVersion: "9.0",
    ...(withSettings ? { settings: { autoInstallPeers: false } } : {}),
    importers,
    packages,
    snapshots: {},
  };
}

function inspect(packages: Record<string, unknown>, documents = [lockDocument({ packages })]) {
  return inspectLockfile(documents, getLockfilePolicy(process.cwd()), {});
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

test("policy targets the pnpm lockfile with exact-host HTTPS + sha512 integrity", () => {
  const policy = getLockfilePolicy("/repo");
  assert.equal(path.basename(policy.lockfilePath), "pnpm-lock.yaml");
  assert.deepEqual(policy.allowedHosts, ["registry.npmjs.org"]);
  assert.equal(policy.validateHttps, true);
  assert.equal(policy.validateIntegrity, true);
  assert.deepEqual(policy.allowedIntegrityAlgorithms, ["sha512"]);
  assert.equal(policy.acceptedLockfileMajor, 9);
  for (const host of policy.allowedHosts) {
    assert.doesNotMatch(host, /^https?:\/\//);
    assert.doesNotMatch(host, /\*/);
  }
});

// ---------------------------------------------------------------------------
// SRI validation
// ---------------------------------------------------------------------------

test("validateSri accepts a canonical sha512 digest", () => {
  assert.equal(validateSri(SHA512, ["sha512"]), null);
});

test("validateSri rejects missing, malformed, truncated and weak digests", () => {
  assert.equal(validateSri(undefined, ["sha512"]), "missing-integrity");
  assert.equal(validateSri("", ["sha512"]), "missing-integrity");
  assert.equal(validateSri("sha512-garbage", ["sha512"]), "invalid-integrity");
  assert.equal(validateSri(`${SHA512}extra`, ["sha512"]), "invalid-integrity");
  assert.equal(
    validateSri(`sha512-${Buffer.alloc(32).toString("base64")}`, ["sha512"]),
    "invalid-integrity"
  );
  assert.equal(
    validateSri(`sha1-${createHash("sha1").update("x").digest("base64")}`, ["sha512"]),
    "weak-integrity"
  );
});

// ---------------------------------------------------------------------------
// remote URL policy
// ---------------------------------------------------------------------------

test("validateRemoteUrl allows scoped package paths (only userinfo is rejected)", () => {
  const policy = getLockfilePolicy("/repo");
  assert.equal(
    validateRemoteUrl("https://registry.npmjs.org/@scope/package/-/package-1.0.0.tgz", policy),
    null
  );
  assert.equal(validateRemoteUrl("https://registry.npmjs.org/@scope/package", policy), null);
  // Credentials are still rejected — including the host-confusion form.
  assert.equal(
    validateRemoteUrl("https://user:pass@registry.npmjs.org/a.tgz", policy),
    "invalid-url"
  );
  assert.equal(
    validateRemoteUrl("https://registry.npmjs.org@evil.example/a.tgz", policy),
    "invalid-url"
  );
});

test("validateRemoteUrl allows only https on the exact registry host", () => {
  const policy = getLockfilePolicy("/repo");
  assert.equal(validateRemoteUrl("https://registry.npmjs.org/a/-/a-1.0.0.tgz", policy), null);
  assert.equal(validateRemoteUrl("http://registry.npmjs.org/a.tgz", policy), "insecure-transport");
  assert.equal(validateRemoteUrl("https://evil.example/a.tgz", policy), "disallowed-host");
  assert.equal(
    validateRemoteUrl("https://registry.npmjs.org.evil.example/a.tgz", policy),
    "disallowed-host"
  );
  assert.equal(
    validateRemoteUrl("https://user:pass@registry.npmjs.org/a.tgz", policy),
    "invalid-url"
  );
  assert.equal(validateRemoteUrl("https://registry.npmjs.org:8443/a.tgz", policy), "invalid-url");
  assert.equal(validateRemoteUrl("not a url", policy), "invalid-url");
});

// ---------------------------------------------------------------------------
// resolution types
// ---------------------------------------------------------------------------

test("registry packages with sha512 integrity pass", () => {
  const { errors, stats } = inspect({ "pkg@1.0.0": REGISTRY_PKG });
  assert.deepEqual(errors, []);
  assert.equal(stats.packages, 1);
  assert.equal(stats.byType.registry, 1);
});

test("a package without a resolution fails closed", () => {
  const { errors } = inspect({ "pkg@1.0.0": {} });
  assert.equal(errors[0].code, "missing-resolution");
});

test("resolution shapes are exact: a valid field cannot smuggle a second one", () => {
  // registry + local path
  const registryWithPath = inspect({
    "pkg@1.0.0": { resolution: { integrity: SHA512, path: "../pkg" } },
  });
  assert.ok(
    registryWithPath.errors.some((e: { code: string }) => e.code === "invalid-resolution-shape"),
    "registry+path must fail"
  );

  // git + tarball
  const gitWithTarball = inspect({
    "pkg@1.0.0": {
      resolution: {
        type: "git",
        repo: "https://github.com/o/r.git",
        commit: "a".repeat(40),
        tarball: "https://registry.npmjs.org/a.tgz",
      },
    },
  });
  assert.ok(
    gitWithTarball.errors.some((e: { code: string }) => e.code === "invalid-resolution-shape"),
    "git+tarball must fail"
  );

  // tarball + repo
  const tarballWithRepo = inspect({
    "pkg@1.0.0": {
      resolution: {
        tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz",
        integrity: SHA512,
        repo: "https://github.com/o/r.git",
      },
    },
  });
  assert.ok(
    tarballWithRepo.errors.some((e: { code: string }) => e.code === "invalid-resolution-shape"),
    "tarball+repo must fail"
  );

  // explicit registry + tarball
  const registryPlusTarball = inspect({
    "pkg@1.0.0": {
      resolution: {
        registry: "https://registry.npmjs.org",
        tarball: "https://registry.npmjs.org/a.tgz",
        integrity: SHA512,
      },
    },
  });
  assert.ok(
    registryPlusTarball.errors.some((e: { code: string }) => e.code === "invalid-resolution-shape"),
    "registry+tarball must fail"
  );

  // a git monorepo subdirectory (`path` alongside type/repo/commit) stays legitimate
  const gitWithPath = inspect({
    "pkg@1.0.0": {
      resolution: {
        type: "git",
        repo: "https://github.com/o/r.git",
        commit: "a".repeat(40),
        path: "packages/pkg",
      },
    },
  });
  assert.deepEqual(gitWithPath.errors, []);
});

test("unknown resolution keys fail closed instead of being ignored", () => {
  const { errors } = inspect({ "pkg@1.0.0": { resolution: { integrity: SHA512, weird: 1 } } });
  assert.ok(errors.some((e: { code: string }) => e.code === "invalid-resolution-shape"));
});

test("directory and local tarball resolutions are rejected by policy", () => {
  const directory = inspect({
    "pkg@1.0.0": { resolution: { type: "directory", directory: "../x" } },
  });
  assert.ok(directory.errors.some((e: { code: string }) => e.code === "unsupported-resolution"));

  const local = inspect({ "pkg@1.0.0": { resolution: { tarball: "file:../pkg.tgz" } } });
  assert.ok(local.errors.some((e: { code: string }) => e.code === "unsupported-resolution"));
});

test("remote tarballs require https, an allowed host and integrity", () => {
  const ok = inspect({
    "pkg@1.0.0": {
      resolution: { tarball: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: SHA512 },
    },
  });
  assert.deepEqual(ok.errors, []);

  const http = inspect({
    "pkg@1.0.0": {
      resolution: { tarball: "http://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: SHA512 },
    },
  });
  assert.ok(http.errors.some((e: { code: string }) => e.code === "insecure-transport"));

  const foreign = inspect({
    "pkg@1.0.0": {
      resolution: { tarball: "https://cdn.example.com/a.tgz", integrity: SHA512 },
    },
  });
  assert.ok(foreign.errors.some((e: { code: string }) => e.code === "disallowed-host"));

  const noIntegrity = inspect({
    "pkg@1.0.0": {
      resolution: { tarball: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },
    },
  });
  assert.ok(noIntegrity.errors.some((e: { code: string }) => e.code === "missing-integrity"));
});

test("explicit resolution.registry is host-checked (no bypass)", () => {
  const ok = inspect({
    "pkg@1.0.0": {
      resolution: { registry: "https://registry.npmjs.org", integrity: SHA512 },
    },
  });
  assert.deepEqual(ok.errors, []);

  const bad = inspect({
    "pkg@1.0.0": {
      resolution: { registry: "http://registry.npmjs.org", integrity: SHA512 },
    },
  });
  assert.ok(bad.errors.some((e: { code: string }) => e.code === "insecure-transport"));

  const foreign = inspect({
    "pkg@1.0.0": {
      resolution: { registry: "https://evil.example", integrity: SHA512 },
    },
  });
  assert.ok(foreign.errors.some((e: { code: string }) => e.code === "disallowed-host"));
});

test("git resolutions need a full commit and an allowed transport", () => {
  const sha = "a".repeat(40);
  const ok = inspect({
    "pkg@1.0.0": { resolution: { type: "git", repo: "https://github.com/o/r.git", commit: sha } },
  });
  assert.deepEqual(ok.errors, []);

  const short = inspect({
    "pkg@1.0.0": {
      resolution: { type: "git", repo: "https://github.com/o/r.git", commit: "abc1234" },
    },
  });
  assert.ok(short.errors.some((e: { code: string }) => e.code === "invalid-git-resolution"));

  const http = inspect({
    "pkg@1.0.0": { resolution: { type: "git", repo: "http://github.com/o/r.git", commit: sha } },
  });
  assert.ok(http.errors.some((e: { code: string }) => e.code === "invalid-git-resolution"));
});

// ---------------------------------------------------------------------------
// documents, importers, version
// ---------------------------------------------------------------------------

test("every YAML document is scanned (two-document stream)", () => {
  const docs = parseLockfileDocuments(
    "---\nlockfileVersion: '9.0'\npackages:\n" +
      "  bad@1.0.0:\n    resolution: {integrity: 'sha1-AAAA'}\n" +
      "---\nlockfileVersion: '9.0'\nsettings: {}\nimporters: {\".\": {}}\n" +
      "packages:\n  good@1.0.0:\n    resolution: {integrity: 'sha512-AAAA'}\n"
  );
  assert.equal(docs.length, 2);
  const { errors } = inspectLockfile(docs, getLockfilePolicy(process.cwd()), {});
  const codes = errors.map((e: { code: string }) => e.code);
  assert.ok(codes.includes("invalid-integrity") || codes.includes("weak-integrity"));
});

test("unsupported lockfileVersion fails closed", () => {
  const doc = { ...lockDocument(), lockfileVersion: "10.0" };
  const { errors } = inspectLockfile([doc], getLockfilePolicy(process.cwd()), {});
  assert.ok(errors.some((e: { code: string }) => e.code === "unsupported-lockfile-version"));
});

test("workspace document must list every importer and no strangers", () => {
  const base = { "pkg@1.0.0": REGISTRY_PKG };
  const missing = inspectLockfile(
    [lockDocument({ packages: base, importers: { ".": {} } })],
    getLockfilePolicy(process.cwd()),
    { expectedImporters: ["pkg-a"] }
  );
  assert.ok(missing.errors.some((e: { code: string }) => e.code === "missing-importer"));

  const unexpected = inspectLockfile(
    [lockDocument({ packages: base, importers: { ".": {}, ghost: {} } })],
    getLockfilePolicy(process.cwd()),
    { expectedImporters: ["pkg-a"] }
  );
  assert.ok(unexpected.errors.some((e: { code: string }) => e.code === "unexpected-importer"));

  // The pnpm packageManager document (no `settings`) is only checked for strangers.
  const packageManagerDoc = lockDocument({
    packages: base,
    importers: { ".": {} },
    withSettings: false,
  });
  const ok = inspectLockfile([packageManagerDoc], getLockfilePolicy(process.cwd()), {
    expectedImporters: ["pkg-a"],
  });
  assert.deepEqual(ok.errors, []);
});

test("missing and malformed lockfiles fail", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lockfile-missing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = validateLockfile(dir);
  assert.equal(missing.errors[0].code, "lockfile-missing");

  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: [\n");
  const malformed = validateLockfile(dir);
  assert.equal(malformed.errors[0].code, "lockfile-invalid-yaml");
});

test("workspace importer expansion rejects unsupported glob shapes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lockfile-globs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "**/*"\n');
  assert.throws(() => expandWorkspaceImporters(dir), /unsupported workspace pattern/);
});

// ---------------------------------------------------------------------------
// the real repository lockfile
// ---------------------------------------------------------------------------

test("the committed pnpm lockfile satisfies the policy", () => {
  const { errors, stats } = validateLockfile(process.cwd());
  assert.deepEqual(errors, []);
  assert.equal(stats.documents, 2, "pnpm writes a two-document lockfile; both must be scanned");
  assert.ok(stats.packages > 1000, `expected the full dependency graph, got ${stats.packages}`);
  assert.equal(stats.byType.unknown, 0);
});

// ---------------------------------------------------------------------------
// pnpm frozen-lockfile delegation
// ---------------------------------------------------------------------------

test("frozen check runs pnpm install --frozen-lockfile --lockfile-only in a staged copy", () => {
  const calls: { command: unknown; args: unknown; cwd: unknown }[] = [];
  let staged;
  const result = runFrozenLockfileCheck({
    rootDir: process.cwd(),
    platform: "linux",
    execFile: (command: unknown, args: unknown, options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      staged = options.cwd;
      return "";
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pnpm");
  assert.deepEqual(calls[0].args, [
    "install",
    "--frozen-lockfile",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  assert.notEqual(calls[0].cwd, process.cwd(), "the check must never run in the repository");
  assert.ok(staged, "staged dir should be recorded");
  assert.equal(fs.existsSync(String(staged)), false, "staged dir must be cleaned up");
});

test("frozen check surfaces pnpm diagnostics instead of masking them", () => {
  const failure = Object.assign(new Error("ERR_PNPM_OUTDATED_LOCKFILE"), {
    stdout: "Scope: all 2 workspace projects",
    stderr: "Error: ERR_PNPM_OUTDATED_LOCKFILE",
  });
  const result = runFrozenLockfileCheck({
    rootDir: process.cwd(),
    platform: "linux",
    execFile: () => {
      throw failure;
    },
  });
  assert.deepEqual(result, {
    ok: false,
    stdout: "Scope: all 2 workspace projects",
    stderr: "Error: ERR_PNPM_OUTDATED_LOCKFILE",
  });
});

test("getPnpmCommand uses pnpm directly and pnpm.cmd via cmd.exe on Windows", () => {
  assert.deepEqual(getPnpmCommand("linux"), {
    command: "pnpm",
    args: ["install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts"],
  });
  assert.deepEqual(getPnpmCommand("win32", "C:\\Windows\\System32\\cmd.exe"), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      "pnpm.cmd",
      "install",
      "--frozen-lockfile",
      "--lockfile-only",
      "--ignore-scripts",
    ],
  });
});

test("real pnpm rejects a workspace fixture whose lockfile is out of sync", (t) => {
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("pnpm is not available on PATH");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lockfile-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.mkdirSync(path.join(dir, "pkg-a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "pkg-a"\n');
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture-root", version: "1.0.0", private: true })
  );
  const manifest = path.join(dir, "pkg-a", "package.json");
  fs.writeFileSync(manifest, JSON.stringify({ name: "pkg-a", version: "1.0.0" }));

  // Workspace-only fixture: no registry packages, so the lockfile can be produced offline.
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--offline"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.deepEqual(runFrozenLockfileCheck({ rootDir: dir }), { ok: true });

  fs.writeFileSync(
    manifest,
    JSON.stringify({ name: "pkg-a", version: "1.0.0", dependencies: { semver: "7.7.4" } })
  );
  const drifted = runFrozenLockfileCheck({ rootDir: dir });
  assert.equal(drifted.ok, false);
  assert.match(`${drifted.stdout}\n${drifted.stderr}`, /OUTDATED_LOCKFILE/);
});
