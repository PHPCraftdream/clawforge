// A crash-abandoned compose-<uuid> directory from a PAST call is swept before the next one —
// never a live or foreign one. In-memory stub only, no docker and no network.

import assert from "node:assert/strict";
import { DockerRuntime } from "#framework/runtime/docker/runtime-docker.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { locksDir, type Settings } from "#framework/core/env.ts";
import { machineName, ownProcessStartedAt } from "#framework/runtime/lock/process-identity.ts";
import type { PathBridge } from "#framework/core/paths.ts";

useDeployment("/fixture/deployment");
// --- a crash-abandoned compose-<uuid> directory from a PAST call is swept ------------------
//
// A crash mid `docker compose` call (crash 139, an OOM kill — anything that skips this
// process's own finally block) used to leave `<data>-locks/compose-<uuid>/compose.env` behind
// forever, carrying OPENCLAW_GATEWAY_TOKEN in plain text. #sweepStaleComposeEnvs removes only
// ones whose recorded owner (pid, machine) is provably gone: this machine, and a pid that does
// not exist. A live pid, an unreadable/missing owner (a sibling call still mid-write toward its
// own would look the same for an instant), or a different machine's own clawforge are each
// left alone — in-memory stub only, no docker and no network.
{
  const DATA_DIR = "/srv/compose-sweep/data";
  const LOCKS = locksDir(DATA_DIR);

  function sweepTransport() {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const removed: string[] = [];
    return {
      files,
      dirs,
      removed,
      transport: {
        description: "stub",
        exec: async (command: string, args: string[]) => {
          if (command === "mkdir") dirs.add(args[args.length - 1] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        },
        readFile: async (path: string) => {
          const value = files.get(path);
          if (value === undefined) throw new Error(`no such file: ${path}`);
          return value;
        },
        writeFile: async (path: string, content: string | Uint8Array) => {
          files.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
        },
        exists: async (path: string) => files.has(path) || dirs.has(path),
        mkdirp: async (path: string) => { dirs.add(path); },
        remove: async (path: string) => {
          removed.push(path);
          files.delete(path);
          dirs.delete(path);
          for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key);
        },
        listFiles: async (dir: string) => {
          const prefix = `${dir}/`;
          return [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
        },
      } as unknown as Transport,
    };
  }

  const sweepPaths = { toTarget: async (path: string) => path } as unknown as PathBridge;
  const sweepRuntime = (transport: Transport) =>
    new DockerRuntime(transport, { dataDir: DATA_DIR, env: {} } as Settings, sweepPaths, { service: "app" });

  {
    const { transport, files } = sweepTransport();
    files.set(`${LOCKS}/compose-deaddead/owner.json`, JSON.stringify({ pid: 99999999, machine: machineName(), startedAt: new Date(0).toISOString() }));
    files.set(`${LOCKS}/compose-deaddead/compose.env`, 'OPENCLAW_GATEWAY_TOKEN="leaked-token"\n');
    await sweepRuntime(transport).start();
    assert.equal(files.has(`${LOCKS}/compose-deaddead/compose.env`), false, "a dead-owner compose.env is swept");
    assert.equal(files.has(`${LOCKS}/compose-deaddead/owner.json`), false, "its owner record goes with it");
  }

  {
    const { transport, files } = sweepTransport();
    files.set(`${LOCKS}/compose-0badf00d/compose.env`, 'OPENCLAW_GATEWAY_TOKEN="leaked-token"\n');
    await sweepRuntime(transport).start();
    assert.equal(files.has(`${LOCKS}/compose-0badf00d/compose.env`), true, "a directory with no readable owner is never swept");
  }

  {
    const { transport, files } = sweepTransport();
    // This process's own real start time, not "now": localLiveness()'s reuse check compares
    // the recorded startedAt against the actual pid's start time queried live (ps/wmic) — a
    // fresh "now" here would look like a pid reused moments ago rather than this same process.
    files.set(`${LOCKS}/compose-a11e0000/owner.json`, JSON.stringify({ pid: process.pid, machine: machineName(), startedAt: ownProcessStartedAt() }));
    files.set(`${LOCKS}/compose-a11e0000/compose.env`, 'OPENCLAW_GATEWAY_TOKEN="leaked-token"\n');
    await sweepRuntime(transport).start();
    assert.equal(files.has(`${LOCKS}/compose-a11e0000/compose.env`), true, "a live owner's compose.env is never swept");
  }

  {
    const { transport, files } = sweepTransport();
    files.set(`${LOCKS}/compose-f0e1cafe/owner.json`, JSON.stringify({ pid: 99999999, machine: `${machineName()}-elsewhere`, startedAt: new Date(0).toISOString() }));
    files.set(`${LOCKS}/compose-f0e1cafe/compose.env`, 'OPENCLAW_GATEWAY_TOKEN="leaked-token"\n');
    await sweepRuntime(transport).start();
    assert.equal(files.has(`${LOCKS}/compose-f0e1cafe/compose.env`), true, "a foreign machine's directory is never swept from here");
  }

  {
    const { transport, dirs } = sweepTransport();
    await sweepRuntime(transport).start();
    assert.equal([...dirs].some((path) => path.startsWith(`${LOCKS}/compose-`)), false, "no compose-* directory survives an ordinary successful call");
  }

  process.stderr.write("all compose-env sweep checks passed\n");
}
