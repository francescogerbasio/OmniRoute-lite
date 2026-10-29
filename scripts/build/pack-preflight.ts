#!/usr/bin/env node
// scripts/build/pack-preflight.ts
// Packaging preflight for OmniRoute Lite (issue #13 / #23, PR B).
//
// WHAT THIS PROVES (and what it does not):
//   Level A — the manifest is coherent: name/version present, every `bin` target exists on disk,
//             `files` is declared, and lifecycle scripts are inventoried (legacy npm commands are
//             reported, never executed).
//   Level B — pnpm's own pack computation (pnpm 12.8.2, `--json`, lifecycle scripts disabled)
//             produces a file list that respects the repository's publish policy: no unexpected
//             paths, no leaked test artifacts, and every required source/runtime file present.
//             A missing `dist/…` set is reported as INCOMPLETE (the checkout was not built), not
//             as a passing production artifact; `--require-complete` makes it fatal after a build.
//   Level C — actually installing the packed tarball and booting it — is deliberately NOT here.
//             It needs a real built standalone artifact and is validated at the release checkpoint.
//
// SAFETY: never publishes, never builds, never installs, never runs lifecycle scripts:
//   `pnpm pack --ignore-scripts --ignore-pnpmfile --offline` with separate argv (no shell).
//
// Usage:
//   pnpm run check:pack-preflight                    # Level A + B dry-run (CI)
//   pnpm run check:pack-preflight -- --real          # real tarball in a temp dir, then removed
//   pnpm run check:pack-preflight -- --require-complete
//   pnpm run check:pack-preflight -- --json
//   pnpm run check:pack-preflight -- --root <dir>    # inspect another checkout (tests/fixtures)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { findLeakedTestArtifactPaths } from "./mcpPublishedFilesClosure.ts";
import {
  PACK_ARTIFACT_REQUIRED_PATHS,
  PACK_ARTIFACT_ROOT_ALLOWED_EXACT_PATHS,
  PACK_ARTIFACT_ROOT_ALLOWED_PATH_PREFIXES,
  findMissingArtifactPaths,
  findUnexpectedArtifactPaths,
} from "./pack-artifact-policy.ts";

export type PackPreflightStatus = "valid" | "incomplete" | "invalid";

export interface PnpmPackReport {
  name: string;
  version: string;
  filename: string;
  files: string[];
}

export interface PackArtifactEvaluation {
  status: PackPreflightStatus;
  ok: boolean;
  fileCount: number;
  missingRequired: string[];
  missingBuildArtifacts: string[];
  missingSourceArtifacts: string[];
  unexpected: string[];
  leaked: string[];
}

export interface ManifestInspection {
  name: string;
  version: string;
  lifecycle: Record<string, string>;
  warnings: string[];
  errors: string[];
}

const LIFECYCLE_SCRIPTS = [
  "prepublishOnly",
  "prepublish",
  "prepare",
  "prepack",
  "postpack",
  "postinstall",
];

const NPM_IN_COMMAND = /\bnpm\s+(?:run|install|ci|exec|pack|audit)\b|\bnpx\b/;

const PACK_EXEC_OPTIONS = {
  encoding: "utf8" as const,
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses `pnpm pack --json` output. pnpm 12 emits a single object
 * `{ name, version, filename, files: [{ path }] }` for a single-package pack; an array is
 * accepted too so a future recursive invocation cannot silently disable the gate.
 */
export function parsePnpmPackJson(raw: string): PnpmPackReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `pnpm pack did not return valid JSON: ${String((error as Error)?.message ?? error)}`
    );
  }
  const report = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(report)) throw new Error("pnpm pack JSON report is not an object");
  if (!Array.isArray(report.files)) {
    throw new Error("pnpm pack JSON report has no `files[]` list (cannot verify the artifact)");
  }
  const files = report.files
    .map((entry) => (isRecord(entry) && typeof entry.path === "string" ? entry.path : null))
    .filter((file): file is string => typeof file === "string" && file.length > 0);
  if (files.length === 0) throw new Error("pnpm pack reported an empty file list");
  return {
    name: typeof report.name === "string" ? report.name : "",
    version: typeof report.version === "string" ? report.version : "",
    filename: typeof report.filename === "string" ? report.filename : "",
    files,
  };
}

