#!/usr/bin/env node
// Reproduces ci.yml's ubuntu "checks" job inside the official node:24 image (Docker), so
// Linux-only regressions surface before a push. The snapshot is `git ls-files -co
// --exclude-standard`; the host's node_modules/ and dist/ never enter the container.
//
//   npm run check:linux             the full ubuntu job
//   npm run check:linux -- backup   only checks whose path contains "backup"
//
// Not reproduced: no docker binary or host socket inside the container (a much larger trust
// boundary), so checks probing for a live Docker daemon skip those assertions, as on a bare runner.

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, copyFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { buildCopyArgv, buildCreateArgv, buildRemoveArgv, buildStartArgv, filterCleanFileList } from "./check-linux-argv.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const filters = process.argv.slice(2);

function refuse(message: string): never {
  process.stderr.write(`check:linux: ${message}\n`);
  process.exit(1);
}

/** CLI present, then the daemon actually answers — two different ways to have no usable
 *  Docker, and each gets its own next step rather than one generic failure. */
function verifyDockerAvailable(): void {
  const version = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (version.error !== undefined) {
    refuse(
      "docker is not installed or not on PATH. Install Docker Desktop (Windows/macOS) or " +
        "Docker Engine (Linux), then re-run `npm run check:linux`.",
    );
  }
  const info = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
  if (info.status !== 0) {
    refuse(
      "docker is installed but the daemon is not answering. Start Docker Desktop (or, on " +
        "Linux, `sudo systemctl start docker`), then re-run `npm run check:linux`.",
    );
  }
}

async function listCleanFiles(): Promise<string[]> {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed (exit ${String(result.status)}): ${result.stderr}`);
  }
  return filterCleanFileList(result.stdout.split("\n"));
}

/** Copies exactly the clean file list into a fresh temp directory — never the whole tree —
 *  so nothing outside git's own view of the working tree (host node_modules/, dist/, .env,
 *  stray build output) can reach the container. A file git lists but the working tree lacks
 *  (staged-then-deleted) is skipped rather than failing the whole snapshot. */
async function snapshotCleanTree(files: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clawforge-check-linux-"));
  for (const relPath of files) {
    const dest = join(dir, relPath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(repoRoot, relPath), dest).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return dir;
}

function runDocker(args: readonly string[], label: string): void {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error !== undefined) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited with code ${String(result.status)}`);
}

/** Streams the container's own stdout/stderr live and resolves with its exit code — `docker
 *  start -a` reflects the container's exit status as its own, same as `docker run` does. */
function streamDockerStart(containerName: string): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", buildStartArgv(containerName), { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

async function main(): Promise<number> {
  verifyDockerAvailable();

  const files = await listCleanFiles();
  const containerName = `clawforge-check-linux-${randomBytes(4).toString("hex")}`;
  const tempDir = await snapshotCleanTree(files);
  process.stderr.write(`check:linux: snapshotted ${String(files.length)} file(s) into a clean copy\n`);

  let created = false;
  try {
    runDocker(buildCreateArgv(containerName, filters), "docker create");
    created = true;
    runDocker(buildCopyArgv(tempDir, containerName), "docker cp");
    return await streamDockerStart(containerName);
  } finally {
    if (created) spawnSync("docker", buildRemoveArgv(containerName), { stdio: "ignore" });
    await rm(tempDir, { recursive: true, force: true });
  }
}

const exitCode = await main();
process.exit(exitCode);
