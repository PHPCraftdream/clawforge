// What DockerRuntime.runningConnectionFacts() reads out of ONE whole-object `docker inspect`,
// and what it refuses to guess: the data dir only from the config bind mount whose Source ends
// in "/config", the port only from the published 18789/tcp, the project from Docker's own
// compose label, and the image from .Config.Image — never the top-level .Image, which is a
// resolved ID a .env never wrote.
//
// No docker and no network: the transport is a stub answering the compose ps lookup with a
// canned container id and the inspect with canned JSON.

import { DockerRuntime } from "#framework/runtime/runtime-docker.ts";
import { useDeployment, deploymentDir } from "#framework/runtime/deployment.ts";
import type { ExecResult, Transport } from "#framework/runtime/transport.ts";
import type { Settings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";

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

interface InspectAnswer {
  State?: { Running?: boolean };
  Mounts?: { Destination?: string; Source?: string }[];
  NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[]> | null };
  Config?: { Labels?: Record<string, string>; Image?: string };
  Image?: string;
}

/** An inspect answer carrying every fact. Fresh per case, so a case's overrides cannot
 *  leak into the next one. */
function goodInspect(): InspectAnswer {
  return {
    State: { Running: true },
    Mounts: [
      { Destination: "/home/node/.config/openclaw", Source: "/srv/data/auth-secrets" },
      { Destination: "/home/node/.openclaw", Source: "/srv/data/config" },
    ],
    NetworkSettings: { Ports: { "18789/tcp": [{ HostIp: "127.0.0.1", HostPort: "18790" }] } },
    Config: { Labels: { "com.docker.compose.project": "proj-a" }, Image: "ghcr.io/openclaw/openclaw:extended-stable" },
  };
}

/** Builds a DockerRuntime whose compose ps answers "container-one" and whose inspect answers
 *  with (`code`, `stdout`) — or, with `composePsStdout` emptied, never inspects at all. Every
 *  exec's argument vector is recorded, so the call shapes can be asserted on. */
function runtimeReturning(
  code: number,
  stdout: string,
  composePsStdout = "container-one\n",
): { runtime: DockerRuntime; execArgs: string[][]; writes: string[] } {
  const execArgs: string[][] = [];
  const writes: string[] = [];
  const inspect: ExecResult = { code, stdout, stderr: "" };
  const transport = {
    description: "stub",
    async exec(command: string, args: string[]): Promise<ExecResult> {
      execArgs.push(args);
      if (command === "mkdir") return { code: 0, stdout: "", stderr: "" };
      if (command === "docker" && args[0] === "compose") return { code: 0, stdout: composePsStdout, stderr: "" };
      if (command === "docker" && args[0] === "inspect") return inspect;
      throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
    },
    async mkdirp(): Promise<void> {},
    async writeFile(path: string): Promise<void> {
      writes.push(path);
    },
    async remove(): Promise<void> {},
  } as unknown as Transport;

  const runtime = new DockerRuntime(
    transport,
    { env: {}, image: "x", dataDir: "/srv/openclaw/data" } as Settings,
    { toTarget: async (path: string) => path } as PathBridge,
    { service: "gateway" },
  );
  return { runtime, execArgs, writes };
}

const inspects = (execArgs: string[][]): string[][] => execArgs.filter((args) => args[0] === "inspect");

const previous = (() => { try { return deploymentDir(); } catch { return undefined; } })();
useDeployment("/fixture/deployment");

