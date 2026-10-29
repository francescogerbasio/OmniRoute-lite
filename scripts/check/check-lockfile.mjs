#!/usr/bin/env node
// scripts/check/check-lockfile.mjs
// Supply-chain policy gate for the ROOT pnpm lockfile (issue #13 phase 2, follow-up #23).
//
// Replaces the npm/package-lock gate (lockfile-lint + `npm ls --workspaces`). lockfile-lint
// has no pnpm support, so the policy is expressed directly against `pnpm-lock.yaml`:
//
//   1. lockfile present, parseable, supported `lockfileVersion` major (fail closed otherwise)
//   2. every package resolution is a KNOWN pnpm resolution type:
//        - registry package  -> `resolution.integrity` required, strong SRI (sha512)
//        - remote tarball    -> https only, allowed registry host, integrity required
//        - `resolution.registry` -> https only, allowed host (non-default registry)
//        - git dependency    -> full 40-hex commit, https/ssh scheme only, no integrity
//      anything else (directory/file links, local tarballs, unknown shapes) FAILS CLOSED:
//      none of them exist in this lockfile today, and accepting them silently would weaken
//      the previous "official registry only" posture. Add an explicit, reviewed branch when
//      one is genuinely needed.
//      Each type is validated as an EXACT key set — a valid field may not smuggle a second,
//      unvalidated one (registry+path, git+tarball, tarball+repo, …) — so field-level checks
//      can never be bypassed by mixing shapes.
//   3. no unexpected importers, and every workspace importer is present
//   4. manifest/lock consistency is delegated to pnpm itself
//      (`pnpm install --frozen-lockfile --lockfile-only --ignore-scripts` in a staged temp
//      copy), never reimplemented here.
//
// IMPORTANT: `pnpm-lock.yaml` is a two-document YAML stream. Document 1 holds pnpm's own
// `packageManagerDependencies` (@pnpm/exe.*), document 2 the workspace graph. A single-document
// parser throws or silently misses most of the graph, so every document is scanned.
//
// Known limitations (documented on purpose, not silently accepted):
//   - Default-registry packages carry no source URL in the lockfile; their registry is implied
//     by configuration. This gate proves integrity/host for EXPLICIT urls, and pnpm verifies
//     tarball hashes at install time.
//   - Integrity proves content matches the locked digest, not that the digest/version is safe:
//     whoever can rewrite the lockfile can rewrite both.
//   - git dependencies are pinned by commit only (no content hash); ssh/https repos are allowed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as yaml from "js-yaml";

export const LOCKFILE_NAME = "pnpm-lock.yaml";

/** Bytes per digest algorithm, used to reject truncated/forged SRI values. */
const SRI_BYTES = { sha512: 64, sha256: 32, sha1: 20 };

const ALLOWED_GIT_SCHEMES = new Set(["https:", "git+https:", "ssh:", "git+ssh:"]);

/**
 * Canonical policy. `allowedHosts` is exact-match (no suffix matching, no lookalikes).
 * @returns {{
 *   lockfilePath: string,
 *   allowedHosts: string[],
 *   validateHttps: boolean,
 *   validateIntegrity: boolean,
 *   allowedIntegrityAlgorithms: string[],
 *   acceptedLockfileMajor: number,
 * }}
 */
export function getLockfilePolicy(rootDir = process.cwd()) {
  return {
    lockfilePath: path.join(rootDir, LOCKFILE_NAME),
    // Only the official registry. Add a hostname here (with justification) if a scoped or
    // private registry is ever adopted; never add a wildcard.
    allowedHosts: ["registry.npmjs.org"],
    validateHttps: true,
    validateIntegrity: true,
    allowedIntegrityAlgorithms: ["sha512"],
    acceptedLockfileMajor: 9,
  };
}

