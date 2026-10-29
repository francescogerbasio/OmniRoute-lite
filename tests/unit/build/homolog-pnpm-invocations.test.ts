// tests/unit/build/homolog-pnpm-invocations.test.ts
// Maintainer-suite contracts for the homologation runner:
//  - tools run through `pnpm exec` with separate argv and NO shell (npx could download an
//    undeclared package; a shell would interpret dynamic values such as the ephemeral API key),
//  - unsupported platforms fail closed before any network call or credential creation,
//  - every tool the runner drives is a declared dependency.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// @ts-expect-error — .mjs helper has no type declarations; runtime shape is known.
import {
  SUPPORTED_HOMOLOG_PLATFORMS,
  assertSupportedPlatform,
  runPnpmExec,
} from "../../../scripts/homolog/lib/pnpmExec.mjs";

const ROOT = path.join(import.meta.dirname, "../../..");
const RUNNER = path.join(ROOT, "scripts/homolog/run.mjs");

const source = fs.readFileSync(RUNNER, "utf8");
const helper = fs.readFileSync(path.join(ROOT, "scripts/homolog/lib/pnpmExec.mjs"), "utf8");

/** Comments legitimately discuss `shell: true`; only executable code is asserted. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sourceCode = stripComments(source);
const helperCode = stripComments(helper);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);

const TOOLS = ["httpyac", "promptfoo", "playwright", "junit-to-ctrf", "ctrf"];

// ---------------------------------------------------------------------------
// runner source contract
// ---------------------------------------------------------------------------

test("the homologation runner never spawns npx or npm", () => {
  assert.doesNotMatch(source, /["']npx(?:\.cmd)?["']/, "homolog must not spawn npx");
  assert.doesNotMatch(source, /["']npm(?:\.cmd)?["']/, "homolog must not spawn npm");
  assert.doesNotMatch(source, /\bnpm\s+(?:exec|install|run)\b/, "no npm execution forms");
});

test("every external tool runs through pnpm exec", () => {
  assert.match(
    source,
    /import \{ assertSupportedPlatform, runPnpmExec \} from "\.\/lib\/pnpmExec\.mjs"/
  );
  for (const tool of TOOLS) {
    const invocation = new RegExp(`runPnpmExec\\(\\s*"${tool.replace("-", "\\-")}"`);
    assert.match(source, invocation, `${tool} must be invoked via runPnpmExec`);
  }
});

test("the runner never enables a shell or a Windows shim", () => {
  assert.doesNotMatch(sourceCode, /shell\s*:/, "the runner must not pass a shell option");
  assert.doesNotMatch(sourceCode, /pnpm\.cmd/, "no pnpm.cmd shim path");
  assert.doesNotMatch(sourceCode, /spawnSync\(/, "spawning is centralized in the helper");
  assert.doesNotMatch(helperCode, /shell\s*:/, "the helper must never set a shell option");
  assert.doesNotMatch(helperCode, /pnpm\.cmd/, "the helper must never target the .cmd shim");
});

test("the platform guard runs before network access and ephemeral credentials", () => {
  const guardIndex = source.indexOf("assertSupportedPlatform();");
  assert.notEqual(guardIndex, -1, "run.mjs must call assertSupportedPlatform() at startup");
  assert.ok(
    guardIndex < source.indexOf("createEphemeralKey("),
    "platform guard must precede ephemeral key creation"
  );
  assert.ok(
    guardIndex < source.indexOf("await fetch("),
    "platform guard must precede network calls"
  );
  assert.ok(guardIndex < source.indexOf('fs.rmSync("homolog-report"'), "guard before run setup");
});

test("every tool the runner drives is a declared dependency", () => {
  for (const tool of TOOLS) {
    assert.ok(
      declared.has(tool),
      `${tool} must be declared in package.json (pnpm exec resolves it locally; no implicit download)`
    );
  }
});

// ---------------------------------------------------------------------------
// platform guard + shell-free execution
// ---------------------------------------------------------------------------

test("Linux and macOS are supported platforms", () => {
  for (const platform of SUPPORTED_HOMOLOG_PLATFORMS) {
    assert.doesNotThrow(() => assertSupportedPlatform(platform));
  }
  assert.deepEqual([...SUPPORTED_HOMOLOG_PLATFORMS].sort(), ["darwin", "linux"]);
});

test("Windows fails closed with an explicit, actionable error", () => {
  assert.throws(
    () => assertSupportedPlatform("win32"),
    (error: { code?: string; message?: string }) =>
      error?.code === "ERR_HOMOLOG_UNSUPPORTED_PLATFORM" &&
      /unsupported platform "win32"/.test(error.message ?? "") &&
      /Linux\/macOS-only/.test(error.message ?? "")
  );
});

test("an unsupported platform can never reach a shell subprocess", () => {
  const calls: unknown[] = [];
  assert.throws(
    () =>
      runPnpmExec(
        "httpyac",
        ["send", "tests/homolog/api/core.http"],
        { encoding: "utf8" },
        {
          platform: "win32",
          spawn: (...args: unknown[]) => {
            calls.push(args);
            return { status: 0 };
          },
        }
      ),
    /unsupported platform/
  );
  assert.equal(calls.length, 0, "spawn must not be called on an unsupported platform");
});

test("supported platforms spawn pnpm exec with separate argv and no shell", () => {
  const calls: { command: unknown; args: unknown; options: Record<string, unknown> }[] = [];
  const result = runPnpmExec(
    "httpyac",
    ["send", "tests/homolog/api/core.http", "--var", "apiKey=a&b|c;rm -rf /"],
    { encoding: "utf8" },
    {
      platform: "linux",
      spawn: (command: unknown, args: unknown, options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return { status: 0, marker: "ok" };
      },
    }
  );

  assert.deepEqual(calls.length, 1);
  assert.equal(calls[0].command, "pnpm");
  assert.deepEqual(calls[0].args, [
    "exec",
    "httpyac",
    "send",
    "tests/homolog/api/core.http",
    "--var",
    "apiKey=a&b|c;rm -rf /",
  ]);
  assert.equal(calls[0].options.shell, undefined, "no shell for supported platforms");
  assert.deepEqual(result, { status: 0, marker: "ok" });
});

test("exit status is preserved from the tool process", () => {
  const result = runPnpmExec(
    "promptfoo",
    ["eval"],
    {},
    { platform: "darwin", spawn: () => ({ status: 7, stdout: "", stderr: "" }) }
  );
  assert.equal(result.status, 7);
});
