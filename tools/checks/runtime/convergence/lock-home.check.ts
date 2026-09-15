// Preparing the directory the instance lock is created in.
//
// The bug this guards is one that reads correctly and does the opposite: `sudo -n sh -c
// 'chown "$(id -u):$(id -g)" <dir>'` evaluates the substitution in the shell sudo started —
// root's — so it hands the directory to 0:0 and the ordinary user still cannot create a
// lock. The preparation appeared to work, and left the exact state it exists to prevent.
//
// So the assertions are about the shape of what reaches the target, not about the outcome
// of a run: numeric ids, resolved before any escalation, passed as plain arguments.

import { ensureLockHome, sudoFor } from "#framework/runtime/datadir.ts";
import { lockHome } from "#framework/runtime/instance-lock.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

interface TargetSpec {
  /** Directories that already exist on the target. */
  existing?: string[];
  /** Paths an unprivileged mkdir cannot create. */
  unprivilegedMkdirFails?: boolean;
  /** Paths `test -w` reports as writable, by the time it is asked. */
  writableAfterChown?: boolean;
}

function recordingContext(spec: TargetSpec) {
  const calls: { command: string; args: string[] }[] = [];
  const existing = new Set(spec.existing ?? []);
  let chowned = false;

  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async exists(path: string): Promise<boolean> {
        return existing.has(path);
      },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push({ command, args });

        if (command === "id") return { code: 0, stdout: args[0] === "-u" ? "1000\n" : "1001\n", stderr: "" };
        if (command === "mkdir") {
          if (spec.unprivilegedMkdirFails === true) return { code: 1, stdout: "", stderr: "Permission denied" };
          existing.add(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "chown") {
          chowned = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "test" && args[0] === "-w") {
          const ok = spec.writableAfterChown === false ? false : chowned || spec.unprivilegedMkdirFails !== true;
          return { code: ok ? 0 : 1, stdout: "", stderr: "" };
        }
        // sudo availability probes from sudoFor.
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  return { ctx, calls };
}

async function run(ctx: Context): Promise<string> {
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try {
        await ensureLockHome(ctx);
      } catch (error) {
        message = (error as Error).message;
      }
    },
  );
  return message;
}

// --- the ownership handover ------------------------------------------------------------------

{
  // The parent needs root: an unprivileged mkdir fails, so the directory is created with
  // sudo and handed over — and the handover is what used to go to 0:0.
  const { ctx, calls } = recordingContext({ unprivilegedMkdirFails: true });
  await run(ctx);

  const chown = calls.find((call) => call.command === "chown" || (call.command === "sudo" && call.args.includes("chown")));
  check("the directory is handed over after being created", chown !== undefined, true);

  const argv = [chown?.command ?? "", ...(chown?.args ?? [])].join(" ");
  check("with numeric ids", argv.includes("1000:1001"), true);
  // The failure mode in one assertion: a substitution reaching the target is evaluated
  // wherever the target evaluates it, which under sudo is root's shell.
  check("and no command substitution left for the target to evaluate", argv.includes("$("), false);
  check("nor a shell wrapped around it", argv.includes("sh -c"), false);
}

{
  // Who asks decides the answer. `id` run under sudo — or expanded by a shell sudo started —
  // reports root, whenever it happens; run as the tooling's own user it reports the right
  // ids no matter what escalated before or after.
  const { ctx, calls } = recordingContext({ unprivilegedMkdirFails: true });
  await run(ctx);

  const idCalls = calls.filter((call) => call.command === "id" || (call.command === "sudo" && call.args.includes("id")));
  check("the ids are read at all", idCalls.length > 0, true);
  check("and never through sudo", idCalls.filter((call) => call.command === "sudo").length, 0);
}

// --- the ordinary case does no work at all -----------------------------------------------------

{
  const { ctx, calls } = recordingContext({ existing: [lockHome({ settings: { dataDir: "/srv/clawforge" } } as unknown as Context)] });
  await run(ctx);
  check("an existing, writable home is left alone", calls.some((call) => call.command === "chown"), false);
  check("and nothing is created", calls.some((call) => call.command === "mkdir"), false);
}

// --- a handover that did not take is reported ---------------------------------------------------

{
  // Assuming the chown worked leaves a directory the lock cannot be created in, and that
  // resurfaces later as a failed claim on some unrelated command.
  const { ctx } = recordingContext({ unprivilegedMkdirFails: true, writableAfterChown: false });
  const message = await run(ctx);
  check("a directory still not writable afterwards is a failure", message !== "", true);
  check("saying what it stops", message.includes("nothing that changes this deployment can run"), true);
  check("and how to prepare it by hand", message.includes("sudo install -d"), true);
}

// --- a probe the transport refuses to answer -----------------------------------------------------

{
  // exists() reports a path it was not allowed to look at by throwing, rather than calling it
  // absent. sudoFor()'s climb was written against the old lenient answer: it walked up until
  // something "existed" and asked `test -w` there. On a root-only data directory the very
  // first probe now throws, and letting that escape would stop every privileged command this
  // framework has — backup, restore, state, verify — on exactly the hosts sudo is there for.
  //
  // A directory we cannot even look into answers the question sudoFor asks.
  const calls: { command: string; args: string[] }[] = [];
  const ctx = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async exists(path: string): Promise<boolean> {
        throw new Error(`could not check whether ${path} exists: /srv/clawforge cannot be searched by the target user`);
      },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push({ command, args });
        if (command === "test" && args[0] === "-w") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  let prefix: unknown;
  try {
    prefix = await sudoFor(ctx, "/srv/clawforge/data");
  } catch (error) {
    prefix = `threw: ${(error as Error).message}`;
  }

  check("a directory that cannot be looked into is escalated to, not aborted on", prefix, ["sudo", "-n"]);
  check(
    "and writability is asked about that path, not about an ancestor",
    calls.find((call) => call.command === "test")?.args,
    ["-w", "/srv/clawforge/data"],
  );
}

process.stderr.write(failed === 0 ? "all lock home checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
