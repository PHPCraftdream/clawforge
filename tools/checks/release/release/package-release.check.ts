// Release metadata must stay aligned with the files npm actually publishes.

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";

const packageRoot = resolve(monorepoRoot, "tools", "framework");
const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
  private?: boolean;
  license?: string;
  homepage?: string;
  bugs?: { url?: string };
  repository?: { type?: string; url?: string; directory?: string };
  bin?: Record<string, string>;
  main?: string;
  exports?: Record<string, string | { types?: string; default?: string }>;
  files?: string[];
  publishConfig?: { access?: string };
};

const requiredFiles = ["README.md", "LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "NOTICE", "THIRD_PARTY_NOTICES.md"];
for (const file of requiredFiles) await access(resolve(packageRoot, file));

if (manifest.private === true) throw new Error("the published package must not be private");
if (manifest.license !== "(MIT OR Apache-2.0)") throw new Error("the package must declare the dual SPDX license");
if (!manifest.homepage || !manifest.bugs?.url || manifest.repository?.type !== "git" || !manifest.repository.url) {
  throw new Error("the package must declare repository, homepage and issue metadata");
}
if (manifest.bin?.clawforge !== "dist/entry/bin.js") throw new Error("the package bin must be clawforge -> dist/entry/bin.js");
const exported = (name: string, types: string, runtime: string): boolean => {
  const entry = manifest.exports?.[name];
  return typeof entry === "object" && entry !== null && entry.types === types && entry.default === runtime;
};
if (!exported("./app", "./dist/core/app.d.ts", "./dist/core/app.js") ||
    !exported("./mounts", "./dist/runtime/mounts.d.ts", "./dist/runtime/mounts.js") ||
    !exported("./commands", "./dist/commands/interface/index.d.ts", "./dist/commands/interface/index.js")) {
  throw new Error("the package exports must follow the source layout");
}
// "main": "index.js" sat here naming a file the package does not ship and never did. Nothing
// broke, because "exports" takes precedence over it — but a manifest that points at a file
// that is not there is a claim nobody can act on, and the next tool to read it may not have
// exports to fall back to.
if (manifest.main !== undefined && !manifest.files?.some((entry) => manifest.main?.startsWith(entry))) {
  throw new Error(`the package declares "main": ${JSON.stringify(manifest.main)}, which is not among the files it publishes`);
}
if (manifest.publishConfig?.access !== "public") throw new Error("scoped publishing must declare public access");
if (!requiredFiles.every((file) => manifest.files?.includes(file))) throw new Error("the package files list omits release metadata");

const workflow = await readFile(resolve(monorepoRoot, ".github", "workflows", "publish.yml"), "utf8");
if (!workflow.includes("default: token") || !workflow.includes("secrets.NPM_TOKEN")) {
  throw new Error("the first release must publish through the CI token job");
}
if (!workflow.includes("CLAWFORGE_ENABLE_TRUSTED_PUBLISHER")) {
  throw new Error("the Trusted Publisher job must remain explicitly disabled");
}

process.stderr.write("package release metadata and legal files passed\n");
