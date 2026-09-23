// Checks that a direct restore never starts the gateway on a config it cannot satisfy.
//
// push() already had this guard — restoreArchive() itself did not, so `./clawforge restore` alone
// (the common path, without going through push) could start straight into a
// SecretRefResolutionError crash-loop. No target: a stub transport drives restoreArchive()
// end to end with a restored config that references a variable nothing supplies.

import { resolve } from "node:path";
import { access, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { restoreArchive, newestArchive } from "#framework/commands/lifecycle/restore.ts";
import { useDeployment, deploymentName } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { UserError } from "#framework/core/log.ts";
import type { Context } from "#framework/core/context.ts";
import { LocalTransport, type ExecResult } from "#framework/runtime/transport.ts";
import { clearRecipesDir, projectName, useRecipesDir } from "#framework/service/recipe.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

async function rejectionOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try { await run(); } catch (error) { return (error as Error).message; }
  return undefined;
}

useDeployment(resolve(monorepoRoot, "apps", "example app"));

const CONFIG_PATH = "/srv/openclaw/data/config/openclaw.json";
const TARGET_ENV_PATH = "/srv/openclaw/data/config/.env";
const DATA_DIR = "/srv/openclaw/data";
const PARENT = "/srv/openclaw";
const ARCHIVE = "/srv/openclaw/backups/openclaw-x.tar.gz";

let startCalled = false;

function makeCtx(): Context {
  let running = true;
  return {
    settings: { dataDir: "/srv/openclaw/data", env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        if (path === CONFIG_PATH) return true;
        // Absent on purpose: the restored config references a variable nothing supplies.
        if (path === TARGET_ENV_PATH) return false;
        return true;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) {
          return JSON.stringify({ provider: { key: { source: "env", id: "REQUIRED_VAR" } } });
        }
        return "";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (command === "tar" && args.includes("-tzf")) {
          return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        }
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "", stderr: "" };
        if (command === "stat") return { code: 0, stdout: "1000:1000", stderr: "" };
        // The restored-layout probes ask about the tree this stub pretends is there: an
        // ordinary directory, resolvable, nothing a link reaches around.
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      async isRunning(): Promise<boolean> { return running; },
      async stop(): Promise<void> { running = false; },
      async start(): Promise<void> {
        running = true;
        startCalled = true;
      },
      async waitForHealth(): Promise<void> {},
    },
  } as unknown as Context;
}

let threw = false;
try {
  await withOutputSink(
    () => {},
    () => restoreArchive(makeCtx(), "/srv/openclaw/backups/openclaw-x.tar.gz", { force: true }),
  );
} catch {
  threw = true;
}

check("restoring a config missing its secrets does not throw", threw, false);
check("the gateway is never started when a required secret is missing", startCalled, false);

// A redirected parent must be rejected before restore stops the running gateway or moves data.
{
  const ctx = makeCtx();
  let stopCalled = false;
  let destructiveCalls = 0;
  (ctx.runtime as unknown as { stop: () => Promise<void> }).stop = async () => { stopCalled = true; };
  const transport = ctx.transport as unknown as { exec: (command: string, args: string[]) => Promise<ExecResult> };
  const originalExec = transport.exec.bind(ctx.transport);
  transport.exec = async (command: string, args: string[]) => {
    if (command === "readlink" && args[0] === "-f" && args[1] === DATA_DIR) {
      return { code: 0, stdout: "/redirected/data", stderr: "" };
    }
    if (command === "mv" || command === "mkdir" || command === "tar" && args.includes("-xzf")) destructiveCalls += 1;
    return originalExec(command, args);
  };
  let failure: unknown;
  await withOutputSink(() => {}, async () => {
    try { await restoreArchive(ctx, ARCHIVE, { force: true }); } catch (error) { failure = error; }
  });
  check("restore refuses redirected data ancestry", failure instanceof UserError, true);
  check("ancestry refusal happens before stopping gateway", stopCalled, false);
  check("ancestry refusal happens before move, mkdir, or extraction", destructiveCalls, 0);
}

