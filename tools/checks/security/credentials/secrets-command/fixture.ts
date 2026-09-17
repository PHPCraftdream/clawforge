// Shared fixture for the secrets-command check split (the *.check.ts files in this
// directory): the throwaway deployment every secrets-side file needs, selected with
// useDeployment() so no file inherits whatever the previously imported check file left
// active — tools/checks/run.ts runs them all in one process.
//
// Deliberately not shared: the `check`/`failed` pair (module state would leak between
// files in that one process; each file keeps its own trivial copy) and the stub
// transports (they differ per topic on purpose — each states only what its case needs).

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { useDeployment } from "#framework/runtime/deployment.ts";

/** A fresh deployment with config/ and secrets/, already selected for this file. */
export async function setupDeployment(prefix: string): Promise<string> {
  const deployDir = await mkdtemp(resolve(tmpdir(), `clawforge-secrets-${prefix}-check-`));
  await mkdir(resolve(deployDir, "config"), { recursive: true });
  await mkdir(resolve(deployDir, "secrets"), { recursive: true });
  useDeployment(deployDir);
  return deployDir;
}

export function teardownDeployment(deployDir: string): Promise<void> {
  return rm(deployDir, { recursive: true, force: true });
}