/** Package metadata + `bin`/`files` sanity, without packing or building anything. */
export function inspectManifest(rootDir: string): ManifestInspection {
  const manifestPath = path.join(rootDir, "package.json");
  const errors: string[] = [];
  const warnings: string[] = [];
  let manifest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!isRecord(parsed)) throw new Error("package.json is not an object");
    manifest = parsed;
  } catch (error) {
    return {
      name: "",
      version: "",
      lifecycle: {},
      warnings,
      errors: [`cannot read ${manifestPath}: ${String((error as Error)?.message ?? error)}`],
    };
  }

  const name = typeof manifest.name === "string" ? manifest.name : "";
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (!name) errors.push("package.json has no `name`");
  if (!version) errors.push("package.json has no `version`");

  const bin = isRecord(manifest.bin) ? manifest.bin : {};
  if (Object.keys(bin).length === 0) errors.push("package.json declares no `bin` entry");
  for (const [binName, target] of Object.entries(bin)) {
    if (typeof target !== "string") {
      errors.push(`bin."${binName}" is not a path`);
      continue;
    }
    if (!fs.existsSync(path.join(rootDir, target))) {
      errors.push(`bin."${binName}" points at a missing file: ${target}`);
    }
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push("package.json declares no `files` allowlist (packing would drift)");
  }

  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  const lifecycle: Record<string, string> = {};
  for (const scriptName of LIFECYCLE_SCRIPTS) {
    const command = scripts[scriptName];
    if (typeof command !== "string") continue;
    lifecycle[scriptName] = command;
    if (NPM_IN_COMMAND.test(command)) {
      warnings.push(
        `${scriptName} still runs npm/npx (legacy; the preflight never executes lifecycle scripts)`
      );
    }
  }

  return { name, version, lifecycle, warnings, errors };
}

export function buildPackArgs({
  dryRun,
  destination,
}: {
  dryRun: boolean;
  destination?: string;
}): string[] {
  return [
    "pack",
    ...(dryRun ? ["--dry-run"] : []),
    "--json",
    // The preflight must never execute repository or dependency code.
    "--ignore-scripts",
    "--ignore-pnpmfile",
    // No registry access is needed to compute a package's own file list.
    "--offline",
    ...(destination ? ["--pack-destination", destination] : []),
  ];
}

/**
 * Runs pnpm pack and returns its report. A real pack writes into a fresh temp directory that is
 * always removed, so the repository's runtime/packaging state is untouched.
 */
