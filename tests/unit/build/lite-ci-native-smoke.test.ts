// tests/unit/build/lite-ci-native-smoke.test.ts
// Pre-script native/tooling smoke for Lite CI (issue #13 / #23).
//
// Lite CI installs with `pnpm install --frozen-lockfile --ignore-scripts` so that no dependency
// lifecycle script can run before the lockfile supply-chain gate has approved the graph. That
// only stays safe if the modules this job actually needs are usable WITHOUT their build scripts.
// This test proves that, and it is deliberately stricter than `require(...)`:
//
//   - better-sqlite3 ships `gypfile: false` + `prebuilds/**` and has no install script, so a
//     direct load + SQL round-trip must work.
//   - `driverFactory.tryOpenSync()` silently falls back better-sqlite3 -> node:sqlite -> sql.js
//     (src/lib/db/adapters/driverFactory.ts:248-279). Asserting only that `require()` succeeds
//     would let a broken native module pass while every suite runs on `node:sqlite`, so the
//     selected adapter driver is asserted explicitly.
//   - esbuild's binary comes from the optional `@esbuild/<platform>` package; its `postinstall`
//     is only validation/fallback. tsx depends on esbuild, so a transform must work.
//   - sharp has no install script (binaries ship as `@img/sharp-*` optional deps).
//
// Gated on OMNIROUTE_LITE_CI_NATIVE_SMOKE=1: a developer machine without optional native deps
// installed should not fail the repo-wide unit suite, while Lite CI must always run it.
import { createRequire } from "node:module";

import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const enabled = process.env.OMNIROUTE_LITE_CI_NATIVE_SMOKE === "1";
const skip = enabled ? false : "set OMNIROUTE_LITE_CI_NATIVE_SMOKE=1 (Lite CI only)";

test("better-sqlite3 loads from its prebuilt binary and executes SQL", { skip }, () => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    db.prepare("INSERT INTO smoke (label) VALUES (?)").run("ok");
    const row = db.prepare("SELECT label FROM smoke").get();
    assert.equal(row.label, "ok");
    assert.ok(db.prepare("SELECT sqlite_version() AS v").get().v, "sqlite_version() must respond");
  } finally {
    db.close();
  }
});

test(
  "the app DB factory selects better-sqlite3, not the node:sqlite/sql.js fallback",
  { skip },
  async () => {
    const { tryOpenSync } = await import("../../../src/lib/db/adapters/driverFactory.ts");
    const adapter = tryOpenSync(":memory:");
    assert.ok(adapter, "tryOpenSync must open an in-memory database");
    try {
      assert.equal(
        adapter.driver,
        "better-sqlite3",
        "the native driver must be selected; a fallback would silently mask a broken prebuild"
      );
    } finally {
      adapter.close();
    }
  }
);

test("esbuild resolves its platform binary without the postinstall script", { skip }, () => {
  const esbuild = require("esbuild");
  const result = esbuild.transformSync("const answer: number = 42; export default answer;", {
    loader: "ts",
    format: "esm",
  });
  assert.match(result.code, /answer/);
  assert.ok(esbuild.version, "esbuild must report a version");
});

test("sharp decodes an image without an install script", { skip }, async () => {
  const sharp = require("sharp");
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  assert.ok(png.length > 0, "sharp must produce a PNG buffer");
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 2);
  assert.equal(meta.height, 2);
});
