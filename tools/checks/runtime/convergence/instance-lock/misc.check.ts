import { takeLock, readLockHolder, lockPath, lockHome, withInstanceLock } from "#framework/runtime/lock/instance-lock.ts";
import { stubContext, captureFailure, presenceModel, FIXTURE_LOCK_PATH, FIXTURE_LOCK_HOME } from "./fixture.ts";
import { withMutationGuard } from "#framework/security/instance-mutation-guard.ts";
import { createDeploymentFixture } from "#checks/kit/deployment-fixture.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "#framework/core/context.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { OPERATIONS, type MetadataTakeoverReport } from "#framework/commands/orchestration/operations.ts";
import { bindNamed, callFacts, materializeCommands, runOnContext, specData, specShape, ConfirmationRequiredError, ArgumentError } from "#framework/core/command/index.ts";
import { preparedPlan } from "#framework/core/command/spec.ts";
import { executeCommand, type Stage } from "#framework/core/command/execute.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { machineName, ownProcessStartedAt, platformProbes } from "#framework/runtime/lock/process-identity.ts";
import type { OperationRecord } from "#framework/service/operations.ts";
import type { LockHolder } from "#framework/runtime/lock/instance-lock.ts";
import { existsVia, probeEntryExists, type ExecResult } from "#framework/runtime/transport/transport.ts";
import { heartbeatScheduler } from "#framework/runtime/lock/heartbeat.ts";
import type { LockFixture, PresenceModel } from "./fixture.ts";
// --- the lock is not inside the tree restore replaces ------------------------------------------
//
// `restore` moves the whole data directory aside and unpacks a new one in its place. A lock
// living inside left with the old tree, so a second process created its own lock in the new
// one and started work while the restore was still running — the lock covered every
// operation except the one most worth covering.
{
  const { ctx } = stubContext();
  const path = lockPath(ctx);
  check("the lock is not under the data directory", path.startsWith("/srv/clawforge/"), false);
  // In a home of its own, beside the data directory. Beside it alone was not enough: the
  // parent can be root-owned, and then nothing next to the data directory is creatable at
  // all — bootstrap prepares this directory so the lock has somewhere it can go.
  check("it sits in a prepared home beside it", path, "/srv/clawforge-locks/operation.lock");
  check("whose name is derived from the data directory", lockHome(ctx), "/srv/clawforge-locks");
  // The data directory's own name is kept, so two deployments sharing a parent — which is
  // how a second deployment on one host is set up — cannot collide on one lock.
  const other = { settings: { dataDir: "/srv/other" } } as unknown as Context;
  check("two deployments under one parent get different locks", lockPath(other), "/srv/other-locks/operation.lock");
}
// --- the claim is atomic ---------------------------------------------------------------------
//
// The whole mechanism is that creating a directory which already exists fails. Read-then-write,
// which this used to be, let two runs starting together both conclude the lock was free — a
// small window, entirely real, and the only thing standing between two coders.
{
  const { ctx, dirs, files } = stubContext();
  const first = await takeLock(ctx, "apply", "op-1");
  check("winning the lock creates the directory", dirs.has(FIXTURE_LOCK_PATH), true);
  // Second acquire with the directory already there: refused, without ever reading a holder
  // file to decide.
  const originalFiles = [...files];
  const originalDirs = [...dirs];
  let bodyCalls = 0;
  const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "op-2", {}, async () => { bodyCalls++; }));
  check("a second claim against an existing directory is refused", failure instanceof Error, true);
  check("live refusal preserves owner bytes, roots and claims", [[...files], [...dirs], bodyCalls], [originalFiles, originalDirs, 0]);
  await first.release();
  check("releasing frees the directory for the next run", dirs.has(FIXTURE_LOCK_PATH), false);
  const third = await takeLock(ctx, "apply", "op-3");
  check("which the next run then wins", (await readLockHolder(ctx))?.operationId, "op-3");
  await third.release();
}
{
  // A directory won by a run that died before naming itself. Proceeding would be assuming
  // the best about a state nobody understands; the reader is told there is no name to look
  // for rather than being left to think the report lost it.
  const { ctx, dirs, files } = stubContext();
  dirs.add(FIXTURE_LOCK_PATH);
  let bodyCalls = 0;
  for (const breakLock of [false, true]) {
    const failure = await captureFailure(() => withInstanceLock(ctx, "apply", "op-new", { breakLock }, async () => { bodyCalls++; }));
    check(`unnamed lock break=${breakLock} refuses`, failure instanceof Error, true);
    check(`unnamed lock break=${breakLock} preserves root without publication or body`, [[...files], [...dirs].filter((path) => path !== FIXTURE_LOCK_HOME), bodyCalls], [[], [FIXTURE_LOCK_PATH], 0]);
  }
}
// --- a lock that cannot be created is not a lock that is held ---------------------------------
//
// Any non-zero mkdir used to read as "someone holds it", so a directory the tooling cannot
// write into produced a report about a lock that was not there, and offered --break-lock,
// which removes nothing and then fails the same way. The directory itself settles which it
// is: present means held, absent means the mkdir failed for a reason of its own.
{
  const attempts: string[] = [];
  const counts = { writes: 0, removes: 0, reads: 0, body: 0 };
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const denied = {
    settings: { dataDir: "/srv/clawforge" },
    transport: {
      async exec(command: string, args: string[]) {
        if (command === "mkdir") {
          attempts.push(args.at(-1)!);
          return { code: 1, stdout: "", stderr: "mkdir: cannot create directory: Permission denied" };
        }
        // The lock directory is genuinely absent — nothing is holding anything.
        if (command === "test") return { code: dirs.has(args[1]!) || files.has(args[1]!) ? 0 : 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      async readFile(): Promise<string> {
        counts.reads++;
        throw new Error("no such file");
      },
      async writeFile(): Promise<void> { counts.writes++; },
      async remove(): Promise<void> { counts.removes++; },
    },
  } as unknown as Context;
  const failure = await captureFailure(() => withInstanceLock(denied, "apply", "op-1", {}, async () => { counts.body++; }));
  check("denied mkdir throws actual failure", failure instanceof Error, true);
  check("denied mkdir attempted independent lock claim", attempts.includes(FIXTURE_LOCK_PATH), true);
  check("denied mkdir preserves independently absent tree", [[...files], [...dirs]], [[], []]);
  check("denied mkdir performs no writes, removes, reads or body", counts, { writes: 0, removes: 0, reads: 0, body: 0 });
}
// --- operations is a metadata consumer, not an application repair -----------------------------
interface Contact { method: string; paths: string[]; command?: string; presence?: boolean }
interface ConsumerFixture extends LockFixture {
  presence: PresenceModel;
  probeAnswers: Map<string, ExecResult>;
  contacts: Contact[];
  recordContact(method: string, paths: string[], command?: string): void;
  counts: { runtime: number; appWrites: number; journalReads: number; journalWrites: number; forbidden: number };
}
function consumerFixture(history = false): ConsumerFixture {
  const fixture = stubContext();
  const presence = presenceModel(fixture.files, fixture.dirs, FIXTURE_LOCK_HOME);
  if (history) presence.parents.set("/srv/clawforge", true);
  const probeAnswers = presence.answers;
  const contacts: Contact[] = [];
  const counts = { runtime: 0, appWrites: 0, journalReads: 0, journalWrites: 0, forbidden: 0 };
  const base = fixture.ctx.transport;
  const home = FIXTURE_LOCK_HOME;
  const journal = (path: string): boolean => ["/srv/clawforge/clawforge-operations", "/srv/clawforge/cf-operations", "/srv/clawforge/oc-operations"]
    .some((root) => path === root || path.startsWith(`${root}/`));
  const note = (method: string, paths: string[], command?: string, safePresence = false): void => {
    contacts.push({ method, paths, ...(command === undefined ? {} : { command }), ...(safePresence ? { presence: true } : {}) });
    const writes = !["readFile", "listFiles", "exists"].includes(method) && command !== "test" && !safePresence;
    for (const path of paths) {
      if (journal(path)) {
        if (writes) counts.journalWrites++; else counts.journalReads++;
      }
      if (writes && path.startsWith("/srv/clawforge/")) counts.appWrites++;
      if (!(path === home || path.startsWith(`${home}/`) || (history && journal(path)))) {
        counts.forbidden++;
        throw new Error("consumer attempted non-metadata contact");
      }
    }
    if (command !== undefined && !["mkdir", "rmdir", "mv", "ln", "rm", "test"].includes(command) && !safePresence) {
      counts.forbidden++;
      throw new Error("consumer attempted application execution");
    }
  };
  const transport = new Proxy(base, {
    get(target, key) {
      if (key === "existsEntry") return undefined; // Exercise the shared checked-shell fallback.
      if (key === "description") return "operations-directory-model";
      if (key === "exists") return async (path: string): Promise<boolean> => {
        note("exists", [path]);
        return existsVia(async (command, args) => {
          if (command !== "sh" || args[0] !== "-s" || args[1] !== "--" || args[2] !== path || args.length !== 3) throw new Error("unexpected presence probe");
          note("exec", [path], command, true);
          return presence.probe(path);
        }, path);
      };
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]): Promise<unknown> => {
        if (key === "exec") {
          const command = args[0] as string;
          const argv = args[1] as string[];
          if (command === "sh") {
            if (argv[0] !== "-s" || argv[1] !== "--" || argv[2] === undefined) throw new Error("unexpected checked presence probe");
            const path = argv[2];
            note("exec", [path], command, true);
            // Independent presence model uses the named mode contract only; native shell
            // execution remains the parent validation obligation.
            return presence.probe(path, argv[3] === "entry");
          }
          note("exec", argv.filter((arg) => arg.startsWith("/")), command);
          if (command === "test" && argv[0] === "-e") return presence.rawTestE(argv[1]!);
        } else {
          note(String(key), [args[0] as string]);
          if (key === "readFile" && [...presence.links.keys()].some((path) => (args[0] as string).startsWith(`${path}/`))) throw new Error("link referent unreadable");
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
  const ctx = { ...fixture.ctx, transport, runtime: new Proxy(fixture.ctx.runtime, {
    get() { return async (): Promise<never> => { counts.runtime++; throw new Error("runtime trap"); }; },
  }) } as Context;
  return { ...fixture, ctx, presence, probeAnswers, contacts, counts, recordContact: note };
}
const historical: LockHolder = {
  operationId: "20260919205351298-restart-e1f2f4", what: "restart", by: "Computer@PC pid 17012",
  takenAt: "2026-09-19T20:53:51.503Z",
};
const deadLocal: LockHolder = { ...historical, by: "modern owner", host: machineName(), pid: 99999999 };
function seed(f: ConsumerFixture, holder: LockHolder = historical): string {
  const root = FIXTURE_LOCK_PATH;
  const bytes = `${JSON.stringify(holder, null, 2)}\n`;
  f.dirs.add(root);
  f.files.set(`${root}/holder.json`, bytes);
  return bytes;
}
function noApplicationContact(label: string, f: ConsumerFixture, history = false, fixtureRuntime = true): void {
  check(`${label}: app writes, journal writes, forbidden contacts`,
    [f.counts.appWrites, f.counts.journalWrites, f.counts.forbidden], [0, 0, 0]);
  if (fixtureRuntime) check(`${label}: fixture runtime traps`, f.counts.runtime, 0);
  if (!history) check(`${label}: no journal reads`, f.counts.journalReads, 0);
}
/** Named binder + real prepare/body on the fixture context, not the full MCP pipeline.
 * The confirmation gate is reproduced here; stage-zero checks below use executeCommand. */
async function namedConsumer(f: ConsumerFixture, args: Record<string, unknown>, confirmed: boolean): Promise<{ output: string; error?: unknown }> {
  let output = "";
  let error: unknown;
  try {
    await withOutputSink((chunk) => { output += chunk; }, async () => {
      const call = bindNamed(specShape(OPERATIONS), { kind: "named", args }, "operations", { confirmed });
      check("confirmed binder supplies consent only", call.values.confirmed, confirmed);
      if (callFacts(specShape(OPERATIONS), call).effect === "destroy" && !confirmed) throw new ConfirmationRequiredError("operations");
      const data = specData(OPERATIONS);
      if (data.kind !== "single") throw new Error("operations must be single");
      const plan = await preparedPlan(data, call);
      await (data.run as (ctx: Context, plan: unknown) => Promise<void>)(f.ctx, plan);
    });
  } catch (caught) { error = caught; }
  return { output, ...(error === undefined ? {} : { error }) };
}
const takeoverArgs = { "takeover-lock": true, "break-lock": true, "break-foreign-lock": "PC", json: true };
function report(output: string): MetadataTakeoverReport { return JSON.parse(output) as MetadataTakeoverReport; }
function failedReport(label: string, output: string, error: unknown, changed: boolean | null = null): MetadataTakeoverReport {
  const result = report(output);
  check(`${label}: original failure propagates`, error instanceof Error, true);
  check(`${label}: failure flags are conservative`, [result.changed, result.releaseVerified, result.quiescent], [changed, false, false]);
  check(`${label}: stable safe problem code`, result.problem?.code, "LOCK_METADATA_TAKEOVER_UNCONFIRMED");
  check(`${label}: error DTO has no raw transport details`, output.includes("PRIVATE-TRANSPORT-DETAIL"), false);
  check(`${label}: public report excludes raw owner fields`, /"(?:holder|by|operationId|takenAt|generation)"/.test(output), false);
  return result;
}
// Stage zero: the actual pipeline refuses before settings/environment/context/transport.
{
  const commands = materializeCommands({ operations: { summary: "history and metadata", group: "check", ...OPERATIONS } });
  let contextContacts = 0;
  const app = { name: "operations-consumer", description: "fixture", commands,
    get settings(): AppDefinition["settings"] { contextContacts++; throw new Error("context settings trap"); } };
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  try {
    for (const kase of [
      { argv: ["--takeover-lock"], stage: "parse", argument: "takeover-lock" },
      { argv: [historical.operationId, "--takeover-lock", "--break-lock"], stage: "parse", argument: "takeover-lock" },
      { argv: ["--limit", "2", "--takeover-lock", "--break-lock"], stage: "parse", argument: "takeover-lock" },
      { argv: ["--break-lock"], stage: "parse", argument: "break-lock" },
      { argv: ["--break-foreign-lock", "PC"], stage: "parse", argument: "break-foreign-lock" },
      { argv: ["--confirmed", "--takeover-lock", "--break-lock"], stage: "parse", argument: undefined },
      { argv: ["--takeover-lock", "--break-lock"], stage: "prepare", argument: undefined },
    ] as const) {
      const argv: readonly string[] = kase.argv;
      const f = consumerFixture();
      const stages: Stage[] = [];
      const execution = await executeCommand(app, "operations", { kind: "argv", argv },
        { surface: "terminal", transport: f.ctx.transport, observe: (stage) => { stages.push(stage); } });
      check(`${argv.join(" ")}: refused at intended stage`, [execution.stage, execution.reachedRun], [kase.stage, false]);
      if (kase.argument !== undefined) {
        check("invalid combination is an argument error", execution.error instanceof ArgumentError, true);
        check("invalid combination names controlling flag", (execution.error as ArgumentError).argument, kase.argument);
      }
      if (argv.includes("--confirmed")) check("CLI cannot forge MCP consent", execution.error instanceof ArgumentError, true);
      if (kase.stage === "prepare") check("CLI non-TTY needs typed consent", execution.error instanceof Error, true);
      check("stage zero does not reach environment/context/run", stages.some((stage) => ["environment", "context", "run"].includes(stage)), false);
      check("stage zero makes no transport or context contact", [f.contacts.length, contextContacts], [0, 0]);
      noApplicationContact("CLI stage zero", f, false, false);
    }
    const f = consumerFixture();
    const stages: Stage[] = [];
    const execution = await executeCommand(app, "operations", { kind: "named", args: takeoverArgs },
      { surface: "mcp", transport: f.ctx.transport, observe: (stage) => { stages.push(stage); } });
    check("MCP gate never reaches preparation/environment/context/run", stages.some((stage) => ["prepare", "environment", "context", "run"].includes(stage)), false);
    check("MCP unconfirmed stops at confirmation", [execution.stage, execution.reachedRun, execution.error instanceof ConfirmationRequiredError], ["confirm", false, true]);
    check("MCP unconfirmed no target/context contact", [f.contacts.length, contextContacts], [0, 0]);
    noApplicationContact("MCP stage zero", f, false, false);
  } finally {
    if (stdinDescriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
  }
}
// Historical public record and list still read actual bytes, never mutate their model.
{
  const f = consumerFixture(true);
  const record: OperationRecord = { id: historical.operationId, command: "restart", deployment: "fixture",
    startedAt: historical.takenAt, outcome: "abandoned", steps: [{ id: "config", status: "done", at: historical.takenAt }], note: "preserve history" };
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  const path = "/srv/clawforge/clawforge-operations/20260919205351298-restart-e1f2f4.json";
  f.files.set(path, bytes);
  f.dirs.add("/srv/clawforge/clawforge-operations");
  const originalFiles = [...f.files];
  const originalDirs = [...f.dirs];
  for (const [argv, expected] of [[ [record.id, "--json"], record ], [ ["--limit", "1", "--json"], { operations: [record] } ]] as const) {
    let output = "";
    await withOutputSink((chunk) => { output += chunk; }, () => runOnContext(OPERATIONS, f.ctx, argv, "operations"));
    check("history retains public JSON shape", JSON.parse(output), expected);
  }
  const confirmAlone = await namedConsumer(f, { json: true }, true);
  check("confirm true alone reads history, never grants takeover", JSON.parse(confirmAlone.output), { operations: [record] });
  check("history consumed actual journal bytes", f.contacts.some((contact) => contact.method === "readFile" && contact.paths.includes(path)), true);
  check("history preserves all file bytes and directories", [[...f.files], [...f.dirs]], [originalFiles, originalDirs]);
  check("history never executes metadata mutation", f.contacts.some((contact) => contact.command !== undefined && contact.command !== "test" && contact.presence !== true), false);
  noApplicationContact("history", f, true);
}
const deploymentRoot = await mkdtemp(join(tmpdir(), "clawforge-operations-presence-"));
const deploymentFixture = await createDeploymentFixture({ root: deploymentRoot }).catch(async (error) => {
  await rm(deploymentRoot, { recursive: true, force: true }); throw error;
});
async function pipelineConsumer(f: ConsumerFixture): Promise<{ output: string; error?: unknown }> {
  const app: AppDefinition = { name: "operations-consumer", description: "fixture",
    settings: () => ({ OC_TARGET_LOCATION: "local", OC_DATA_DIR: "/srv/clawforge" }),
    commands: materializeCommands({ operations: { summary: "metadata", group: "check", ...OPERATIONS } }) };
  let output = "";
  const stages: Stage[] = [];
  const execution = await withOutputSink((chunk) => { output += chunk; }, () =>
    executeCommand(app, "operations", { kind: "named", args: takeoverArgs }, {
      surface: "mcp", confirmed: true, transport: f.ctx.transport, observe: (stage) => { stages.push(stage); },
    }));
  check("confirmed presence pipeline reaches real run", [execution.stage, execution.reachedRun, stages.includes("environment")], ["run", true, true]);
  return { output, ...(execution.error === undefined ? {} : { error: execution.error }) };
}
const originalProbe = platformProbes.processStartedAt;
platformProbes.processStartedAt = async () => ownProcessStartedAt();
try {
  await writeFile(join(deploymentRoot, ".env"), "OC_TARGET_LOCATION=local\nOC_DATA_DIR=/srv/clawforge\n", "utf8");
  for (const holder of [historical, deadLocal]) {
    const f = consumerFixture();
    seed(f, holder);
    f.files.set(`${FIXTURE_LOCK_PATH}/unrelated-old-metadata`, "old bytes");
    const result = await namedConsumer(f, takeoverArgs, true);
    const dto = report(result.output);
    check("confirmed takeover result", [result.error, dto.mode, dto.changed, dto.before?.state, dto.claimed?.state, dto.after?.state,
      dto.acquisitionVerified, dto.releaseVerified, dto.quiescent],
      [undefined, "takeover-lock", true, holder === historical ? "remote" : "dead", "live", "absent", true, true, true]);
    check("exact historical record is legacy-by", dto.before?.identitySource, holder === historical ? "legacy-by" : "structured");
    check("old metadata removed; all lock and guard roots released", [[...f.files], [...f.dirs].filter((path) => path !== FIXTURE_LOCK_HOME)], [[], []]);
    noApplicationContact("confirmed metadata", f);
  }
  {
    const f = consumerFixture();
    check("bare test-e silently returns one for checked-parent absence", await f.ctx.transport.exec("test", ["-e", FIXTURE_LOCK_PATH]), { code: 1, stdout: "", stderr: "" });
    check("safe existsVia proves absence from searchable parents", await f.ctx.transport.exists(FIXTURE_LOCK_PATH), false);
    const result = await pipelineConsumer(f);
    check("absent is verified unchanged", report(result.output), { mode: "takeover-lock", changed: false,
      before: { state: "absent", takeover: "none" }, claimed: null, after: { state: "absent", takeover: "none" },
      acquisitionVerified: false, releaseVerified: false, quiescent: true });
    check("absent never mkdir or write", f.contacts.every((contact) => contact.method === "exists" || contact.command === "test" || contact.presence === true), true);
    check("absent preserves empty tree", [[...f.files], [...f.dirs]], [[], []]);
    noApplicationContact("absent", f, false, false);
  }
  for (const [label, holder, host] of [
    ["live", { ...deadLocal, pid: process.pid }, "PC"],
    ["unknown", { ...historical, by: "not an owner" }, "PC"],
    ["malformed", { ...historical, host: null }, "PC"],
    ["wrong host", historical, "wrong-host"],
  ] as const) {
    const f = consumerFixture();
    const bytes = seed(f, holder as LockHolder);
    const result = await namedConsumer(f, { ...takeoverArgs, "break-foreign-lock": host }, true);
    const dto = failedReport(label, result.output, result.error, label === "wrong host" ? null : false);
    if (label === "wrong host") check("wrong host reaches mutating guard acquisition", f.contacts.some((contact) => contact.command === "mkdir"), true);
    else check(`${label}: refusal precedes mutation`, f.contacts.every((contact) => contact.method === "readFile" || contact.method === "exists" || contact.command === "test" || contact.presence === true), true);
    check(`${label}: observed before retained`, dto.before?.state, label === "live" ? "live" : label === "wrong host" ? "remote" : "unknown");
    check(`${label}: no verified acquisition`, [dto.claimed, dto.acquisitionVerified], [null, false]);
    check(`${label}: original owner bytes preserved`, f.files.get(`${FIXTURE_LOCK_PATH}/holder.json`), bytes);
    check(`${label}: original root retained`, f.dirs.has(FIXTURE_LOCK_PATH), true);
    noApplicationContact(label, f);
  }
  // Real existsVia verdicts distinguish independently blocked traversal/link targets from missing.
  for (const target of ["lock", "guard"] as const) {
    for (const fault of ["parent", "link target", "link unreadable", "malformed", "silent", "exit1"] as const) {
      const f = consumerFixture();
      const bytes = seed(f);
      const root = FIXTURE_LOCK_PATH;
      const path = target === "lock" ? root : `${FIXTURE_LOCK_HOME}/operation.mutation`;
      if (fault === "parent") f.presence.parents.set(FIXTURE_LOCK_HOME, false);
      else if (fault === "link target") {
        f.presence.links.set(path, "/independent-link-target/missing");
        f.presence.parents.set("/independent-link-target", false);
      } else if (fault === "link unreadable") f.presence.links.set(path, null);
      else f.probeAnswers.set(path, { code: fault === "exit1" ? 1 : 0, stdout: fault === "malformed" ? "nonsense\n" : "", stderr: "" });
      // An absent lock with an independently inaccessible guard cannot certify quiescence.
      if (target === "guard") f.dirs.delete(root);
      if (["parent", "link target", "link unreadable"].includes(fault)) {
        check("bare test-e silently returns one for inaccessible path", await f.ctx.transport.exec("test", ["-e", path]), { code: 1, stdout: "", stderr: "" });
        check("safe existsVia throws on independent inaccessible state", (await captureFailure(() => f.ctx.transport.exists(path))) instanceof Error, true);
      }
      const originalLinks = [...f.presence.links];
      const originalFiles = [...f.files];
      const originalDirs = [...f.dirs];
      const result = await pipelineConsumer(f);
      const dto = failedReport(`${target} ${fault}`, result.output, result.error, target === "guard" && fault !== "parent" ? false : fault === "link target" || fault === "link unreadable" ? false : null);
      check("blocked facts are not absent/quiescent", [dto.before?.state, dto.after?.state, dto.quiescent],
        target === "lock" && (fault === "link target" || fault === "link unreadable") ? ["unknown", "unknown", false] : target === "lock" || fault === "parent" ? [undefined, undefined, false] : ["absent", "absent", false]);
      check("blocked probe preserves exact bytes and roots", [[...f.files], [...f.dirs]], [originalFiles, originalDirs]);
      check("blocked probe preserves independent links", [...f.presence.links], originalLinks);
      check("blocked probe retains owner bytes", f.files.get(`${root}/holder.json`), bytes);
      noApplicationContact(`${target} ${fault}`, f, false, false);
    }
  }
  for (const target of ["lock", "guard"] as const) {
    for (const retained of [false, true]) {
      const f = consumerFixture();
      const path = target === "lock" ? FIXTURE_LOCK_PATH : `${FIXTURE_LOCK_HOME}/operation.mutation`;
      const held = target === "lock" ? await takeLock(f.ctx, "primitive", "op-strict", { strictVerification: true }) : undefined;
      const exec = f.ctx.transport.exec.bind(f.ctx.transport);
      const probe = f.presence.probe.bind(f.presence);
      let injected = false;
      let ambiguousProbes = 0;
      f.ctx.transport.exec = async (command, args, options) => {
        if (command === "rmdir" && args.at(-1) === path) {
          const result = retained ? { code: 0, stdout: "", stderr: "" } : await exec(command, args, options);
          injected = true;
          f.presence.links.set(path, "/independent-link-target/missing");
          f.presence.parents.set("/independent-link-target", false);
          return result;
        }
        return exec(command, args, options);
      };
      f.presence.probe = (probePath, entry) => {
        if (injected && probePath === path) ambiguousProbes++;
        return probe(probePath, entry);
      };
      let bodyCalls = 0;
      const failure = await captureFailure(() => held !== undefined ? held.release() : withMutationGuard(f.ctx, async () => {
        bodyCalls++;
      }, false, undefined, { strictVerification: true }));
      check(`strict ${target} primitive throws independently`, failure instanceof Error, true);
      check(`strict ${target} cleanup fault and ambiguous existsVia reached`, [injected, ambiguousProbes > 0], [true, true]);
      check(`strict ${target} retained or unobservable root`, f.dirs.has(path), retained);
      check(`strict ${target} cleanup preserves injected link and removed owner`, [f.presence.links.get(path), f.files.has(`${path}/${target === "lock" ? "holder.json" : "owner.json"}`), bodyCalls], ["/independent-link-target/missing", false, target === "guard" ? 1 : 0]);
      check("ambiguous primitive outcome is not proven absence", (await captureFailure(() => f.ctx.transport.exists(path))) instanceof Error, true);
      noApplicationContact(`strict ${target} primitive`, f);
    }
  }
  // NODE presence is independent of referent existence; consumers must not certify absence.
  for (const target of ["lock", "guard"] as const) {
    const f = consumerFixture();
    const path = target === "lock" ? FIXTURE_LOCK_PATH : `${FIXTURE_LOCK_HOME}/operation.mutation`;
    f.presence.links.set(path, "/srv/missing-referent");
    check("standalone model separates dangling node from referent", [f.presence.probe(path).stdout, f.presence.probe(path, true).stdout], ["absent\n", "exists\n"]);
    check("dangling final node follow-target remains false", await f.ctx.transport.exists(path), false);
    check("dangling final node entry presence is true", await probeEntryExists(f.ctx.transport, path), true);
    const result = await namedConsumer(f, takeoverArgs, true);
    const dto = failedReport(`dangling ${target}`, result.output, result.error, false);
    check("dangling node consumer refuses quiescence", [result.error instanceof Error, dto.quiescent, dto.before?.state], [true, false, target === "lock" ? "unknown" : "absent"]);
    check("dangling node preserved without takeover", [f.presence.links.get(path), f.contacts.some((contact) => contact.command === "mkdir")], ["/srv/missing-referent", false]);
    f.presence.parents.set(FIXTURE_LOCK_HOME, false);
    check("entry checked parent blocked throws", (await captureFailure(() => probeEntryExists(f.ctx.transport, path))) instanceof Error, true);
  }
  for (const target of ["lock", "guard"] as const) {
    const f = consumerFixture();
    const path = target === "lock" ? FIXTURE_LOCK_PATH : `${FIXTURE_LOCK_HOME}/operation.mutation`;
    const held = target === "lock" ? await takeLock(f.ctx, "primitive", "op-dangling", { strictVerification: true }) : undefined;
    const exec = f.ctx.transport.exec.bind(f.ctx.transport);
    let injected = false;
    let bodyCalls = 0;
    f.ctx.transport.exec = async (command, args, options) => {
      const result = await exec(command, args, options);
      if (command === "rmdir" && args.at(-1) === path) { injected = true; f.presence.links.set(path, "/srv/missing-referent"); }
      return result;
    };
    const failure = await captureFailure(() => held !== undefined ? held.release() : withMutationGuard(f.ctx, async () => { bodyCalls++; }, false, undefined, { strictVerification: true }));
    check(`strict ${target} dangling node release refuses`, failure instanceof Error, true);
    check(`strict ${target} dangling cleanup fault reached and preserved`, [injected, f.dirs.has(path), f.presence.links.get(path), f.files.has(`${path}/${target === "lock" ? "holder.json" : "owner.json"}`), bodyCalls], [true, false, "/srv/missing-referent", false, target === "guard" ? 1 : 0]);
    check("strict dangling node remains present", await probeEntryExists(f.ctx.transport, path), true);
  }
  // The first returned raw owner, not a second same-host/PID read, is the CAS baseline.
  for (const replacement of [
    { what: "restore" },
    { generation: "replacement-generation" },
    { by: "bob@PC pid 17012" },
    { operationId: "20260919205351298-restart-abcdef" },
    { takenAt: "2026-09-19T20:54:51.503Z" },
  ]) {
    const f = consumerFixture();
    seed(f, "generation" in replacement ? { ...historical, by: "modern owner", host: "PC", pid: 17012, generation: "original-generation" } : historical);
    const root = FIXTURE_LOCK_PATH;
    if ("generation" in replacement) f.dirs.add(`${root}/gen-original-generation`);
    const successor = `${JSON.stringify({ ...JSON.parse(f.files.get(`${root}/holder.json`)!), ...replacement }, null, 2)}\n`;
    const read = f.ctx.transport.readFile.bind(f.ctx.transport);
    let replaced = false;
    f.ctx.transport.readFile = async (path) => {
      const bytes = await read(path);
      if (path === `${root}/holder.json` && !replaced) {
        replaced = true;
        f.files.set(path, successor);
        if ("generation" in replacement) { f.dirs.delete(`${root}/gen-original-generation`); f.dirs.add(`${root}/gen-replacement-generation`); }
        f.files.set(`${root}/successor-only`, "preserve successor");
      }
      return bytes;
    };
    const result = await namedConsumer(f, takeoverArgs, true);
    const dto = failedReport("first-read replacement", result.output, result.error);
    check("first captured public projection retained", [replaced, dto.before?.state, dto.before?.host, dto.before?.pid, dto.before?.operation], [true, "remote", "PC", 17012, "restart"]);
    if ("generation" in replacement) check("modern successor marker preserved", f.dirs.has(`${root}/gen-replacement-generation`), true);
    check("replacement refused before moving instance root", f.contacts.some((contact) => contact.command === "mv" && contact.paths[0] === root), false);
    check("replacement bytes preserved", [f.files.get(`${root}/holder.json`), f.files.get(`${root}/successor-only`)], [successor, "preserve successor"]);
    check("public JSON never exposes raw owner", /"(?:holder|by|operationId|takenAt|generation)"/.test(result.output), false);
    noApplicationContact("first-read replacement", f);
  }
  // Change only the legacy username AFTER approval and immediately BEFORE the real move.
  {
    const f = consumerFixture();
    seed(f);
    const root = FIXTURE_LOCK_PATH;
    const successor = `${JSON.stringify({ ...historical, by: "bob@PC pid 17012" }, null, 2)}\n`;
    const exec = f.ctx.transport.exec.bind(f.ctx.transport);
    let raced = false;
    f.ctx.transport.exec = async (command, args, options) => {
      if (command === "mv" && args[0] === root && !raced) {
        raced = true;
        f.files.set(`${root}/holder.json`, successor);
        f.files.set(`${root}/B-only`, "preserve B");
      }
      return exec(command, args, options);
    };
    const result = await namedConsumer(f, takeoverArgs, true);
    failedReport("username race", result.output, result.error);
    check("username-only race reaches actual takeover move", raced, true);
    check("B owner and unrelated bytes restored", [f.files.get(`${root}/holder.json`), f.files.get(`${root}/B-only`)], [successor, "preserve B"]);
    check("restoration uses no-nesting no-clobber real semantics", f.contacts.some((contact) => contact.command === "mv" && contact.paths.includes(root)), true);
    check("no stale nesting remains", [...f.dirs].filter((path) => path.includes(".stale-")).length, 0);
    noApplicationContact("username race", f);
  }
  // A restoration collision must not nest B into C (mv -n without -T would).
  {
    const f = consumerFixture();
    seed(f);
    const root = FIXTURE_LOCK_PATH;
    const b = JSON.stringify({ ...historical, by: "bob@PC pid 17012" });
    const c = JSON.stringify({ ...deadLocal, generation: "C", operationId: "C", pid: process.pid });
    const exec = f.ctx.transport.exec.bind(f.ctx.transport);
    let displaced = "";
    let restored = false;
    f.ctx.transport.exec = async (command, args, options) => {
      if (command === "mv" && args[0] === root) {
        f.files.set(`${root}/holder.json`, b);
        f.files.set(`${root}/B-only`, "B");
        displaced = args[1]!;
      }
      if (command === "mv" && args.at(-1) === root && args.at(-2)?.includes(".stale-")) {
        restored = true;
        f.dirs.add(root);
        f.dirs.add(`${root}/gen-C`);
        f.files.set(`${root}/holder.json`, c);
        f.files.set(`${root}/C-only`, "C");
      }
      return exec(command, args, options);
    };
    const result = await namedConsumer(f, takeoverArgs, true);
    const dto = failedReport("restoration collision", result.output, result.error);
    check("restoration collision exercised real nT skip", [restored, f.dirs.has(displaced)], [true, true]);
    check("B remains displaced with exact bytes", [f.files.get(`${displaced}/holder.json`), f.files.get(`${displaced}/B-only`)], [b, "B"]);
    check("C remains root with exact bytes", [f.files.get(`${root}/holder.json`), f.files.get(`${root}/C-only`)], [c, "C"]);
    check("no restoration nests B inside C", [...f.dirs].some((path) => path.startsWith(`${root}/operation.lock.stale-`)), false);
    check("collision after reports C live without claiming acquisition", [dto.after?.state, dto.acquisitionVerified], ["live", false]);
    noApplicationContact("restoration collision", f);
  }
  // Faults affect real fixture operations; no echo transports or raw-run success controls.
  for (const fault of ["release nonzero", "release throw", "owner unreadable", "generation race", "guard persists", "acquisition guard persists",
    "presence code2", "publication mismatch", "successor", "guard unavailable", "guard source unreadable", "guard generation race", "expected owner unreadable"] as const) {
    const f = consumerFixture();
    seed(f);
    const root = FIXTURE_LOCK_PATH;
    const guard = `${FIXTURE_LOCK_HOME}/operation.mutation`;
    const exec = f.ctx.transport.exec.bind(f.ctx.transport);
    const read = f.ctx.transport.readFile.bind(f.ctx.transport);
    const write = f.ctx.transport.writeFile.bind(f.ctx.transport);
    let injected = false;
    if (fault === "presence code2") {
      f.probeAnswers.set(root, { code: 2, stdout: "", stderr: "PRIVATE-TRANSPORT-DETAIL" });
      injected = true;
    }
    let published = false;
    let releasePhase = false;
    let holderReads = 0;
    const successor = JSON.stringify({ ...deadLocal, generation: "successor", operationId: "successor", pid: process.pid });
    f.ctx.transport.writeFile = async (path, bytes) => {
      await write(path, bytes);
      if (path === `${root}/holder.json`) {
        published = true;
        if (fault === "publication mismatch") { injected = true; f.files.set(path, JSON.stringify({ ...JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)), operationId: "different" })); }
      }
    };
    f.ctx.transport.readFile = async (path) => {
      const bytes = await read(path);
      if (path === `${root}/holder.json`) holderReads++;
      if (fault === "expected owner unreadable" && holderReads === 2 && path === `${root}/holder.json`) {
        injected = true; throw new Error("PRIVATE-TRANSPORT-DETAIL");
      }
      if (fault === "guard generation race" && path === `${guard}/owner.json`) {
        injected = true;
        const changed = JSON.stringify({ ...JSON.parse(bytes), generation: "guard-successor" });
        f.files.set(path, changed);
        return changed;
      }
      if (fault === "owner unreadable" && path === `${root}/holder.json`) { injected = true; throw new Error("PRIVATE-TRANSPORT-DETAIL"); }
      if (fault === "guard source unreadable" && path === `${guard}/owner.json`) { injected = true; throw new Error("PRIVATE-TRANSPORT-DETAIL"); }
      return bytes;
    };
    f.ctx.transport.exec = async (command, args, options): Promise<ExecResult> => {
      const zeroFailure = { code: 2, stdout: "", stderr: "PRIVATE-TRANSPORT-DETAIL" };
      const fail = (): ExecResult => {
        f.recordContact("exec", args.filter((arg) => arg.startsWith("/")), command);
        injected = true;
        return zeroFailure;
      };
      if (fault === "guard unavailable" && ((command === "mkdir" && args.at(-1) === FIXTURE_LOCK_HOME) || (command === "test" && args[1] === FIXTURE_LOCK_HOME))) {
        return fail();
      }
      if (command === "mv" && args[0]?.startsWith(`${root}/gen-`)) {
        releasePhase = true;
        if (fault === "release nonzero") { return fail(); }
        if (fault === "release throw") { fail(); throw new Error("PRIVATE-TRANSPORT-DETAIL"); }
        if (fault === "successor") {
          injected = true;
          for (const path of f.dirs) if (path.startsWith(`${root}/gen-`)) f.dirs.delete(path);
          f.dirs.add(`${root}/gen-successor`);
          f.files.set(`${root}/holder.json`, successor);
          f.files.set(`${root}/successor-only`, "successor bytes");
        }
      }
      if (fault === "generation race" && published && command === "test" && args[1]?.startsWith(`${root}/gen-`)) {
        f.recordContact("exec", args.filter((arg) => arg.startsWith("/")), command);
        injected = true; f.dirs.delete(args[1]); return { code: 1, stdout: "", stderr: "" };
      }
      if (((fault === "guard persists" && releasePhase) || (fault === "acquisition guard persists" && published)) && command === "rmdir" && args[0] === guard) {
        return fail();
      }
      return exec(command, args, options);
    };
    const originalSchedule = heartbeatScheduler.schedule;
    const originalCancel = heartbeatScheduler.cancel;
    const activeTimers = new Map<object, () => Promise<void>>();
    let scheduled = 0;
    let cancelled = 0;
    heartbeatScheduler.schedule = (tick) => {
      const timer = {};
      activeTimers.set(timer, tick);
      scheduled++;
      return timer;
    };
    heartbeatScheduler.cancel = (timer) => {
      if (activeTimers.delete(timer)) cancelled++;
    };
    try {
      const result = fault === "presence code2" ? await pipelineConsumer(f) : await namedConsumer(f, takeoverArgs, true);
      const verified = ["release nonzero", "release throw", "guard persists", "successor"].includes(fault);
      const dto = failedReport(fault, result.output, result.error, verified ? true : fault === "owner unreadable" ? false : null);
      check(`${fault}: intended fault exercised`, injected, true);
      if (["release nonzero", "release throw", "guard persists", "successor"].includes(fault)) {
        check(`${fault}: reached owned release stage`, releasePhase, true);
        check(`${fault}: available owned live claim retained`, [dto.claimed?.state, dto.acquisitionVerified], ["live", true]);
      } else check(`${fault}: acquisition never certified`, dto.acquisitionVerified, false);
      if (fault === "publication mismatch") check("publication mismatch reached observed claim verification", [published, dto.claimed?.state], [true, "live"]);
      if (fault === "presence code2") check("failed presence is null, never absence", [dto.before, dto.after], [null, null]);
      if (fault === "successor") {
        check("successor holder and bytes preserved", [f.files.get(`${root}/holder.json`), f.files.get(`${root}/successor-only`)], [successor, "successor bytes"]);
        check("successor root and marker preserved", [f.dirs.has(root), f.dirs.has(`${root}/gen-successor`)], [true, true]);
        check("successor observed live, not falsely absent", dto.after?.state, "live");
      }
      if (fault === "guard persists") check("guard persistence cannot certify quiescence", f.dirs.has(guard), true);
      if (["guard unavailable", "guard source unreadable", "guard generation race", "expected owner unreadable"].includes(fault)) check("strict guard/owner failure never moves instance owner", f.contacts.some((contact) => contact.command === "mv" && contact.paths[0] === root), false);
      if (fault === "acquisition guard persists") {
        check("acquisition guard failure follows holder publication", published, true);
        check("acquisition guard failure cancels heartbeat callbacks", [scheduled, cancelled, activeTimers.size], [1, 1, 0]);
        check("acquisition guard failure retains uncertified observed claim", [dto.claimed, dto.acquisitionVerified], [null, false]);
        check("acquisition guard failure leaves failed guard present", f.dirs.has(guard), true);
      }
      noApplicationContact(fault, f, false, fault !== "presence code2");
    } finally {
      heartbeatScheduler.schedule = originalSchedule;
      heartbeatScheduler.cancel = originalCancel;
    }
  }
} finally { platformProbes.processStartedAt = originalProbe; await deploymentFixture.dispose(); }
finish("instance lock misc");