/**
 * Parses every YAML document in a pnpm lockfile stream.
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
export function parseLockfileDocuments(text) {
  const docs = yaml.loadAll(text).filter(Boolean);
  if (docs.length === 0) throw new Error("lockfile has no YAML documents");
  for (const doc of docs) {
    if (typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error("lockfile document is not a mapping");
    }
  }
  return docs;
}

/**
 * Validates an SRI string against the policy algorithms (syntax + digest length).
 * @returns {string | null} error code, or null when valid
 */
export function validateSri(value, algorithms) {
  if (typeof value !== "string" || value.length === 0) return "missing-integrity";
  const match = /^([a-z0-9]+)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return "invalid-integrity";
  const [, algorithm, digest] = match;
  if (!algorithms.includes(algorithm)) return "weak-integrity";
  const expectedBytes = SRI_BYTES[algorithm];
  const decoded = Buffer.from(digest, "base64");
  if (decoded.length !== expectedBytes) return "invalid-integrity";
  if (decoded.toString("base64") !== digest) return "invalid-integrity";
  return null;
}

/**
 * Validates an explicit remote URL against the HTTPS + allowed-host policy.
 * @returns {string | null} error code, or null when valid
 */
export function validateRemoteUrl(value, policy) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "invalid-url";
  }
  if (policy.validateHttps && url.protocol !== "https:") return "insecure-transport";
  // Only userinfo is a credential carrier. `@` in the PATH is legitimate (scoped tarballs such
  // as https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz), so never test the raw string.
  if (url.username || url.password) return "invalid-url";
  if (url.port && url.port !== "443") return "invalid-url";
  const host = url.hostname.toLowerCase();
  if (!policy.allowedHosts.includes(host)) return "disallowed-host";
  return null;
}

/**
 * Classifies and validates one `packages` entry resolution.
 * @returns {{ type: string, errors: { code: string, detail: string }[] }}
 */
