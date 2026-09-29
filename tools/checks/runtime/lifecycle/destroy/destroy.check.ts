// `./clawforge destroy` — dry run by default; a real run needs --yes AND --confirm-name,
// refuses an unsafe target shape or a symlinked target, and removes containers/network/
// volumes plus whichever of --data/--backups/--snapshots was asked for, in that order,
// under the REAL instance lock (guarded()/takeLock()) — the same shared fixture
// backup/prune-replaced.check.ts layers its own domain exec handling over, not a stand-in
// for the lock.

import { destroy } from "#framework/commands/lifecycle/lifecycle.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { takeLock } from "#framework/runtime/lock/instance-lock.ts";
import { stubContext, refused } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecOptions, ExecResult } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";

useDeployment("/srv/destroy-check-deployment");
const DEPLOYMENT_NAME = "destroy-check-deployment";

const DATA_DIR = "/srv/destroy-check/data";
const BACKUP_DIR = "/srv/destroy-check/backups";
const SNAPSHOT_DIR = "/srv/destroy-check/snapshots";

/** Layers what destroy's own guards/removal need (exists, `id`/`test -w` for sudoFor, `du`,
 *  `test -L`/`readlink`, and a runtime with stop/showStatus) over the real lock fixture, the
 *  same way prune-replaced.check.ts layers `find`/`du`/`test -L` over it. `order` records
 *  runtime.stop and each `rm` target as they happen, so the real sequence is what gets
 *  asserted rather than the end state alone. */
function destroyContext(
  present: string[] = [DATA_DIR, BACKUP_DIR, SNAPSHOT_DIR],
  symlinks: Set<string> = new Set(),
): { ctx: Context; dirs: Set<string>; order: string[] } {
  const { ctx: fixtureCtx, dirs } = stubContext();
  for (const dir of present) dirs.add(dir);
  const baseExec = fixtureCtx.transport.exec;
  const order: string[] = [];
  const transport: Context["transport"] = {
    ...fixtureCtx.transport,
    async exists(path: string): Promise<boolean> { return dirs.has(path); },
    async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
      if (command === "id") return { code: 0, stdout: "1000\n", stderr: "" }; // matches OWNER — no escalation needed
      if (command === "test" && args[0] === "-w") return { code: 0, stdout: "", stderr: "" };
      if (command === "test" && args[0] === "-L") return { code: symlinks.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
      if (command === "readlink") return { code: 0, stdout: "/elsewhere\n", stderr: "" };
      if (command === "du") return { code: 0, stdout: `4\t${args[args.length - 1]}`, stderr: "" };
      // Only destroy's own three targets — the lock's own release also does an `rm` for its
      // bookkeeping marker, which is not what this order is about.
      if (command === "rm" && [DATA_DIR, BACKUP_DIR, SNAPSHOT_DIR].includes(args[args.length - 1] ?? "")) {
        order.push(`rm:${args[args.length - 1]}`);
      }
      return baseExec(command, args, options);
    },
  };
  const runtime = {
    async isRunning(): Promise<boolean> { return true; },
    async stop(extraArgs: string[] = []): Promise<void> { order.push(`stop:${extraArgs.join(",")}`); },
    async showStatus(): Promise<void> { order.push("showStatus"); },
  };
  const ctx = {
    ...fixtureCtx,
    settings: { dataDir: DATA_DIR, backupDir: BACKUP_DIR, snapshotDir: SNAPSHOT_DIR, env: {} },
    transport,
    runtime,
  } as unknown as Context;
  return { ctx, dirs, order };
}

async function output(body: () => Promise<void>): Promise<string> {
  let captured = "";
  await withOutputSink((chunk) => { captured += chunk; }, body);
  return captured;
}

// --- dry run (default): prints the plan, removes nothing -----------------------------------

