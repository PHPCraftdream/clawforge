import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { extractArtifactDeclarations } from "#framework/commands/management/recipe/recovery/checks/lint/artifacts.ts";
import { lintDockerfile } from "#framework/commands/management/recipe/recovery/checks/lint/rules.ts";
import { preparePin } from "#framework/commands/management/recipe/run/pin/plan.ts";

const zeros = "0".repeat(64);
const source = [
  "ARG VERSION=1.0",
  `ARG SHA256=${zeros}`,
  "FROM alpine",
  "FROM alpine AS base",
  "ARG VERSION=2.0",
  `ARG SHA256=${zeros}`,
  "FROM base",
  "ARG VERSION",
  "ARG SHA256",
  "ADD --checksum=sha256:${SHA256} https://github.com/acme/releases/download/v${VERSION}/tool-${VERSION}.tgz /tool",
].join("\n");
const root = await mkdtemp(join(tmpdir(), "recipe-pin-stage-args-"));
try {
  const declarations = extractArtifactDeclarations(source);
  check("one pinned declaration extracted", declarations.length, 1);
  const d = declarations[0];
  check("effective version is the stage default", d?.version, "2.0");
  check("effective checksum is the stage default", d?.checksum, zeros);
  check("version ARG line points at the stage declaration", d?.versionArgLine, 5);
  check("checksum ARG line points at the stage declaration", d?.checksumArgLine, 6);
  const dir = join(root, "recipe");
  await mkdir(dir);
  await writeFile(join(dir, "Dockerfile"), source);
  const plan = await preparePin(dir, "3.0");
  check("pin plan targets the stage version line", plan.versionLine, 5);
  check("pin plan targets the stage checksum line", plan.checksumLine, 6);
  check("pin plan reports the inherited stage version", plan.oldVersion, "2.0");
  const findings = lintDockerfile(source, "Dockerfile").filter((f) => f.code === "remote-add-unpinned");
  checkTrue("lint sees the ADD as pinned", findings.length === 0);
} finally {
  await rm(root, { recursive: true, force: true });
}
finish("recipe pin stage args");