export function inspectResolution(packageKey, resolution, policy) {
  const errors = [];
  const fail = (code, detail) => errors.push({ code, detail });
  const record = (type) => ({ type, errors });

  if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) {
    fail("missing-resolution", "package entry has no `resolution` mapping");
    return record("unknown");
  }

  const type = typeof resolution.type === "string" ? resolution.type : null;

  // Exact permitted key combination per resolution type. A valid field must never smuggle a
  // second, unvalidated one (e.g. `integrity` + `path`, or a git `repo`/`commit` + `tarball`):
  // each shape is validated as a whole, not field by field.
  const SHAPES = {
    git: { keys: new Set(["type", "repo", "commit", "path"]), statsType: "git" },
    tarball: { keys: new Set(["tarball", "integrity"]), statsType: "tarball" },
    "registry-explicit": { keys: new Set(["registry", "integrity"]), statsType: "registry" },
    registry: { keys: new Set(["integrity"]), statsType: "registry" },
  };

  let shapeName;
  if (type !== null) {
    if (type !== "git") {
      // `directory` / `file` / anything else references content outside the verified registry.
      fail(
        "unsupported-resolution",
        `resolution type "${type}" is not allowed by policy (registry/tarball/git only)`
      );
      return record(type);
    }
    shapeName = "git";
  } else if (typeof resolution.tarball === "string") {
    shapeName = "tarball";
  } else if (typeof resolution.registry === "string") {
    shapeName = "registry-explicit";
  } else {
    shapeName = "registry";
  }

  const shape = SHAPES[shapeName];
  const unexpectedKeys = Object.keys(resolution).filter((key) => !shape.keys.has(key));
  if (unexpectedKeys.length > 0) {
    fail(
      "invalid-resolution-shape",
      `key(s) ${unexpectedKeys.map((key) => `"${key}"`).join(", ")} not allowed in a ${shapeName} resolution`
    );
    return record(shape.statsType);
  }

  if (type === "git") {
    const repo = resolution.repo;
    const commit = resolution.commit;
    if (typeof repo !== "string" || repo.length === 0) {
      fail("invalid-git-resolution", "git resolution has no `repo`");
    } else {
      let url = null;
      try {
        url = new URL(repo);
      } catch {
        fail("invalid-git-resolution", `git repo is not a URL: ${repo}`);
      }
      if (url && !ALLOWED_GIT_SCHEMES.has(url.protocol)) {
        fail("invalid-git-resolution", `git repo scheme "${url.protocol}" is not allowed`);
      }
    }
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
      fail("invalid-git-resolution", "git resolution must pin a full 40-hex `commit`");
    }
    return record("git");
  }

  if (typeof resolution.tarball === "string") {
    const tarball = resolution.tarball;
    if (!/^https?:\/\//i.test(tarball)) {
      // local tarball / file: reference — not verifiable against the registry policy
      fail("unsupported-resolution", `local tarball resolution is not allowed: ${tarball}`);
      return record("tarball");
    }
    const urlError = validateRemoteUrl(tarball, policy);
    if (urlError) fail(urlError, `tarball ${tarball}`);
    if (policy.validateIntegrity) {
      const sriError = validateSri(resolution.integrity, policy.allowedIntegrityAlgorithms);
      if (sriError) fail(sriError, `tarball ${tarball} requires a strong integrity hash`);
    }
    return record("tarball");
  }

  if (typeof resolution.registry === "string") {
    const urlError = validateRemoteUrl(resolution.registry, policy);
    if (urlError) fail(urlError, `registry ${resolution.registry}`);
    if (policy.validateIntegrity) {
      const sriError = validateSri(resolution.integrity, policy.allowedIntegrityAlgorithms);
      if (sriError)
        fail(sriError, `registry ${resolution.registry} requires a strong integrity hash`);
    }
    return record("registry");
  }

  if (resolution.integrity !== undefined) {
    if (policy.validateIntegrity) {
      const sriError = validateSri(resolution.integrity, policy.allowedIntegrityAlgorithms);
      if (sriError) fail(sriError, `${packageKey}: integrity hash rejected`);
    }
    return record("registry");
  }

  fail("missing-resolution", `${packageKey}: resolution has no integrity/tarball/registry/type`);
  return record("unknown");
}

/**
 * Expands the workspace globs declared in pnpm-workspace.yaml (literal dirs and `dir/*`).
 * Other glob shapes fail closed instead of being partially checked.
 * @returns {string[]} importer paths relative to the repo root, excluding "."
 */
export function expandWorkspaceImporters(rootDir) {
  const workspaceFile = path.join(rootDir, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceFile)) return [];
  const workspace = yaml.load(fs.readFileSync(workspaceFile, "utf8"));
  const patterns = Array.isArray(workspace?.packages) ? workspace.packages : [];
  const importers = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error(`unsupported workspace pattern: ${String(pattern)}`);
    }
    if (!pattern.includes("*")) {
      importers.push(pattern);
      continue;
    }
    const starIndex = pattern.indexOf("*");
    if (pattern.indexOf("*", starIndex + 1) !== -1 || !pattern.endsWith("/*")) {
      throw new Error(`unsupported workspace pattern (only "dir/*"): ${pattern}`);
    }
    const parent = pattern.slice(0, -2);
    const parentDir = path.join(rootDir, parent);
    if (!fs.existsSync(parentDir)) continue;
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = path.posix.join(parent, entry.name);
      if (fs.existsSync(path.join(rootDir, rel, "package.json"))) importers.push(rel);
    }
  }
  return [...new Set(importers)].sort();
}

/**
 * Inspects a parsed pnpm lockfile (all documents).
 * @param {Record<string, unknown>[]} documents
 * @param {ReturnType<typeof getLockfilePolicy>} policy
 * @param {{ expectedImporters?: string[] }} [options]
 * @returns {{ errors: { code: string, detail: string }[], stats: Record<string, unknown> }}
 */
