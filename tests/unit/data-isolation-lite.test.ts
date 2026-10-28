import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveDataDir,
  getDefaultDataDir,
  getLegacyDotDataDir,
  resolveWritableDataDir,
  isSamePath,
} from "../../src/lib/dataPaths.ts";
import { resolveMitmDataDir } from "../../src/mitm/dataDir.ts";
import { resolveDataDir as cliResolveDataDir } from "../../bin/cli/data-dir.mjs";
import { resolveDataDir as syncEnvResolveDataDir } from "../../scripts/dev/sync-env.mjs";
import { resolveDataDir as webdavResolveDataDir } from "../../scripts/dev/webdav-handler.mjs";
import { bootstrapEnv } from "../../scripts/build/bootstrap-env.mjs";

// Issue #11 — data isolation contract:
//   * the Lite fork defaults to `~/.omniroute-lite`;
//   * an existing upstream `~/.omniroute` is NEVER adopted and NEVER modified;
//   * all resolvers (server core, CLI, MITM, WebDAV, bootstrap) agree.

async function withTempEnv(fn: (paths: { root: string; home: string }) => void | Promise<void>) {
  const originalEnv = { ...process.env };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-lite-isolation-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });

  delete process.env.DATA_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    await fn({ root, home });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function snapshotDir(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath ?? dir, entry.name);
    if (entry.isFile()) files.set(full, fs.readFileSync(full));
  }
  return files;
}

function assertSameSnapshot(before: Map<string, Buffer>, dir: string, label: string) {
  const after = snapshotDir(dir);
  assert.equal(after.size, before.size, `${label}: file count changed`);
  for (const [file, content] of before) {
    assert.ok(after.get(file)?.equals(content), `${label}: ${file} was modified`);
  }
}

test("default is ~/.omniroute-lite even when an upstream ~/.omniroute fixture exists; fixture untouched", async () => {
  await withTempEnv(({ home }) => {
    // Simulate an operator who also runs upstream OmniRoute: a populated ~/.omniroute.
    const upstreamDir = path.join(home, ".omniroute");
    fs.mkdirSync(upstreamDir, { recursive: true });
    fs.writeFileSync(path.join(upstreamDir, "storage.sqlite"), "upstream-db-bytes");
    fs.writeFileSync(path.join(upstreamDir, "usage.json"), '{"history":["upstream"]}');
    const before = snapshotDir(upstreamDir);

    const liteDir = path.join(home, ".omniroute-lite");

    // Pure resolvers: Lite default, never the upstream dir, nothing created yet.
    assert.equal(getDefaultDataDir(), liteDir);
    assert.equal(resolveDataDir(), liteDir);
    assert.notEqual(getDefaultDataDir(), upstreamDir);
    assert.equal(fs.existsSync(liteDir), false, "pure resolver must not create the dir");

    // Startup resolver: lands on the Lite dir, still never the upstream dir.
    // (#10428: this pins the SERVER path — opt back in past the test-context guard,
    // exactly like tests/unit/data-dir-writable-fallback.test.ts does.)
    process.env.OMNIROUTE_ALLOW_DEFAULT_DATA_DIR = "1";
    const writable = resolveWritableDataDir();
    assert.equal(writable, liteDir);
    assert.notEqual(writable, upstreamDir);

    // The upstream fixture is byte-identical and gained no new files.
    assertSameSnapshot(before, upstreamDir, "upstream fixture");
  });
});

test("legacy vs default separation (server core and CLI resolvers agree)", async () => {
  await withTempEnv(({ home }) => {
    const upstreamDir = path.join(home, ".omniroute");
    const liteDir = path.join(home, ".omniroute-lite");

    // The legacy helper is pinned to the upstream name (migration source only).
    assert.equal(getLegacyDotDataDir(), upstreamDir);

    // ...but the default never is, even when the upstream dir exists.
    fs.mkdirSync(upstreamDir, { recursive: true });
    assert.equal(getDefaultDataDir(), liteDir);
    assert.equal(isSamePath(getDefaultDataDir(), upstreamDir), false);

    // CLI resolver parity.
    assert.equal(cliResolveDataDir(), liteDir);
    assert.notEqual(cliResolveDataDir(), upstreamDir);
  });
});

test("resolver parity: explicit DATA_DIR wins for core, CLI, MITM and WebDAV", async () => {
  await withTempEnv(({ root }) => {
    const configured = path.join(root, "custom-data");
    process.env.DATA_DIR = configured;
    const resolvedConfigured = path.resolve(configured);

    assert.equal(resolveDataDir(), resolvedConfigured);
    assert.equal(cliResolveDataDir(), resolvedConfigured);
    assert.equal(resolveMitmDataDir(), resolvedConfigured);
    assert.equal(webdavResolveDataDir(), resolvedConfigured);
    assert.equal(syncEnvResolveDataDir(), resolvedConfigured);
  });
});