export function runPack({
  rootDir,
  dryRun,
  execFile = execFileSync,
}: {
  rootDir: string;
  dryRun: boolean;
  execFile?: typeof execFileSync;
}): PnpmPackReport {
  const destination = dryRun
    ? undefined
    : fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pack-preflight-"));
  try {
    const stdout = execFile("pnpm", buildPackArgs({ dryRun, destination }), {
      ...PACK_EXEC_OPTIONS,
      cwd: rootDir,
    });
    return parsePnpmPackJson(String(stdout ?? ""));
  } finally {
    if (destination) {
      fs.rmSync(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

/** Evaluates a pnpm pack file list against the repository's publish policy. */
export function evaluatePackArtifact(
  files: string[],
  {
    requiredPaths = PACK_ARTIFACT_REQUIRED_PATHS,
    requireComplete = false,
    // Defaults are the repository policy; tests may narrow them to stay hermetic.
    allowedExactPaths = PACK_ARTIFACT_ROOT_ALLOWED_EXACT_PATHS,
    allowedPrefixes = PACK_ARTIFACT_ROOT_ALLOWED_PATH_PREFIXES,
  }: {
    requiredPaths?: string[];
    requireComplete?: boolean;
    allowedExactPaths?: string[];
    allowedPrefixes?: string[];
  } = {}
): PackArtifactEvaluation {
  const unexpected = findUnexpectedArtifactPaths(files, {
    exactPaths: allowedExactPaths,
    prefixPaths: allowedPrefixes,
  });
  const leaked = findLeakedTestArtifactPaths(files);
  const missingRequired = findMissingArtifactPaths(files, requiredPaths);
  const missingBuildArtifacts = missingRequired.filter((file) => file.startsWith("dist/"));
  const missingSourceArtifacts = missingRequired.filter((file) => !file.startsWith("dist/"));

  let status: PackPreflightStatus = "valid";
  if (unexpected.length > 0 || leaked.length > 0 || missingSourceArtifacts.length > 0) {
    // Anything outside the policy, or a missing NON-build file, is a real defect — even unbuilt.
    status = "invalid";
  } else if (missingBuildArtifacts.length > 0) {
    // Only build outputs missing: the checkout was not built. Never call this "valid".
    status = "incomplete";
  }

  return {
    status,
    ok: status === "valid" || (status === "incomplete" && !requireComplete),
    fileCount: files.length,
    missingRequired,
    missingBuildArtifacts,
    missingSourceArtifacts,
    unexpected,
    leaked,
  };
}

interface ParsedFlags {
  real: boolean;
  requireComplete: boolean;
  json: boolean;
  root: string;
  help: boolean;
}

export function parseArgs(argv: string[], cwd = process.cwd()): ParsedFlags {
  const flags: ParsedFlags = {
    real: false,
    requireComplete: false,
    json: false,
    root: cwd,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--real") flags.real = true;
    else if (arg === "--require-complete") flags.requireComplete = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a directory");
      flags.root = path.resolve(cwd, value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return flags;
}

function printReport(
  manifest: ManifestInspection,
  pack: PnpmPackReport | null,
  evaluation: PackArtifactEvaluation | null,
  flags: ParsedFlags,
  packError?: string
): void {
  if (flags.json) {
    console.log(JSON.stringify({ manifest, pack, evaluation, error: packError ?? null }, null, 2));
    return;
  }
  const mode = flags.real ? "pnpm pack" : "pnpm pack --dry-run";
  console.log(
    `[pack-preflight] ${manifest.name || "?"}@${manifest.version || "?"} — ${mode} (scripts disabled, offline)`
  );
  for (const warning of manifest.warnings) console.log(`[pack-preflight] warning: ${warning}`);
  if (packError) {
    console.error(`[pack-preflight] FAIL — ${packError}`);
    return;
  }
  if (!pack || !evaluation) return;
  console.log(
    `[pack-preflight] files=${evaluation.fileCount} missing=${evaluation.missingRequired.length} ` +
      `unexpected=${evaluation.unexpected.length} leaked=${evaluation.leaked.length}`
  );
  if (evaluation.status === "invalid") {
    console.error("[pack-preflight] FAIL — artifact violates the publish policy:");
    for (const file of evaluation.unexpected.slice(0, 20)) console.error(`  ✗ unexpected: ${file}`);
    for (const file of evaluation.leaked.slice(0, 20)) console.error(`  ✗ test artifact: ${file}`);
    for (const file of evaluation.missingSourceArtifacts.slice(0, 20)) {
      console.error(`  ✗ missing required (non-build) file: ${file}`);
    }
    return;
  }
  if (evaluation.status === "incomplete") {
    const headline = `INCOMPLETE — ${evaluation.missingBuildArtifacts.length} build artifact(s) under dist/ are missing; this checkout is not publishable until the standalone build runs.`;
    if (evaluation.ok) {
      console.log(`[pack-preflight] ${headline}`);
      console.log("[pack-preflight] Use --require-complete after a build to make this fatal.");
    } else {
      console.error(`[pack-preflight] FAIL — ${headline}`);
    }
    return;
  }
  console.log("[pack-preflight] OK — policy satisfied and every required artifact is present.");
}

function main(): void {
  let flags: ParsedFlags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[pack-preflight] ${String((error as Error)?.message ?? error)}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(
      "Usage: check:pack-preflight [--real] [--require-complete] [--json] [--root <dir>]"
    );
    process.exit(0);
  }

  const manifest = inspectManifest(flags.root);
  if (manifest.errors.length > 0) {
    if (flags.json) printReport(manifest, null, null, flags);
    else {
      console.error("[pack-preflight] FAIL — manifest is not packageable:");
      for (const error of manifest.errors) console.error(`  ✗ ${error}`);
    }
    process.exit(1);
  }

  let pack: PnpmPackReport;
  try {
    pack = runPack({ rootDir: flags.root, dryRun: !flags.real });
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    printReport(manifest, null, null, flags, message);
    process.exit(1);
  }

  const evaluation = evaluatePackArtifact(pack.files, { requireComplete: flags.requireComplete });
  printReport(manifest, pack, evaluation, flags);
  process.exit(evaluation.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
