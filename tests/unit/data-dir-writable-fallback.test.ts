import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveWritableDataDir,
  getDefaultDataDir,
  resolveDataDir,
} from "../../src/lib/dataPaths.ts";

// Running as root bypasses POSIX permission bits, so a chmod-based "unwritable"
// directory would still be writable and the EACCES/EPERM branch never triggers.
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const IS_WINDOWS = process.platform === "win32";

async function withTempEnv(fn: (paths: { root: string; home: string }) => void | Promise<void>) {
  const originalEnv = { ...process.env };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-datadir-"));
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
    // Restore perms before cleanup so rmSync can delete read-only parents.
    try {
      fs.chmodSync(root, 0o755);
    } catch {
      // ignore
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("resolveWritableDataDir returns the configured DATA_DIR when it is writable", async () => {
  await withTempEnv(({ root }) => {
    const configured = path.join(root, "writable-data");
    process.env.DATA_DIR = configured;

    const resolved = resolveWritableDataDir();
    assert.equal(resolved, path.resolve(configured));
    // The probe creates the directory as a side effect.
    assert.ok(fs.existsSync(configured));
  });
});

test(
  "resolveWritableDataDir FAILS CLOSED when DATA_DIR is not writable (EACCES/EPERM) — no fallback",
  { skip: IS_ROOT || IS_WINDOWS },
  async () => {
    await withTempEnv(({ root, home }) => {
      // A read-only parent makes mkdir of the child fail with EACCES/EPERM.
      const lockedParent = path.join(root, "locked");
      fs.mkdirSync(lockedParent, { recursive: true });
      fs.chmodSync(lockedParent, 0o555);

      const configured = path.join(lockedParent, "data");
      process.env.DATA_DIR = configured;

      // Issue #11: an unwritable configured DATA_DIR must fail closed. Silently
      // falling back to the default dir would divert the database (and its
      // encrypted credentials) to a location the operator did not choose.
      assert.throws(
        () => resolveWritableDataDir(),
        (err: Error) => {
          return (
            err.message.includes("not writable") && err.message.includes(path.resolve(configured))
          );
        }
      );
      // ...and it must not have quietly created either directory.
      assert.equal(fs.existsSync(configured), false);
      assert.equal(fs.existsSync(getDefaultDataDir()), false);
      assert.ok(getDefaultDataDir().startsWith(path.resolve(home)));
    });
  }
);

test(
  "resolveWritableDataDir FAILS CLOSED for an existing but read-only DATA_DIR",
  { skip: IS_ROOT || IS_WINDOWS },
  async () => {
    await withTempEnv(({ root }) => {
      // mkdirSync is a no-op on an existing directory, so an existing read-only
      // dir only fails at the explicit writability probe.
      const readOnly = path.join(root, "read-only-data");
      fs.mkdirSync(readOnly, { recursive: true });
      fs.chmodSync(readOnly, 0o555);
      process.env.DATA_DIR = readOnly;

      assert.throws(
        () => resolveWritableDataDir(),
        (err: Error) => err.message.includes("not writable")
      );
    });
  }
);

test("resolveWritableDataDir returns the default dir (no probe) when DATA_DIR is unset", async () => {
  await withTempEnv(() => {
    delete process.env.DATA_DIR;
    // #10428: this asserts the SERVER path. Since the test-context guard now redirects a
    // DATA_DIR-less test process to a temp dir (so a test can never open the operator's
    // real DB), opt back in explicitly here — otherwise this test would be asserting the
    // guard's behavior instead of the server's.
    process.env.OMNIROUTE_ALLOW_DEFAULT_DATA_DIR = "1";
    const resolved = resolveWritableDataDir();
    assert.equal(resolved, getDefaultDataDir());
    // Matches the pure resolver when no override is present.
    assert.equal(resolved, resolveDataDir());
  });
});

test("resolveWritableDataDir rethrows non-permission errors", { skip: IS_WINDOWS }, async () => {
  await withTempEnv(({ root }) => {
    // Point DATA_DIR at a path whose parent is a regular file → ENOTDIR, not EACCES.
    const fileParent = path.join(root, "iam-a-file");
    fs.writeFileSync(fileParent, "x");

    const configured = path.join(fileParent, "data");
    process.env.DATA_DIR = configured;

    assert.throws(
      () => resolveWritableDataDir(),
      (err: NodeJS.ErrnoException) => {
        return err.code !== "EACCES" && err.code !== "EPERM";
      }
    );
  });
});

test("resolveWritableDataDir leaves the cloud sentinel untouched", async () => {
  await withTempEnv(() => {
    process.env.DATA_DIR = "/some/configured/path";
    const resolved = resolveWritableDataDir({ isCloud: true });
    assert.equal(resolved, "/tmp");
  });
});
