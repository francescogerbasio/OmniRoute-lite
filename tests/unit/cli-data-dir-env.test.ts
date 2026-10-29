import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir as cliResolveDataDir } from "../../bin/cli/data-dir.mjs";
import { resolveDataDir as runtimeResolveDataDir } from "../../src/lib/dataPaths.ts";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(REPO_ROOT, "bin", "omniroute.mjs");

async function withTempEnv(
  fn: (paths: { root: string; home: string; cwd: string }) => void | Promise<void>
) {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cli-env-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  delete process.env.DATA_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
  process.env.HOME = home;
  process.chdir(cwd);

  try {
    await fn({ root, home, cwd });
  } finally {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("CLI data dir uses the Lite dir and never adopts an existing upstream ~/.omniroute", async () => {
  await withTempEnv(({ home, root }) => {
    // Upstream fixture present — must NOT be adopted by the Lite CLI (issue #11).
    const upstreamDir = path.join(home, ".omniroute");
    fs.mkdirSync(upstreamDir, { recursive: true });
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg");

    const expected = path.join(root, "xdg", "omniroute-lite");
    assert.equal(cliResolveDataDir(), expected);
    assert.equal(cliResolveDataDir(), runtimeResolveDataDir());
    assert.notEqual(cliResolveDataDir(), upstreamDir);
  });
});

test("CLI data dir defaults to ~/.omniroute-lite when no XDG config is set", async () => {
  await withTempEnv(({ home }) => {
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(cliResolveDataDir(), path.join(home, ".omniroute-lite"));
  });
});

test("CLI env loader scans all env paths while preserving first value wins", () => {
  const source = fs.readFileSync(BIN, "utf8");
  const loaderStart = source.indexOf("function loadEnvFile()");
  const loaderEnd = source.indexOf("loadEnvFile();", loaderStart);
  const loaderSource = source.slice(loaderStart, loaderEnd);

  assert.match(loaderSource, /for \(const envPath of envPaths\)/);
  assert.match(loaderSource, /if \(process\.env\[key\] === undefined\)/);
  assert.doesNotMatch(loaderSource, /Loaded env from \$\{envPath\}[\s\S]{0,80}\breturn;/);
});

test("CLI env loader normalizes DATA_DIR instead of joining it raw (issue #11)", () => {
  const source = fs.readFileSync(BIN, "utf8");
  const loaderStart = source.indexOf("function loadEnvFile()");
  const loaderEnd = source.indexOf("loadEnvFile();", loaderStart);
  const loaderSource = source.slice(loaderStart, loaderEnd);

  // The data dir must go through the shared resolver (trim + absolutize), never through a
  // raw `join(process.env.DATA_DIR, ...)` — a padded value would otherwise point env loading
  // at a path that does not exist and the persisted key would never load.
  assert.match(loaderSource, /const dataDir = resolveDataDir\(\);/);
  assert.match(loaderSource, /migrateElectronServerEnv\(dataDir\)/);
  assert.match(loaderSource, /addEnvPath\(join\(dataDir, "\.env"\)\)/);
  assert.match(loaderSource, /if \(process\.env\.DATA_DIR\?\.trim\(\)\)/);
  assert.doesNotMatch(loaderSource, /join\(process\.env\.DATA_DIR/);

  // The durable path is resolved AFTER the loading loop on purpose: a loaded env file may
  // set DATA_DIR, and the warning must point where provisioning actually writes.
  const durableIdx = loaderSource.indexOf('const durableEnvPath = join(resolveDataDir(), ".env")');
  const loopIdx = loaderSource.indexOf("for (const envPath of envPaths)");
  assert.notEqual(durableIdx, -1, "durableEnvPath must use resolveDataDir()");
  assert.ok(durableIdx > loopIdx, "durableEnvPath must be resolved after env files are loaded");
});
