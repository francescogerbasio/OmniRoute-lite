import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ensurePrivateDataDir, writePrivateFile } from "../privateDataDir.mjs";

/**
 * Decide whether a CLI invocation should provision (generate + persist) the
 * STORAGE_ENCRYPTION_KEY into DATA_DIR/.env.
 *
 * Purely informational invocations must NOT create `~/.omniroute-lite/.env` or write
 * a key — they never touch encrypted storage. Generating a 32-byte key and a
 * `.env` file just to print `omniroute --version` (or `--help`) is a surprising
 * side effect: a read-only command should not mutate the data dir.
 *
 * Returns FALSE only for: `--version`/`-V` or `--help`/`-h` anywhere in the args,
 * and the `help`/`completion` subcommands.
 *
 * Returns TRUE for everything else, INCLUDING a bare `omniroute` (no args) — the
 * `serve` command is `isDefault: true`, so a bare invocation starts the server,
 * which needs the encryption key. This preserves the #1622 persistence fix
 * (key generated on first real run and reused across restarts).
 *
 * @param {string[]} argv - process.argv (node + script + args).
 * @returns {boolean}
 */
const INFO_FLAGS = new Set(["-h", "--help", "-V", "--version"]);
const INFO_COMMANDS = new Set(["help", "completion"]);

export function shouldProvisionStorageKey(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  // Bare `omniroute` runs the default `serve` command → must provision.
  if (args.length === 0) return true;
  if (args.some((a) => INFO_FLAGS.has(a))) return false;
  if (INFO_COMMANDS.has(args[0])) return false;
  return true;
}

/**
 * Provision (generate + persist) STORAGE_ENCRYPTION_KEY into {dataDir}/.env.
 *
 * The #1622 persistence contract: the key is written once, on the first run
 * that touches encrypted storage, and reused across restarts — so it MUST be
 * resolved through the shared data-dir helpers (DATA_DIR or
 * bin/cli/data-dir.mjs::getDefaultDataDir()), never an independent homedir
 * guess that would split secrets from the database under XDG/Windows.
 *
 * Safety guard (mirrors bootstrapEnv's hasEncryptedCredentials): when a
 * database already exists in dataDir, a fresh key could NOT decrypt its
 * previously-encrypted credentials and would lock the operator out — refuse
 * and instruct how to restore instead.
 *
 * @param {string} dataDir - resolved data dir.
 * @returns {string|null} the generated key (null when nothing was generated).
 */
export function provisionStorageKey(dataDir) {
  const envPath = join(dataDir, ".env");
  const dbPath = join(dataDir, "storage.sqlite");

  // Safety guard: never auto-generate a fresh key when a database already exists in
  // DATA_DIR. A new key cannot decrypt previously-encrypted credentials and would lock the
  // user out (then the encryption layer aborts on every read). Restoring the previous
  // key in DATA_DIR/.env recovers it. (#1622 follow-up — reported by Daniel Nach)
  if (existsSync(dbPath)) {
    console.warn(
      `  \x1b[33m⚠ STORAGE_ENCRYPTION_KEY is not set but a database already exists at\x1b[0m\n` +
        `  \x1b[33m  ${dbPath}\x1b[0m\n` +
        `  \x1b[33m  Not auto-generating a new key — it could not decrypt existing data. Restore your\x1b[0m\n` +
        `  \x1b[33m  previous key in ${envPath}, or move/remove the database to start fresh.\x1b[0m`
    );
    return null;
  }

  // First run (no database yet) — generate and persist a fresh key.
  // GHSA-2pg2-xm9r-8544: owner-only — .env holds the key to every stored credential.
  ensurePrivateDataDir(dataDir);

  const key = randomBytes(32).toString("hex");

  // Read existing .env content or start fresh
  let content = "";
  if (existsSync(envPath)) {
    content = readFileSync(envPath, "utf-8");
  }

  // Append key if not already present
  if (!content.includes("STORAGE_ENCRYPTION_KEY=")) {
    const separator = content.trim() ? "\n" : "";
    writePrivateFile(
      envPath,
      content.trimEnd() + separator + `STORAGE_ENCRYPTION_KEY=${key}` + "\n"
    );
    console.log(`  \x1b[2m✨ Generated STORAGE_ENCRYPTION_KEY in ${envPath}\x1b[0m`);
    return key;
  }

  return null;
}