export function inspectLockfile(documents, policy, options = {}) {
  const errors = [];
  const stats = {
    documents: documents.length,
    packages: 0,
    byType: { registry: 0, tarball: 0, git: 0, unknown: 0 },
  };
  const expected = options.expectedImporters ? [".", ...options.expectedImporters] : null;

  for (const [index, doc] of documents.entries()) {
    const major = String(doc.lockfileVersion ?? "").split(".")[0];
    if (major !== String(policy.acceptedLockfileMajor)) {
      errors.push({
        code: "unsupported-lockfile-version",
        detail: `document ${index + 1}: lockfileVersion "${String(doc.lockfileVersion)}" (supported major: ${policy.acceptedLockfileMajor})`,
      });
    }

    const packages = doc.packages;
    if (packages !== undefined) {
      if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
        errors.push({
          code: "invalid-lockfile",
          detail: `document ${index + 1}: packages is not a mapping`,
        });
      } else {
        for (const [key, entry] of Object.entries(packages)) {
          stats.packages += 1;
          const resolution = entry && typeof entry === "object" ? entry.resolution : undefined;
          const result = inspectResolution(key, resolution, policy);
          stats.byType[result.type] = (stats.byType[result.type] ?? 0) + 1;
          for (const error of result.errors) {
            errors.push({ code: error.code, detail: `${key}: ${error.detail}` });
          }
        }
      }
    }

    if (expected && doc.importers && typeof doc.importers === "object") {
      const actual = Object.keys(doc.importers);
      // Every document may only declare importers this workspace actually has.
      for (const importer of actual) {
        if (!expected.includes(importer)) {
          errors.push({
            code: "unexpected-importer",
            detail: `document ${index + 1}: importer "${importer}" is not a workspace project`,
          });
        }
      }
      // Only the workspace document (the one that carries `settings`) must list them all;
      // the pnpm packageManager document is a separate, narrower graph.
      if (doc.settings !== undefined) {
        for (const importer of expected) {
          if (!actual.includes(importer)) {
            errors.push({
              code: "missing-importer",
              detail: `document ${index + 1}: workspace project "${importer}" has no lockfile importer`,
            });
          }
        }
      }
    }
  }

  return { errors, stats };
}

/**
 * Reads and inspects the repository lockfile.
 * @returns {{ errors: { code: string, detail: string }[], stats: Record<string, unknown> }}
 */
export function validateLockfile(rootDir = process.cwd(), policy = getLockfilePolicy(rootDir)) {
  if (!fs.existsSync(policy.lockfilePath)) {
    return {
      errors: [{ code: "lockfile-missing", detail: `lockfile not found: ${policy.lockfilePath}` }],
      stats: { documents: 0, packages: 0, byType: {} },
    };
  }
  let documents;
  try {
    documents = parseLockfileDocuments(fs.readFileSync(policy.lockfilePath, "utf8"));
  } catch (error) {
    return {
      errors: [{ code: "lockfile-invalid-yaml", detail: String(error?.message ?? error) }],
      stats: { documents: 0, packages: 0, byType: {} },
    };
  }
  let expectedImporters = [];
  try {
    expectedImporters = expandWorkspaceImporters(rootDir);
  } catch (error) {
    return {
      errors: [{ code: "invalid-workspace-config", detail: String(error?.message ?? error) }],
      stats: { documents: documents.length, packages: 0, byType: {} },
    };
  }
  return inspectLockfile(documents, policy, { expectedImporters });
}

/**
 * pnpm executable selection (`.cmd` shim through cmd.exe on Windows, as npm needs too).
 * @returns {{ command: string, args: string[] }}
 */
export function getPnpmCommand(platform = process.platform, comSpec = process.env.ComSpec) {
  const installArgs = ["install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts"];
  if (platform === "win32") {
    return { command: comSpec || "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", ...installArgs] };
  }
  return { command: "pnpm", args: installArgs };
}

