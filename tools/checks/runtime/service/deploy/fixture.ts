// Shared stub transport for deploy's check files, split out when round 6's P1-06/P1-07
// additions pushed deploy.check.ts past the source layout's 700-line limit
// (tools/checks/foundation/layout.check.ts). tools/checks/runtime/service/ is already at
// its 7-entries cap, so the split becomes a sibling directory rather than a sibling file —
// same move round 4 made for instance-lock.check.ts. Each check file that imports this runs
// as its own process (check files run for their side effects), so importing `ctx` here
// does not share mutable state between files — only the setup code.

import { resolve } from "node:path";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

useDeployment(resolve(monorepoRoot, "apps", "example app"));

export const ctx = {
  settings: { gatewayPort: "18789" },
  transport: {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      if (isRootProbe(args)) return probeReply(args);
      return { code: 0, stdout: "", stderr: "" };
    },
  },
  paths: {
    async toTarget(path: string): Promise<string> {
      return path.replaceAll("\\", "/");
    },
  },
  runtime: { requiredTools: ["docker"] },
} as unknown as Context;

/** Round 6 (P1-06) gave deploy() a remote-root question it asks through runRemote before
 *  its first --delete: does the path exist, is it canonical (no symlinked component), does
 *  it carry this deployment's marker, is it empty. Every stub transport here answers it
 *  the way a cooperating server would. The canonical answer echoes the path the deploy
 *  script asked about — extracted from `p='...'` — so the happy paths (marker absent, empty)
 *  proceed exactly as before, plus a marker-write ssh call. The script reaches this stub
 *  already single-quoted by runRemote, which turns every inner quote into the four
 *  characters `'\''`, so the pattern has to see through that to read the asked path. */
export function probeReply(args: string[], over: { marker?: string; empty?: "yes" | "no"; state?: string; canonical?: string } = {}): ExecResult {
  const script = args.at(-1) ?? "";
  const asked = /p=(?:'\\''|')([^']*)/.exec(script)?.[1] ?? "/opt/openclaw";
  const lines = [`canonical=${over.canonical ?? asked}`];
  if (over.state !== undefined) lines.push(`state=${over.state}`);
  lines.push(`marker=${over.marker ?? "absent"}`);
  lines.push(`empty=${over.empty ?? "yes"}`);
  return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

export const isRootProbe = (args: string[]) => (args.at(-1) ?? "").includes("clawforge-root-probe");
export const markerLine = (name: string) => `clawforge-deploy-root-v1 name=${name}`;
