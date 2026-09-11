// Checks the deployment directory layout and the name guard that protects it.
//
// No instance and no target: deployment.ts is module-level state set by useDeployment(),
// and names.ts is a pure function. The "never called" case is run in a fresh child
// process rather than in-process: tools/checks/run.ts imports every *.check.ts into one
// process, and deploy.check.ts (which sorts before this file) has already called
// useDeployment() by the time this file loads, so activeDir would already be set here.

import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deploymentDir,
  deploymentName,
  desiredStateFile,
  envFile,
  recipesDir,
  secretsDir,
  secretsTemplateFile,
  secretStoreFile,
  useDeployment,
} from "../framework/deployment.ts";
import { safeName } from "../framework/names.ts";
import { monorepoRoot } from "../framework/env.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function checkThrows(name: string, fn: () => unknown, messageIncludes: string[]): void {
  try {
    fn();
    failed += 1;
    process.stderr.write(`  FAIL ${name}\n    expected a throw, but it returned normally\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = messageIncludes.filter((needle) => !message.includes(needle));
    check(name, missing, []);
  }
}

// --- deploymentDir() before useDeployment() has ever been called -------------
// Run in a fresh process so this is a real assertion regardless of what already ran
// earlier in this suite.

async function checkNeverSelectedThrows(): Promise<void> {
  const deploymentUrl = pathToFileURL(resolve(monorepoRoot, "tools", "framework", "deployment.ts")).href;
  const script = [
    `import { deploymentDir } from ${JSON.stringify(deploymentUrl)};`,
    "try {",
    "  deploymentDir();",
    '  process.stdout.write("NO_THROW");',
    "} catch (error) {",
    '  process.stdout.write(`THROW:${error instanceof Error ? error.message : String(error)}`);',
    "}",
  ].join("\n");

  const scriptFile = resolve(monorepoRoot, `.deployment-dir-guard-check-${randomBytes(4).toString("hex")}.ts`);
  await writeFile(scriptFile, script, "utf8");
  try {
    const { stdout } = await new Promise<{ code: number | null; stdout: string }>((resolvePromise) => {
      const proc = spawn(process.execPath, ["--experimental-strip-types", scriptFile], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      proc.on("close", (code) => resolvePromise({ code, stdout: out }));
    });
    check(
      "deploymentDir() before useDeployment() throws, in a process where it was never called",
      stdout,
      "THROW:no deployment selected — the entry point must call useDeployment()",
    );
  } finally {
    await rm(scriptFile, { force: true });
  }
}

await checkNeverSelectedThrows();

// --- deployment.ts, once a deployment is selected -----------------------------

const dir = resolve("apps", "example app");
useDeployment(dir);

check("deploymentDir() returns what useDeployment() set", deploymentDir(), dir);
check("deploymentName() is the directory's basename", deploymentName(), "example app");
check("envFile() resolves under the deployment", envFile(), resolve(dir, ".env"));
check(
  "desiredStateFile() resolves under config/",
  desiredStateFile(),
  resolve(dir, "config", "desired-state.json"),
);
check(
  "secretsTemplateFile() resolves under config/",
  secretsTemplateFile(),
  resolve(dir, "config", "secrets.template.env"),
);
check("recipesDir() resolves under the deployment", recipesDir(), resolve(dir, "recipes"));
check("secretsDir() resolves under the deployment", secretsDir(), resolve(dir, "secrets"));

check(
  "secretStoreFile() resolves a valid name under secrets/",
  secretStoreFile("local"),
  resolve(dir, "secrets", "local.env"),
);

checkThrows("secretStoreFile() rejects a traversal attempt", () => secretStoreFile("../../etc"), [
  "store",
  "../../etc",
]);
checkThrows("secretStoreFile() rejects an uppercase name", () => secretStoreFile("Foo"), [
  "store",
  "Foo",
]);
checkThrows("secretStoreFile() rejects a name with a space", () => secretStoreFile("a b"), [
  "store",
  "a b",
]);

// A traversal name must not actually land outside secrets/, even though the guard should
// have already thrown before resolve() ever ran.
check(
  "secrets/ stays a real prefix of the deployment directory",
  secretsDir().startsWith(dir + sep),
  true,
);

// --- names.ts: safeName() directly --------------------------------------------

check("safeName() accepts a plain name", safeName("app", "openclaw"), "openclaw");
check("safeName() accepts dashes and digits", safeName("app", "my-app-2"), "my-app-2");
check("safeName() accepts a single letter", safeName("app", "a"), "a");

checkThrows("safeName() rejects an empty string", () => safeName("app", ""), ["app"]);
checkThrows("safeName() rejects uppercase letters", () => safeName("app", "UPPER"), [
  "app",
  "UPPER",
]);
checkThrows("safeName() rejects a leading digit", () => safeName("app", "1start"), [
  "app",
  "1start",
]);
checkThrows("safeName() rejects a space", () => safeName("app", "has space"), [
  "app",
  "has space",
]);
checkThrows("safeName() rejects a traversal attempt", () => safeName("app", "../escape"), [
  "app",
  "../escape",
]);
checkThrows("safeName() rejects an embedded slash", () => safeName("app", "a/b"), ["app", "a/b"]);
checkThrows(
  "safeName() rejects a name over 64 characters",
  () => safeName("app", "a".repeat(65)),
  ["app"],
);

process.stderr.write(failed === 0 ? "all deployment-names checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
