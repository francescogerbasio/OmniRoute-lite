import os from "node:os";
import path from "node:path";

const APP_NAME = "omniroute-lite";

/**
 * Upstream OmniRoute app name. The Lite fork must never adopt upstream's
 * `~/.omniroute` as its runtime data dir. Kept only so migration helpers can
 * locate the upstream directory as a read-only source; never used as a default.
 */
const LEGACY_UPSTREAM_APP_NAME = "omniroute";

function normalizeConfiguredPath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function safeHomeDir() {
  try {
    return os.homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  }
}

export function getLegacyDotDataDir(homeDir = safeHomeDir()) {
  // Pinned to the upstream app name on purpose: this is the migration *source*
  // (the old `~/.omniroute`), never the Lite default. See LEGACY_UPSTREAM_APP_NAME.
  return path.join(homeDir, `.${LEGACY_UPSTREAM_APP_NAME}`);
}

export function getDefaultDataDir() {
  const homeDir = safeHomeDir();

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, APP_NAME);
  }

  const xdgConfigHome = normalizeConfiguredPath(process.env.XDG_CONFIG_HOME);
  if (xdgConfigHome) return path.join(xdgConfigHome, APP_NAME);

  // Lite default. Unlike upstream, an existing legacy directory is NEVER adopted
  // here — silently reusing `~/.omniroute` would make the CLI read/write the
  // operator's upstream OmniRoute database (and its token salt) with Lite traffic.
  return path.join(homeDir, `.${APP_NAME}`);
}

export function resolveDataDir() {
  const configured = normalizeConfiguredPath(process.env.DATA_DIR);
  if (configured) return configured;

  return getDefaultDataDir();
}

export function resolveStoragePath(dataDir = resolveDataDir()) {
  return path.join(dataDir, "storage.sqlite");
}