// If extraction fails after the old tree is moved aside, restore both data and the original
// running gateway state before returning the error.
{
  const ctx = makeCtx();
  let running = true;
  let restarted = false;
  (ctx.runtime as unknown as { isRunning: () => Promise<boolean>; stop: () => Promise<void>; start: () => Promise<void> }).isRunning = async () => running;
  (ctx.runtime as unknown as { stop: () => Promise<void> }).stop = async () => { running = false; };
  (ctx.runtime as unknown as { start: () => Promise<void> }).start = async () => { restarted = true; running = true; };
  const transport = ctx.transport as unknown as { exec: (command: string, args: string[]) => Promise<ExecResult> };
  const originalExec = transport.exec.bind(ctx.transport);
  transport.exec = async (command: string, args: string[]) => {
    if (command === "tar" && args.includes("-xzf")) throw new Error("extract fixture failure");
    return originalExec(command, args);
  };
  const failure = await rejectionOf(() => withOutputSink(() => {}, () => restoreArchive(ctx, ARCHIVE, { force: true })));
  check("failed restore preserves its primary error", failure, "extract fixture failure");
  check("failed restore restarts a gateway that was running before it", restarted, true);
}

// A different failure entirely — the restored config itself does not parse — must not be
// read as "just missing secrets" and reported as a successful restore. preflightSecrets()
// throws a plain SyntaxError here (from requirements()'s own JSON.parse), which restore.ts
// used to catch indiscriminately alongside the genuine missing-secrets case.
{
  const ctx = makeCtx();
  (ctx.transport as { readFile: (path: string) => Promise<string> }).readFile = async (path: string) => {
    if (path === CONFIG_PATH) return "{ not valid json";
    return "";
  };

  let corruptThrew = false;
  await withOutputSink(
    () => {},
    async () => {
      try {
        await restoreArchive(ctx, "/srv/openclaw/backups/openclaw-x.tar.gz", { force: true });
      } catch {
        corruptThrew = true;
      }
    },
  );

  check("a corrupted restored config is not reported as a successful restore", corruptThrew, true);
}

// --- P2-04 (audit 2026-09-22 round 2): a restore names the recipe stacks it did not recreate.
//
// restoreArchive() stops the gateway's project and moves the data directory aside;
// recipe stacks are separate Compose projects, so their containers survive with mounts
// resolved against the OLD tree. The command cannot recreate another project's
// containers, so it says so instead: name each running stack, point at the moved-aside
// data, give the framework-native remediation. Nothing running — nothing said.

{
  const recipes = await mkdtemp(`${tmpdir()}/clawforge-restore-recipe-check-`);
  try {
    await mkdir(resolve(recipes, "vault"), { recursive: true });
    await writeFile(resolve(recipes, "vault", "recipe.json"), JSON.stringify({ description: "sidecar under the data directory" }), "utf8");
    const probed: string[] = [];
    const ctxWithStack = (running: boolean): Context => {
      const ctx = makeCtx();
      (ctx as unknown as { runtime: { stack: unknown } }).runtime.stack = (project: string) => {
        probed.push(project);
        return { async isRunning(): Promise<boolean> { return running; } };
      };
      return ctx;
    };

    let output = "";
    useRecipesDir(recipes);
    try {
      await withOutputSink((line) => { output += line; }, () =>
        restoreArchive(ctxWithStack(true), "/srv/openclaw/backups/openclaw-x.tar.gz", { force: true }),
      );
      check("a restore with a running recipe stack names it", output.includes("recipe stack(s) still running") && output.includes("vault"), true);
      check("the warning says the stack was not recreated", output.includes("not recreated"), true);
      check("the warning points at the moved-aside data", output.includes("kept at /srv/openclaw/data.replaced-"), true);
      check("the remediation names the framework commands", output.includes("./clawforge recipe remove vault") && output.includes("./clawforge recipe install vault"), true);
      // check() compares with ===: two array instances are never equal, so compare the
      // JSON forms — the project names themselves, not the containers holding them.
      check("the probe went to the recipe's own compose project", JSON.stringify(probed), JSON.stringify([projectName(deploymentName(), "vault")]));
    } finally {
      clearRecipesDir();
    }

    output = "";
    probed.length = 0;
    useRecipesDir(recipes);
    try {
      await withOutputSink((line) => { output += line; }, () =>
        restoreArchive(ctxWithStack(false), "/srv/openclaw/backups/openclaw-x.tar.gz", { force: true }),
      );
    } finally {
      clearRecipesDir();
    }
    check("a restore with no running recipe stack stays quiet", output.includes("recipe stack"), false);
  } finally {
    await rm(recipes, { recursive: true, force: true });
  }
}

// --- which archive `./clawforge restore` picks when given none ------------------------------
//
// `pull` writes migrate and share archives into the same directory `backup` writes full ones
// into, and the rule used to be "the newest file matching <deployment>-*.tar.gz". So the
// documented `./clawforge restore` run right after `pull --share` replaced the data directory
// with an archive carrying neither identity nor credentials: the gateway could not start, and
// the real data survived only as <data>.replaced-<stamp>.