try {
  {
    const { runtime, execArgs, writes } = runtimeReturning(0, JSON.stringify(goodInspect()));
    const facts = await runtime.runningConnectionFacts();
    check(
      "a complete inspect answer yields every connection fact",
      facts,
      { dataDir: "/srv/data", port: "18790", composeProject: "proj-a", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
    check("exactly one inspect call is made", inspects(execArgs).length, 1);
    check(
      "the inspect asks one container for one whole-object JSON document",
      inspects(execArgs)[0],
      ["inspect", "--format", "{{json .}}", "container-one"],
    );
    check("the inspect never names the configured image", inspects(execArgs)[0].join(" ").includes("x"), false);
    check("the lookup still runs through compose's own environment file", writes.length, 1);
  }

  {
    const body = goodInspect();
    body.Mounts = (body.Mounts ?? []).filter((mount) => mount.Destination !== "/home/node/.openclaw");
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "no /home/node/.openclaw mount leaves the data dir absent and the rest present",
      await runtime.runningConnectionFacts(),
      { port: "18790", composeProject: "proj-a", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
  }

  {
    const body = goodInspect();
    body.Mounts = [{ Destination: "/home/node/.openclaw", Source: "/srv/data" }];
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "a mount Source without the /config suffix is not guessed into a data dir",
      await runtime.runningConnectionFacts(),
      { port: "18790", composeProject: "proj-a", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
  }

  {
    const body = goodInspect();
    body.Mounts = [{ Destination: "/home/node/.openclaw", Source: "/config" }];
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "a Source of exactly /config would strip to nothing, so it stays absent",
      await runtime.runningConnectionFacts(),
      { port: "18790", composeProject: "proj-a", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
  }

  {
    const body = goodInspect();
    body.NetworkSettings = { Ports: { "9999/tcp": [{ HostIp: "0.0.0.0", HostPort: "1" }] } };
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "no published 18789/tcp leaves the port absent",
      await runtime.runningConnectionFacts(),
      { dataDir: "/srv/data", composeProject: "proj-a", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
  }

  {
    const body = goodInspect();
    body.NetworkSettings = { Ports: null };
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "a null Ports table leaves the port absent without throwing",
      await runtime.runningConnectionFacts(),
      { dataDir: "/srv/data", composeProject: "proj-a", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
  }

  {
    const body = goodInspect();
    body.NetworkSettings = { Ports: { "18789/tcp": [] } };
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "an empty 18789/tcp mapping leaves the port absent",
      await runtime.runningConnectionFacts(),
      { dataDir: "/srv/data", composeProject: "proj-a", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
  }

  {
    const body = goodInspect();
    body.NetworkSettings = { Ports: { "18789/tcp": [{ HostIp: "127.0.0.1" }] } };
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "a published port without a HostPort leaves the port absent",
      await runtime.runningConnectionFacts(),
      { dataDir: "/srv/data", composeProject: "proj-a", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
  }

  {
    const body = goodInspect();
    body.Config = { Labels: {}, Image: "ghcr.io/openclaw/openclaw:extended-stable" };
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "a container without Docker's compose label leaves the project absent",
      await runtime.runningConnectionFacts(),
      { dataDir: "/srv/data", port: "18790", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
  }

  {
    const body = goodInspect();
    body.Config = { Labels: { "com.docker.compose.project": "proj-a" } };
    body.Image = "sha256:resolved";
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "a missing .Config.Image is never filled from the top-level resolved ID",
      await runtime.runningConnectionFacts(),
      { dataDir: "/srv/data", port: "18790", composeProject: "proj-a" },
    );
  }

  {
    const { runtime, execArgs } = runtimeReturning(0, JSON.stringify(goodInspect()), "   \n");
    check("an empty compose ps answer means no facts", await runtime.runningConnectionFacts(), undefined);
    check("an empty compose ps answer means no inspect call at all", inspects(execArgs).length, 0);
  }

  {
    const { runtime } = runtimeReturning(1, "");
    check("a failed inspect yields no facts", await runtime.runningConnectionFacts(), undefined);
  }

  {
    const { runtime } = runtimeReturning(0, "not-json{");
    check("an unparseable inspect answer yields no facts", await runtime.runningConnectionFacts(), undefined);
  }

  {
    const body = goodInspect();
    body.State = { Running: false };
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check("a stopped container yields no facts", await runtime.runningConnectionFacts(), undefined);
  }

  {
    const body = goodInspect();
    body.State = undefined;
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check("a container with no State at all yields no facts", await runtime.runningConnectionFacts(), undefined);
  }

  {
    const body = goodInspect();
    body.Mounts = undefined;
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "no Mounts at all leaves only the port, label and image — without throwing",
      await runtime.runningConnectionFacts(),
      { port: "18790", composeProject: "proj-a", image: "ghcr.io/openclaw/openclaw:extended-stable" },
    );
  }

  {
    const body = goodInspect();
    body.Config = undefined;
    const { runtime } = runtimeReturning(0, JSON.stringify(body));
    check(
      "no Config at all leaves only the data dir and port — without throwing",
      await runtime.runningConnectionFacts(),
      { dataDir: "/srv/data", port: "18790" },
    );
  }
} finally {
  if (previous !== undefined) useDeployment(previous);
}

process.stderr.write(failed === 0 ? "all running connection facts checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
