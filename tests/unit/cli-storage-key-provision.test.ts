import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { provisionStorageKey } from "../../bin/cli/utils/storageKeyProvision.mjs";
import { getDefaultDataDir } from "../../bin/cli/data-dir.mjs";

// Issue #11 follow-up: the CLI's STORAGE_ENCRYPTION_KEY provisioning must resolve its
// data dir through the SAME shared helper the app uses (DATA_DIR override or
// getDefaultDataDir()) — under XDG/Windows an independent homedir guess would split
// secrets from the database — and must stay idempotent across restarts.

function withTempEnv(fn: (paths: { root: string; home: string }) => void): void {
  const originalEnv: Record<string, string | undefined> = { ...process.env };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-lite-provision-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });

  delete process.env.DATA_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    fn({ root, home });
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

test("provisionStorageKey persists once and is idempotent across restarts (XDG shape)", () => {
  withTempEnv(({ root }) => {
    const xdg = path.join(root, "xdg");
    process.env.XDG_CONFIG_HOME = xdg;

    const dataDir = getDefaultDataDir();
    assert.equal(dataDir, path.join(path.resolve(xdg), "omniroute-lite"));

    // First run: generate + persist.
    const firstKey = provisionStorageKey(dataDir);
    assert.ok(firstKey, "first provision must return the generated key");

    const envPath = path.join(dataDir, ".env");
    assert.ok(fs.existsSync(envPath), "key must persist to {dataDir}/.env");
    const persisted = fs.readFileSync(envPath, "utf8");
    assert.match(persisted, /^STORAGE_ENCRYPTION_KEY=[0-9a-f]{64}$/m);
    assert.ok(persisted.includes(`STORAGE_ENCRYPTION_KEY=${firstKey}`));

    // Simulated restart: fresh process (env reloaded elsewhere), provision again.
    const secondKey = provisionStorageKey(dataDir);
    assert.equal(secondKey, null, "restart must not regenerate a persisted key");
    assert.equal(
      fs.readFileSync(envPath, "utf8"),
      persisted,
      "restart must leave the persisted key file untouched"
    );
  });
});

test("provisionStorageKey follows getDefaultDataDir under Windows APPDATA", () => {
  withTempEnv(({ root }) => {
    const appData = path.join(root, "appdata");
    process.env.APPDATA = appData;
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const dataDir = getDefaultDataDir();
      assert.equal(dataDir, path.join(path.resolve(appData), "omniroute-lite"));

      const key = provisionStorageKey(dataDir);
      assert.ok(key);
      assert.ok(fs.existsSync(path.join(dataDir, ".env")));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, "platform", originalDescriptor);
      }
    }
  });
});

test("provisionStorageKey refuses to generate when a database already exists", () => {
  withTempEnv(() => {
    const dataDir = getDefaultDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "storage.sqlite"), "existing-db");

    const key = provisionStorageKey(dataDir);
    assert.equal(key, null, "existing DB must never receive a fresh (lockout) key");
    assert.equal(
      fs.existsSync(path.join(dataDir, ".env")),
      false,
      "no key file may be created for an existing encrypted database"
    );
  });
});

test("bin/omniroute.mjs resolves provisioning via the shared resolver (source contract)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const src = fs.readFileSync(path.join(repoRoot, "bin/omniroute.mjs"), "utf8");
  // Both the secret-tightening and the key provision must use the shared resolver.
  assert.match(src, /process\.env\.DATA_DIR \|\| getDefaultDataDir\(\)/);
  // No independent homedir-based data-dir guesses may remain in the CLI entry.
  assert.doesNotMatch(src, /homedir\(\)\s*,\s*["'`]\.omniroute(-lite)?["'`]/);
});