{
  const { ctx, dirs, order } = destroyContext();
  const text = await output(() => destroy(ctx, ["--data", "--backups", "--snapshots"]));
  check("dry run leaves every target in place", [dirs.has(DATA_DIR), dirs.has(BACKUP_DIR), dirs.has(SNAPSHOT_DIR)], [true, true, true]);
  check("dry run never calls runtime.stop", order.some((entry) => entry.startsWith("stop:")), false);
  check("dry run still shows the containers plan", order.includes("showStatus"), true);
  check("dry run says so and names --yes/--confirm-name", text.includes("dry run") && text.includes("--confirm-name"), true);
  check("dry run names each target path", [DATA_DIR, BACKUP_DIR, SNAPSHOT_DIR].every((path) => text.includes(path)), true);
}

{
  // No flags at all: still a dry run of the containers/network/volumes, nothing else.
  const { ctx, order } = destroyContext();
  await output(() => destroy(ctx, []));
  check("no target flags still shows the containers-only plan", order, ["showStatus"]);
}

// --- --confirm-name: missing or wrong refuses a real run ------------------------------------

{
  const { ctx, dirs } = destroyContext();
  const message = await refused(() => destroy(ctx, ["--data", "--yes"]));
  check("--yes with no --confirm-name is refused", message.includes("--confirm-name"), true);
  check("nothing was removed", dirs.has(DATA_DIR), true);
}

{
  const { ctx, dirs } = destroyContext();
  const message = await refused(() => destroy(ctx, ["--data", "--yes", "--confirm-name", "not-this-deployment"]));
  check("a wrong --confirm-name is refused", message.includes("does not match"), true);
  check("nothing was removed", dirs.has(DATA_DIR), true);
}

// --- path-shape guards: string-level, before anything reaches the transport -----------------

function shapeContext(dataDir: string): Context {
  return { settings: { dataDir, backupDir: BACKUP_DIR, snapshotDir: SNAPSHOT_DIR, env: {} } } as unknown as Context;
}

for (const [name, dataDir, expectedSubstring] of [
  ["/ itself", "/", "top-level directory"],
  ["a single-segment path", "/srv", "top-level directory"],
  ["a home-directory-shaped path", "/home/alice", "home directory"],
  ["a relative path", "srv/data", "not an absolute path"],
] as const) {
  const message = await refused(() => destroy(shapeContext(dataDir), ["--data"]));
  check(`refuses ${name}`, message.includes(expectedSubstring), true);
}

// --- symlink guard: checked in dry run too, so the plan never promises what a real run
// --- would then refuse -----------------------------------------------------------------------

{
  const { ctx } = destroyContext([DATA_DIR], new Set([DATA_DIR]));
  const message = await refused(() => destroy(ctx, ["--data"]));
  check("refuses a symlinked target, even in dry run", message.includes("symlink"), true);
}

// --- real run: removes exactly the flagged parts, in order, under the real lock -------------

{
  const { ctx, dirs, order } = destroyContext();
  await output(() => destroy(ctx, ["--data", "--backups", "--snapshots", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check(
    "stops containers first, then removes data, backups, snapshots in that order",
    order,
    ["stop:-v", `rm:${DATA_DIR}`, `rm:${BACKUP_DIR}`, `rm:${SNAPSHOT_DIR}`],
  );
  check("every flagged target is gone", [dirs.has(DATA_DIR), dirs.has(BACKUP_DIR), dirs.has(SNAPSHOT_DIR)], [false, false, false]);
}

{
  // Only --data: backups/snapshots are never touched.
  const { ctx, dirs, order } = destroyContext();
  await output(() => destroy(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
  check("only the requested target is removed", order, ["stop:-v", `rm:${DATA_DIR}`]);
  check("the others are left alone", [dirs.has(BACKUP_DIR), dirs.has(SNAPSHOT_DIR)], [true, true]);
}

// --- takes the instance lock: refused while another operation already holds it --------------

{
  const { ctx, dirs } = destroyContext();
  const held = await takeLock(ctx, "unrelated", "op-holder");
  try {
    const message = await refused(() => destroy(ctx, ["--data", "--yes", "--confirm-name", DEPLOYMENT_NAME]));
    check("a real run refuses while another operation holds the lock", message.includes("operations op-holder"), true);
  } finally {
    await held.release();
  }
  check("nothing was removed while refused", dirs.has(DATA_DIR), true);
}

finish("destroy");