/** Strips credential-looking lines before a repo .npmrc is copied into a temp dir. */
function readSanitizedNpmrc(rootDir) {
  const npmrcPath = path.join(rootDir, ".npmrc");
  if (!fs.existsSync(npmrcPath)) return null;
  const secretLine = /(_auth|_authToken|_password|token|password|username)\s*=/i;
  return fs
    .readFileSync(npmrcPath, "utf8")
    .split("\n")
    .filter((line) => !secretLine.test(line))
    .join("\n");
}

/**
 * Stages manifests + lockfile + workspace config in a temp dir so the frozen-lockfile check
 * can never rewrite the repository (and so tests are deterministic).
 * @returns {string} temp dir
 */
export function stageWorkspaceCopy(rootDir = process.cwd()) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lockfile-check-"));
  const copyFile = (rel) => {
    const from = path.join(rootDir, rel);
    if (!fs.existsSync(from)) return;
    const to = path.join(stage, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };

  for (const rel of ["package.json", LOCKFILE_NAME, "pnpm-workspace.yaml", "pnpm.json"])
    copyFile(rel);
  const npmrc = readSanitizedNpmrc(rootDir);
  if (npmrc !== null) fs.writeFileSync(path.join(stage, ".npmrc"), npmrc);
  for (const importer of expandWorkspaceImporters(rootDir)) {
    copyFile(path.posix.join(importer, "package.json"));
  }
  return stage;
}

/**
 * Runs pnpm's own manifest/lock consistency check in a staged copy.
 * @returns {{ ok: true } | { ok: false, stdout: string, stderr: string }}
 */
export function runFrozenLockfileCheck(options = {}) {
  const {
    rootDir = process.cwd(),
    platform = process.platform,
    comSpec = process.env.ComSpec,
  } = options;
  const execFile = options.execFile ?? execFileSync;
  const pnpm = getPnpmCommand(platform, comSpec);
  const stage = stageWorkspaceCopy(rootDir);
  try {
    execFile(pnpm.command, pnpm.args, {
      cwd: stage,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function main() {
  const policy = getLockfilePolicy(process.cwd());
  const { errors, stats } = validateLockfile(process.cwd(), policy);

  if (errors.length > 0) {
    console.error("[check-lockfile] FAIL — pnpm lockfile policy violations:");
    for (const error of errors) console.error(`  ✗ [${error.code}] ${error.detail}`);
    console.error(
      "\n  Possible causes:\n" +
        "  • a resolution was fetched over http:// or from a host other than registry.npmjs.org\n" +
        "  • a package is missing its sha512 integrity hash (tampered or legacy entry)\n" +
        "  • a local/link/git/patched resolution was introduced without a reviewed policy branch\n" +
        "  • the lockfile lists importers that do not match pnpm-workspace.yaml\n" +
        "  If a private registry is intentionally used, add its exact hostname to\n" +
        "  getLockfilePolicy().allowedHosts in scripts/check/check-lockfile.mjs"
    );
    process.exit(1);
  }
  console.log(
    `[check-lockfile] OK — ${stats.packages} package resolutions across ${stats.documents} document(s) ` +
      `(registry=${stats.byType.registry}, tarball=${stats.byType.tarball}, git=${stats.byType.git})`
  );

  const frozen = runFrozenLockfileCheck({ rootDir: process.cwd() });
  if (!frozen.ok) {
    console.error("[check-lockfile] FAIL — pnpm-lock.yaml is out of sync with the manifests:");
    if (frozen.stdout) console.error(frozen.stdout.trim());
    if (frozen.stderr) console.error(frozen.stderr.trim());
    console.error(
      "\n  → Run `pnpm install --lockfile-only` to regenerate the lockfile, review the diff, " +
        "then re-run `pnpm run check:lockfile`"
    );
    process.exit(1);
  }
  console.log(
    "[check-lockfile] OK — workspace manifests match the lockfile (pnpm --frozen-lockfile)"
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
