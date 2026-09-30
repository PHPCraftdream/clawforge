// What `clawforge init` tells the user (round 26, R26-06 / R26-16): an accurate list of what to
// commit, a .env header true in both modes, absolute documentation URLs, and the opt-in
// `--local` remedy for editor types. Runs initApp in a scratch directory.

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initApp, INIT_ARGUMENTS } from "#framework/integration/deployment/init.ts";
import { docsUrl } from "#framework/core/io/docs-url.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

async function initIn(options?: { local?: boolean }): Promise<{ output: string; env: string; directory: string; parent: string }> {
  // The directory's own name is the deployment name, so it cannot be the random temp name.
  const parent = await mkdtemp(join(tmpdir(), "clawforge-init-messages-"));
  const directory = join(parent, "deployment");
  await mkdir(directory);
  let output = "";
  await withOutputSink((chunk) => {
    output += chunk;
  }, () => initApp(directory, options));
  return { output, env: await readFile(resolve(directory, ".env"), "utf8"), directory, parent };
}

const plain = await initIn();
const local = await initIn({ local: true });
try {
  checkTrue("the commit advice names mcp-launch.mjs", plain.output.includes("mcp-launch.mjs"));
  checkTrue("...and app.ts, package.json, config/ and recipes/", ["app.ts", "package.json", "config/", "recipes/"].every((name) => plain.output.includes(name)));
  checkTrue("the false 'only framework-adjacent file' claim is gone", !plain.output.includes("only framework-adjacent"));

  checkTrue("the .env header does not claim new-app alone copies it", !plain.env.includes("`./clawforge new-app <name>` copies this"));
  checkTrue("...and names both new-app and init", /new-app` and `init`/.test(plain.env));

  checkTrue("without --local, init hints at it", plain.output.includes("clawforge init --local"));
  checkTrue("--local prints an npm install that saves no machine path", local.output.includes("npm install --no-save "));
  checkTrue("--local does not hint at itself", !local.output.includes("clawforge init --local"));
  const localPackage = JSON.parse(await readFile(resolve(local.directory, "package.json"), "utf8")) as { devDependencies?: unknown };
  check("--local writes no machine path into package.json", localPackage.devDependencies, undefined);
  check("init declares --local through the argument machinery", INIT_ARGUMENTS.map((argument) => argument.name), ["local"]);

  const homepage = (JSON.parse(await readFile(resolve(monorepoRoot, "tools", "framework", "package.json"), "utf8")) as { homepage: string }).homepage;
  check("docsUrl points at the package's own repository, default branch", docsUrl("x.md"), `${homepage.replace(/#readme$/, "")}/blob/main/docs/x.md`);
} finally {
  await rm(plain.parent, { recursive: true, force: true });
  await rm(local.parent, { recursive: true, force: true });
}

finish("init-messages");
