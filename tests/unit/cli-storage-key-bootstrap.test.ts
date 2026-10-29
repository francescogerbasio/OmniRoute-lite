import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "omniroute.mjs"
);

function runCli(
  dataDir: string,
  opts: { cwd?: string; rawDataDir?: string } = {}
): { code: number | null; stdout: string; stderr: string } {
  const cleanEnv = { ...process.env };
  delete cleanEnv.STORAGE_ENCRYPTION_KEY;
  // Isolate from the development repo's .env so local runs match CI where the
  // working tree has no .env at checkout time (gitignored). Without this,
  // bin/omniroute.mjs picks up STORAGE_ENCRYPTION_KEY from the repo .env and
  // the bootstrap skips writing DATA_DIR/.env (the behaviour the test exercises).
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-home-"));
  try {
    // Use a real (non-informational) command so the STORAGE_ENCRYPTION_KEY
    // bootstrap runs. `--version`/`--help` are intentionally skipped now (#3129),
    // so the #1622 provisioning path must be exercised by an actual command.
    // `config list --json` is fast and offline (no server, no network).
    const res = spawnSync("node", [BIN, "config", "list", "--json"], {
      cwd: opts.cwd ?? dataDir,
      env: {
        ...cleanEnv,
        DATA_DIR: opts.rawDataDir ?? dataDir,
        HOME: isolatedHome,
        NO_UPDATE_NOTIFIER: "1",
        OMNIROUTE_CLI_SKIP_REPO_ENV: "1",
      },
      timeout: 60_000,
      encoding: "utf-8",
    });
    return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } finally {
    fs.rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// #1622 follow-up (reported by Daniel Nach; original persistence by @Chewji9875):
// the CLI must persist the key into DATA_DIR (not just ~/.omniroute) so Docker/custom-DATA_DIR
// users keep it across restarts, and must NEVER auto-generate a fresh key when a database
// already exists (a new key can't decrypt prior data → user locked out).

test("CLI generates STORAGE_ENCRYPTION_KEY into DATA_DIR on first run (#1622)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-a-"));
  try {
    runCli(dir);
    const envPath = path.join(dir, ".env");
    assert.ok(fs.existsSync(envPath), "DATA_DIR/.env must be created");
    const content = fs.readFileSync(envPath, "utf-8");
    assert.match(
      content,
      /STORAGE_ENCRYPTION_KEY=[0-9a-f]{64}/,
      "key persisted into DATA_DIR/.env"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI refuses to auto-generate a key when a database already exists (#1622)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-b-"));
  try {
    fs.writeFileSync(path.join(dir, "storage.sqlite"), "fake-db");
    const { stderr } = runCli(dir);
    const envPath = path.join(dir, ".env");
    const hasKey =
      fs.existsSync(envPath) &&
      fs.readFileSync(envPath, "utf-8").includes("STORAGE_ENCRYPTION_KEY=");
    assert.equal(hasKey, false, "must NOT generate a key when a DB already exists");
    assert.match(stderr, /already exists/i, "must warn that a database already exists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("padded DATA_DIR still loads a previously persisted key (issue #11 review)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-c-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-key-cwd-"));
  try {
    const key = "a".repeat(64);
    fs.writeFileSync(path.join(dir, ".env"), `STORAGE_ENCRYPTION_KEY=${key}\n`);
    // An existing database makes a provisioning attempt observable: without the loaded key
    // the CLI refuses to generate a new one and warns that a database already exists.
    fs.writeFileSync(path.join(dir, "storage.sqlite"), "fake-db");

    // Run from an EMPTY cwd on purpose: `<cwd>/.env` is always an env candidate, so reusing
    // `dir` as the cwd would load the key through that path and hide the DATA_DIR bug.
    const { stdout, stderr } = runCli(dir, { cwd, rawDataDir: `  ${dir}  ` });

    assert.ok(
      stdout.includes(`Loaded env from ${path.join(dir, ".env")}`),
      `DATA_DIR must be normalized before env discovery; stdout: ${stdout}`
    );
    assert.doesNotMatch(
      stderr,
      /already exists/i,
      `the persisted key must be loaded, not re-provisioned; stderr: ${stderr}`
    );
    assert.equal(
      fs.readFileSync(path.join(dir, ".env"), "utf-8"),
      `STORAGE_ENCRYPTION_KEY=${key}\n`,
      "the persisted key file must be left untouched"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