function listingContext(paths: string[]): Context {
  return {
    settings: { backupDir: BACKUP_DIR },
    transport: {
      async exists(): Promise<boolean> {
        return true;
      },
      async exec(command: string, args: string[]): Promise<ExecResult> {
        if (args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        if (command === "sh" && args.some((arg) => arg.includes("ls -1t"))) {
          return { code: 0, stdout: `${paths.join("\n")}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

const BACKUP_DIR = "/srv/openclaw/backups";
const NAME = deploymentName();

{
  const full = `${BACKUP_DIR}/${NAME}-20260101-000000.tar.gz`;
  const picked = await newestArchive(
    listingContext([
      `${BACKUP_DIR}/${NAME}-20260103-000000-share.tar.gz`,
      `${BACKUP_DIR}/${NAME}-20260102-000000-migrate.tar.gz`,
      full,
    ]),
    BACKUP_DIR,
  );

  check("the newest FULL archive is chosen, not the newest file", picked.archive, full);
  check("and what was passed over is reported, not swallowed", picked.skipped.length, 2);
  check("by name and profile", picked.skipped[0].includes("share"), true);
}

{
  // A sibling deployment sharing the directory matches the glob but is not ours to restore.
  const picked = await newestArchive(listingContext([`${BACKUP_DIR}/${NAME}-staging-20260103-000000.tar.gz`]), BACKUP_DIR);
  check("a sibling deployment's archive is not a candidate", picked.archive, undefined);
  check("and is not reported as a skipped profile either", picked.skipped.length, 0);
}

{
  const picked = await newestArchive(listingContext([`${BACKUP_DIR}/${NAME}-20260103-000000-share.tar.gz`]), BACKUP_DIR);
  check("a directory holding only profile archives offers nothing to restore", picked.archive, undefined);
  check("and says which ones it passed over", picked.skipped.length, 1);
}

// The automatic restore selector uses the same target-side glob as backup rotation. Keep the
// literal path quoted through a real POSIX shell so spaces, quotes and shell metacharacters stay
// data and cannot change which archive is selected.
if (process.platform !== "win32") {
  const root = await mkdtemp(`${tmpdir()}/clawforge-restore-quote-check-`);
  const marker = `${root}/shell-injected`;
  const directory = `${root}/backup files '$(touch ${marker})' ; echo hacked`;
  try {
    await mkdir(directory, { recursive: true });
    const archive = `${directory}/${NAME}-20260103-000000.tar.gz`;
    await writeFile(archive, "archive");
    await utimes(archive, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    const picked = await newestArchive(
      { settings: { backupDir: directory }, transport: new LocalTransport() } as unknown as Context,
      directory,
    );
    let markerPresent = true;
    try { await access(marker); } catch { markerPresent = false; }
    check("restore selects an archive below a quoted path", picked.archive, archive);
    check("restore does not execute path metacharacters", markerPresent, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- P1-04 (audit 2026-09-22 round 3): the restored layout is verified with the
// privileges that act through it.
//
// extractArchive() unpacks through sudoFor() and keeps the archive's numeric ownership,
// while ensureDataDirs()/--fresh-identity act with whatever escalation they need — and the
// probes between them ran unprivileged, where `test` reports an untraversable directory
// exit 1, the same exit code it gives for a path that is not there. A mandatory layout
// path the check could not actually look at was therefore skipped as "absent" instead of
// refused, and the privileged writes that follow could travel it unseen. Scenario A is
// the unprivileged run whose parent cannot be searched: the restore must stop and the
// previous data goes back. Scenario B is the escalated run: the probes ask as root, the
// parent IS searchable, absence stays trustworthy, and the restore completes — with every
// privileged step recorded to prove it escalated. Scenario C is a probe that answers
// neither yes nor no: `test` itself failed, which is not an answer that can be read as
// "absent" either, and the parent searches fine — only the unanswerable probe stands
// between the restore and writes through a path its checks could not see.

interface RecordedExec {
  command: string;
  args: string[];
}

/** Every exec recorded, and answers like a target whose restored data tree the transport
 *  user cannot search: the subdirectories answer a clean 1 from both existence probes
 *  (what an EACCES-denied `test -e` reports, indistinguishable from "not there"), and the
 *  parent-searchability probe answers `searchParent ?? escalated` — root can search, the
 *  unprivileged run cannot. In the escalated run the parent and the data tree are not
 *  writable, so extraction, the verification probes and the later chmod all escalate,
 *  while the lock home beside the tree stays writable.
 *
 *  `overrides.searchParent` answers the parent-searchability probe for the unprivileged
 *  run too, and `overrides.unexpectedProbe` names the one mandatory subdirectory whose
 *  existence probes answer an unexpected exit code — `test` itself failing, which is
 *  neither "there" nor "absent" — so a restore that would trust such an answer as
 *  "absent" has something to be caught by. */
function deniedContext(
  escalated: boolean,
  overrides: { searchParent?: boolean; unexpectedProbe?: string } = {},
): { ctx: Context; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const searchParent = overrides.searchParent ?? escalated;
  const unexpectedProbe = overrides.unexpectedProbe;
  const mandatory = ["config", "workspace", "auth-secrets"].map((sub) => `${DATA_DIR}/${sub}`);
  const underData = (path: string): boolean => path === DATA_DIR || path.startsWith(`${DATA_DIR}/`);
  const writable = (path: string): boolean => !escalated || !(path === PARENT || underData(path));
  const ctx = {
    settings: { dataDir: DATA_DIR, env: {} },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        // Absent on purpose, as above: the restored config references a variable nothing
        // supplies, so a completed restore ends on the missing-secrets path.
        if (path === TARGET_ENV_PATH) return false;
        return true;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) {
          return JSON.stringify({ provider: { key: { source: "env", id: "REQUIRED_VAR" } } });
        }
        return "";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(rawCommand: string, rawArgs: string[]): Promise<ExecResult> {
        calls.push({ command: rawCommand, args: rawArgs });
        // Recorded exactly as made. Answered through the escalation prefix: the rules
        // below must see the same call whichever run made it.
        const command = rawCommand === "sudo" && rawArgs[0] === "-n" ? (rawArgs[1] ?? "") : rawCommand;
        const args = rawCommand === "sudo" && rawArgs[0] === "-n" ? rawArgs.slice(2) : rawArgs;
        // Defensively answered rather than trusted to the default: if sudoFor() ever
        // decided escalation was needed in the unprivileged run, these say it may not.
        if (command === "sh" && args.some((arg) => arg.includes("command -v sudo"))) {
          return { code: 0, stdout: "", stderr: "" };
        }
        // needsOwnerEscalation's own identity probe: unescalated matches the fixed owner
        // directly (no chown ever needs to cross an identity boundary here), escalated
        // answers a different uid/gid so its own escalation decision agrees with writable()
        // above instead of a probe this stub never modeled defaulting to "needs sudo".
        if (command === "id" && args[0] === "-u") return { code: 0, stdout: escalated ? "1001" : "1000", stderr: "" };
        if (command === "id" && args[0] === "-g") return { code: 0, stdout: escalated ? "1001" : "1000", stderr: "" };
        if (command === "true") return { code: 0, stdout: "", stderr: "" };
        if (command === "tar" && args.includes("-tzf")) {
          return { code: 0, stdout: "data/\ndata/config/openclaw.json\n", stderr: "" };
        }
        if (command === "tar" && args.includes("-tvzf")) return { code: 0, stdout: "", stderr: "" };
        if (command === "stat") return { code: 0, stdout: "1000:1000", stderr: "" };
        // The restored root is an ordinary directory, not a link.
        if (command === "test" && args[0] === "-L" && args[1] === DATA_DIR) return { code: 1, stdout: "", stderr: "" };
        // The mandatory layout paths answer absent — the EACCES-as-exit-1 this pinned down.
        if (command === "test" && (args[0] === "-e" || args[0] === "-L") && mandatory.includes(args[1] ?? "")) {
          // One of them can answer with the failure of the probe itself instead: an exit
          // code that is neither "there" nor "absent", which must not be read as either.
          if (args[1] === `${DATA_DIR}/${unexpectedProbe}`) return { code: 2, stdout: "", stderr: "" };
          return { code: 1, stdout: "", stderr: "" };
        }
        // The parent-searchability probe: the same privileges that asked about the path
        // are the ones that would have to search its parent.
        if (command === "test" && args[0] === "-x" && args[1] === DATA_DIR) {
          return { code: searchParent ? 0 : 1, stdout: "", stderr: "" };
        }
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: args[1] ?? "", stderr: "" };
        if (command === "test" && args[0] === "-w") return { code: writable(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    runtime: {
      async isRunning(): Promise<boolean> { return true; },
      async stop(): Promise<void> {},
      async start(): Promise<void> {
        // Nothing here reaches the gateway — every restore here ends on the missing-secrets
        // path or stops before it — so a start is a flow bug that must not read as a
        // successful restore.
        throw new Error("the gateway must never start from these restores");
      },
      async waitForHealth(): Promise<void> {},
    },
  } as unknown as Context;
  return { ctx, calls };
}

{
  const { ctx, calls } = deniedContext(false);
  let failure: unknown;
  await withOutputSink(
    () => {},
    async () => {
      try {
        await restoreArchive(ctx, ARCHIVE, { force: true });
      } catch (error) {
        failure = error;
      }
    },
  );

  check("a restored path the probes cannot traverse refuses the restore", failure instanceof UserError, true);
  check(
    "the refusal names the unverifiable path",
    failure instanceof Error && failure.message.includes(`${DATA_DIR}/config`),
    true,
  );
  check("ensureDataDirs never ran through the unverified path", calls.some((call) => call.command === "chmod"), false);
  check(
    "no standard directory was created below it either",
    calls.some((call) => call.command === "mkdir" && call.args.some((arg) => arg.startsWith(`${DATA_DIR}/config`))),
    false,
  );
  check(
    "the previous data was moved back in its place",
    calls.some((call) => call.command === "rm" && call.args[0] === "-rf" && call.args[1] === DATA_DIR),
    true,
  );
}

{
  const { ctx, calls } = deniedContext(true);
  let failure: unknown;
  let output = "";
  await withOutputSink(
    (line) => {
      output += line;
    },
    async () => {
      try {
        await restoreArchive(ctx, ARCHIVE, { force: true });
      } catch (error) {
        failure = error;
      }
    },
  );

  check("an escalated restore of absent subdirectories still completes", failure, undefined);
  check("and reports the missing-secrets completion path", output.includes("restore complete"), true);
  check(
    "the extraction ran privileged, as sudoFor decided for the parent",
    calls.some((call) => call.command === "sudo" && call.args[0] === "-n" && call.args[1] === "tar" && call.args.includes("--numeric-owner")),
    true,
  );
  check(
    "the parent-searchability probe ran privileged too",
    calls.some(
      (call) =>
        call.command === "sudo" &&
        call.args[0] === "-n" &&
        call.args[1] === "test" &&
        call.args[2] === "-x" &&
        call.args[3] === DATA_DIR,
    ),
    true,
  );
  check(
    "no existence probe answered for a data path without that escalation",
    calls.some(
      (call) =>
        call.command === "test" &&
        (call.args[0] === "-e" || call.args[0] === "-L") &&
        (call.args[1] ?? "").startsWith(`${DATA_DIR}/`),
    ),
    false,
  );
  check(
    "and the chmod after the restore ran privileged too",
    calls.some(
      (call) =>
        call.command === "sudo" &&
        call.args[0] === "-n" &&
        call.args[1] === "chmod" &&
        call.args[2] === "700" &&
        call.args[3] === `${DATA_DIR}/auth-secrets`,
    ),
    true,
  );
}

{
  // A probe that answers neither yes nor no: `test -e` failed outright (exit 2), so "is
  // this mandatory path there?" has no answer. The parent searches fine and everything
  // else looks absent-but-answerable, so nothing but the unanswerable probe stands
  // between the restore and writes through a path its checks could not see.
  const { ctx, calls } = deniedContext(false, { searchParent: true, unexpectedProbe: "config" });
  let failure: unknown;
  await withOutputSink(
    () => {},
    async () => {
      try {
        await restoreArchive(ctx, ARCHIVE, { force: true });
      } catch (error) {
        failure = error;
      }
    },
  );

  check("an existence probe answering neither yes nor no refuses the restore", failure instanceof UserError, true);
  check(
    "the refusal names the unanswerable path and the exit code it gave",
    failure instanceof Error && failure.message.includes(`${DATA_DIR}/config`) && failure.message.includes("exited 2"),
    true,
  );
  check("ensureDataDirs never ran through the unverifiable path", calls.some((call) => call.command === "chmod"), false);
  check(
    "no standard directory was created below it either",
    calls.some((call) => call.command === "mkdir" && call.args.some((arg) => arg.startsWith(`${DATA_DIR}/config`))),
    false,
  );
  check(
    "the previous data was moved back in its place",
    calls.some((call) => call.command === "rm" && call.args[0] === "-rf" && call.args[1] === DATA_DIR),
    true,
  );
}

process.stderr.write(failed === 0 ? "all restore checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