test("resolver parity: XDG_CONFIG_HOME → <xdg>/omniroute-lite for every resolver", async () => {
  await withTempEnv(({ root }) => {
    const xdg = path.join(root, "xdg");
    process.env.XDG_CONFIG_HOME = xdg;
    const expected = path.join(path.resolve(xdg), "omniroute-lite");

    assert.equal(getDefaultDataDir(), expected);
    assert.equal(cliResolveDataDir(), expected);
    assert.equal(resolveMitmDataDir(), expected);
    assert.equal(webdavResolveDataDir(), expected);
    assert.equal(syncEnvResolveDataDir(), expected);
  });
});

test("win32 shape: %APPDATA%/omniroute-lite (core, CLI, MITM)", async () => {
  await withTempEnv(({ root }) => {
    const appData = path.join(root, "appdata");
    process.env.APPDATA = appData;
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      const expected = path.join(path.resolve(appData), "omniroute-lite");
      assert.equal(getDefaultDataDir(), expected);
      assert.equal(cliResolveDataDir(), expected);
      assert.equal(resolveMitmDataDir(), expected);
      assert.equal(syncEnvResolveDataDir(), expected);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, "platform", originalDescriptor);
      }
    }
  });
});

test("cloud sentinel: isCloud keeps /tmp untouched", async () => {
  await withTempEnv(() => {
    process.env.DATA_DIR = "/some/configured/path";
    assert.equal(resolveDataDir({ isCloud: true }), "/tmp");
    assert.equal(resolveWritableDataDir({ isCloud: true }), "/tmp");
  });
});

test("bootstrapEnv defaults to ~/.omniroute-lite and never creates the upstream dir", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-lite-bootstrap-"));
  const home = path.join(root, "home");
  const originalCwd = process.cwd();

  const originalEnv = { ...process.env };
  delete process.env.DATA_DIR;
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(root); // keep the repo's own .env out of the bootstrap candidates

  try {
    bootstrapEnv({ quiet: true });

    const liteDir = path.join(home, ".omniroute-lite");
    const serverEnv = path.join(liteDir, "server.env");
    assert.ok(fs.existsSync(serverEnv), "secrets must persist to the Lite data dir");
    assert.match(fs.readFileSync(serverEnv, "utf8"), /JWT_SECRET=/);
    assert.equal(
      fs.existsSync(path.join(home, ".omniroute")),
      false,
      "bootstrap must never create the upstream ~/.omniroute"
    );
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
});

test("explicit DATA_DIR at upstream ~/.omniroute stays legal but is loudly warned; fixture untouched", async () => {
  await withTempEnv(({ home }) => {
    const upstreamDir = path.join(home, ".omniroute");
    fs.mkdirSync(upstreamDir, { recursive: true });
    fs.writeFileSync(path.join(upstreamDir, "storage.sqlite"), "upstream-db-bytes");
    const before = snapshotDir(upstreamDir);

    process.env.DATA_DIR = upstreamDir;
    const outputLines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => {
      outputLines.push(String(msg));
    };
    try {
      const resolved = resolveWritableDataDir();
      // The explicit operator choice wins...
      assert.equal(resolved, upstreamDir);
      // ...but it is announced loudly and actionably.
      assert.ok(
        outputLines.some(
          (line) => line.includes("upstream OmniRoute") && line.includes("unset DATA_DIR")
        ),
        `expected a loud upstream-sharing warning, got: ${JSON.stringify(outputLines)}`
      );
      // ...and no parallel Lite dir is created behind the operator's back.
      assert.equal(fs.existsSync(path.join(home, ".omniroute-lite")), false);
    } finally {
      console.warn = originalWarn;
    }

    // The upstream fixture itself is untouched (writability probe only).
    assertSameSnapshot(before, upstreamDir, "upstream fixture");
  });
});

test("no source file resolves a default data dir via join(homedir(), '.omniroute')", async () => {
  // Guard against regressions: the upstream name may only survive in the pinned
  // legacy helpers, comments, scan-exclusion lists and upstream-VPS test tooling.
  // Pure-Node walk so the test never depends on rg being installed.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const scanRoots = ["src", "open-sse", "bin", "scripts", "electron"].map((dir) =>
    path.join(repoRoot, dir)
  );
  const scannedExts = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs", ".sh"]);
  const joinPattern = /(?:os\.)?homedir\(\)\s*,\s*["'`]\.omniroute["'`]/;
  const shellPattern = /\$HOME\/\.omniroute(?!-lite)/;
  const appDataPattern = /%APPDATA%[\\/]+omniroute(?!-lite)/;

  const offenders: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && scannedExts.has(path.extname(entry.name))) {
        const content = fs.readFileSync(full, "utf8");
        if (
          joinPattern.test(content) ||
          shellPattern.test(content) ||
          appDataPattern.test(content)
        ) {
          offenders.push(full);
        }
      }
    }
  }
  for (const rootDir of scanRoots) walk(rootDir, 0);

  assert.deepEqual(
    offenders.map((f) => path.relative(repoRoot, f)),
    [],
    "files still hardcoding the upstream data dir in a path join (must use .omniroute-lite)"
  );
});
