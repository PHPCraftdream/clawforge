// `recipe run`: manifest-declared actions through the real pipeline.
//
//   - every argument refusal is a prepare-stage ArgumentError naming "arg" or
//     "recipe-action", and the hook module is never imported (top-level marker absent);
//   - the effectOf resolver runs BEFORE the confirm decision: an unconfirmed resolved
//     change stops at "confirm" with the hook unimported; confirm: true reaches the hook;
//   - the recipes-directory selection happens before the resolver, so an app with a custom
//     recipesDir has its confirmation decided from ITS manifest, not the default root;
//   - a change action imports its module only inside the instance lock: a held lock
//     refuses with the marker absent, while a read action runs under the same lock;
//   - --dry-run reaches the hook as input.dryRun, is treated as read (no confirm, no
//     lock), and a hook that returns nothing yields { ok: true };
//   - results are serialized raw FIRST, then deep-masked: a secret through toJSON, a secret
//     key, a Date's ISO string and a cyclic structure all behave as specified;
//   - results over 64 KiB refuse at the run stage; the terminal --json emits the payload.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError, ConfirmationRequiredError } from "#framework/core/command/index.ts";
import type { Stage } from "#framework/core/command/execute.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { registerSecret } from "#framework/core/io/log.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { useDeployment, useComposeProjectOverride } from "#framework/runtime/deployment.ts";
import { takeLock } from "#framework/runtime/lock/instance-lock.ts";
import { stubContext } from "#checks/runtime/convergence/instance-lock/fixture.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";

useLinuxHost();
const root = await mkdtemp(join(tmpdir(), "clawforge-recipe-run-action-"));
const MARKER = join(root, "change-marker.txt");
const RECIPE_DIR = join(root, "recipes", "local");

function hookSource(action: string, body: string): string {
  return `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(MARKER)}, ${JSON.stringify(`${action}:imported`)});
export function run(_ctx, _recipe, input) {
  ${body}
}
`;
}

const SECRET = "run-action-private-secret-value";
registerSecret(SECRET);

// No-op hooks for the actions whose assertion is about the pipeline, not the hook body:
// their top-level write still proves whether the module was imported at all.
const hooks: Record<string, string> = {
  "actions/change.ts": hookSource("change", `return { dryRun: input.dryRun, args: input.args };`),
  "actions/ctxdry.ts": hookSource("ctxdry", `return { ctxDry: _ctx.dryRun === true };`),
  "actions/read.ts": hookSource("read", `return { dryRun: input.dryRun };`),
  "actions/read-markerless.ts": `export function run() { return undefined; }\n`,
  "actions/big.ts": `export function run() { return "x".repeat(100000); }\n`,
  "actions/secret.ts": `export function run() { return { token: ${JSON.stringify(SECRET)} }; }\n`,
  // Serialization contract: a secret through toJSON, a secret KEY, a Date's ISO string,
  // a cyclic structure, and a thrown secret.
  "actions/tojson.ts": `export function run() { return { toJSON: () => ${JSON.stringify(SECRET)} }; }\n`,
  "actions/secret-key.ts": `export function run() { return { [${JSON.stringify(SECRET)}]: 1 }; }\n`,
  "actions/date.ts": `export function run() { return { at: new Date(0) }; }\n`,
  "actions/cyclic.ts": `export function run() { const value = {}; value.self = value; return value; }\n`,
  "actions/unserializable.ts": `export function run() { return () => 1; }
`,
  "actions/throwing.ts": `export function run() { throw new Error(${JSON.stringify(SECRET)}); }\n`,
  // The resolver's default-root probe: action x reads and reports where it ran.
  "actions/x.ts": `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "default-x-marker.txt"))}, "default");
export function run() { return { where: "default" }; }
`,
  "actions/destroy.ts": `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "destroy-marker.txt"))}, "destroyed");
export function run() { return { ok: true }; }
`,
};

const manifest = {
  description: "run-action fixture",
  actions: {
    ctxdry: { file: "actions/ctxdry.ts", effect: "change", arguments: [] },
    change: {
      file: "actions/change.ts",
      effect: "change",
      arguments: [
        { name: "count", kind: "integer" },
        { name: "mode", kind: "choice", choices: ["fast", "slow"] },
        { name: "label", kind: "text" },
        { name: "verbose", kind: "flag", optional: true },
      ],
    },
    read: { file: "actions/read.ts", effect: "read", arguments: [] },
    noop: { file: "actions/read-markerless.ts", effect: "read", arguments: [] },
    big: { file: "actions/big.ts", effect: "read", arguments: [] },
    secret: { file: "actions/secret.ts", effect: "read", arguments: [] },
    tojson: { file: "actions/tojson.ts", effect: "read", arguments: [] },
    "secret-key": { file: "actions/secret-key.ts", effect: "read", arguments: [] },
    date: { file: "actions/date.ts", effect: "read", arguments: [] },
    cyclic: { file: "actions/cyclic.ts", effect: "read", arguments: [] },
    unserializable: { file: "actions/unserializable.ts", effect: "read", arguments: [] },
    throwing: { file: "actions/throwing.ts", effect: "read", arguments: [] },
    x: { file: "actions/x.ts", effect: "read", arguments: [] },
    destroy: { file: "actions/destroy.ts", effect: "destroy", arguments: [] },
  },
};

// A SECOND recipes root whose action x mutates: the P1 regression proves the confirm
// decision reads the app's OWN root, not the default deployment one.
const customRoot = join(root, "custom-recipes");
const customApp = {
  name: "recipe-run-fixture",
  description: "fixture",
  commands: { recipe: openclawCommands.recipe },
  recipesDir: "custom-recipes",
};

useDeployment(root);
useComposeProjectOverride("recipe-run-action-fixture");
const lock = stubContext();
const app = { name: "recipe-run-fixture", description: "fixture", commands: { recipe: openclawCommands.recipe } };

interface RunResult {
  stage: Stage;
  error: unknown;
  stages: Stage[];
  facts?: { effect?: string; confirm?: boolean };
  output: string;
  json: unknown;
}

async function runPipeline(named: { kind: "argv"; argv: string[] } | { kind: "named"; args: Record<string, unknown> }, io: { surface: "terminal" | "mcp"; confirmed?: boolean }, on: typeof app = app): Promise<RunResult> {
  const stages: Stage[] = [];
  let output = "";
  const execution = await withOutputSink((chunk) => { output += chunk; }, () => executeCommand(on, "recipe", named, {
    ...io, transport: lock.ctx.transport, observe: (stage) => stages.push(stage),
  }));
  const lines = output.trimStart().split("\n").filter((line) => line.startsWith("{"));
  return { stage: execution.stage, error: execution.error, stages, facts: execution.facts as { effect?: string; confirm?: boolean }, output, json: lines.length === 0 ? undefined : JSON.parse(lines.at(-1)!) };
}

async function execute(argv: string[], io: { surface: "terminal" | "mcp"; confirmed?: boolean }): Promise<RunResult> {
  return runPipeline({ kind: "argv", argv: [...argv] }, io);
}

/** The MCP named-argument path (what a real tool call sends) through the real pipeline. */
async function executeNamed(args: Record<string, unknown>, io: { surface: "terminal" | "mcp"; confirmed?: boolean }, on: typeof app = app): Promise<RunResult> {
  return runPipeline({ kind: "named", args }, io, on);
}

/** Parses the emitted JSON payload out of captured output. */
function emittedJson(output: string): unknown {
  const lines = output.trimStart().split("\n").filter((line) => line.startsWith("{"));
  return lines.length === 0 ? undefined : JSON.parse(lines.at(-1)!);
}

/** The held-lock cases run on the stub context itself: executeCommand builds its own
 *  Context (whose lock paths come from the fixture .env), so a lock held on the stub's
 *  in-memory model would not be observed through the real pipeline. */
async function runCaptured(argv: string[]): Promise<{ output: string; error: unknown; json: unknown }> {
  let output = "";
  let error: unknown;
  await withOutputSink((chunk) => { output += chunk; }, async () => {
    try {
      await recipe(lock.ctx, [...argv]);
    } catch (caught) {
      error = caught;
    }
  });
  return { output, error, json: emittedJson(output) };
}

async function clearMarker(marker: string): Promise<void> {
  await rm(marker, { force: true });
}

/** Collects what a body writes to stderr (the log path), restoring the writer after. */
async function captureStderr(body: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let collected = "";
  process.stderr.write = ((chunk: unknown) => { collected += String(chunk); return true; }) as typeof process.stderr.write;
  try { await body(); } finally { process.stderr.write = original; }
  return collected;
}

try {
  // The real pipeline builds a Context for target-needs commands, which reads the
  // deployment's .env — the fixture root needs one before anything runs.
  await writeFile(join(root, ".env"), `OC_TARGET_LOCATION=local\nOC_DATA_DIR=${join(root, "data")}\nOC_COMPOSE_PROJECT=recipe-run-action-fixture\n`, "utf8");
  await mkdir(RECIPE_DIR, { recursive: true });
  await writeFile(join(RECIPE_DIR, "recipe.json"), JSON.stringify(manifest), "utf8");
  await mkdir(join(RECIPE_DIR, "actions"), { recursive: true });
  for (const [relative, source] of Object.entries(hooks)) {
    await writeFile(join(RECIPE_DIR, relative), source, "utf8");
  }
  const customRecipes = join(customRoot, "local");
  await mkdir(join(customRecipes, "actions"), { recursive: true });
  await writeFile(join(customRecipes, "recipe.json"), JSON.stringify({
    description: "custom-root fixture",
    actions: { x: { file: "actions/x.ts", effect: "change", arguments: [] } },
  }), "utf8");
  await writeFile(join(customRecipes, "actions", "x.ts"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "custom-x-marker.txt"))}, "custom");
export function run() { return { where: "custom" }; }
`, "utf8");
  const DEFAULT_X_MARKER = join(root, "default-x-marker.txt");
  const CUSTOM_X_MARKER = join(root, "custom-x-marker.txt");
  const DESTROY_MARKER = join(root, "destroy-marker.txt");
  const markerAbsent = (): boolean => !existsSync(MARKER);

  // 1. Argument validation table — every refusal at prepare (or parse for a missing
  // required positional), never importing the hook module, through the MCP named path.
  const invalid: { readonly label: string; readonly args: Record<string, unknown>; readonly argument: "arg" | "recipe-action"; readonly stage: Stage }[] = [
    { label: "unknown recipe-action", args: { action: "run", name: "local", "recipe-action": "no-such" }, argument: "recipe-action", stage: "prepare" },
    { label: "token without =", args: { action: "run", name: "local", "recipe-action": "change", arg: ["oops"] }, argument: "arg", stage: "prepare" },
    { label: "unknown key", args: { action: "run", name: "local", "recipe-action": "change", arg: ["bogus=1"] }, argument: "arg", stage: "prepare" },
    { label: "duplicate key", args: { action: "run", name: "local", "recipe-action": "change", arg: ["count=1", "count=2"] }, argument: "arg", stage: "prepare" },
    { label: "integer abc", args: { action: "run", name: "local", "recipe-action": "change", arg: ["count=abc"] }, argument: "arg", stage: "prepare" },
    { label: "integer 1.5", args: { action: "run", name: "local", "recipe-action": "change", arg: ["count=1.5"] }, argument: "arg", stage: "prepare" },
    { label: "integer empty", args: { action: "run", name: "local", "recipe-action": "change", arg: ["count="] }, argument: "arg", stage: "prepare" },
    { label: "integer unsafe", args: { action: "run", name: "local", "recipe-action": "change", arg: [`count=${"9".repeat(25)}`] }, argument: "arg", stage: "prepare" },
    { label: "out of choices", args: { action: "run", name: "local", "recipe-action": "change", arg: ["mode=medium"] }, argument: "arg", stage: "prepare" },
    { label: "missing required argument", args: { action: "run", name: "local", "recipe-action": "change", arg: ["count=1"] }, argument: "arg", stage: "prepare" },
    { label: "flag maybe", args: { action: "run", name: "local", "recipe-action": "change", arg: ["verbose=maybe"] }, argument: "arg", stage: "prepare" },
    { label: "missing recipe-action", args: { action: "run", name: "local" }, argument: "recipe-action", stage: "parse" },
  ];
  for (const { label, args, argument, stage } of invalid) {
    await clearMarker(MARKER);
    const result = await executeNamed(args, { surface: "mcp", confirmed: true });
    check(`${label} stops at ${stage}`, result.stage, stage);
    checkTrue(`${label} is an ArgumentError`, result.error instanceof ArgumentError);
    check(`${label} names the argument`, (result.error as ArgumentError).argument, argument);
    checkTrue(`${label} never imports the hook module`, markerAbsent());
  }

  // 2. Effect resolution before confirmation.
  const changeArgs = { action: "run", name: "local", "recipe-action": "change", arg: ["count=1", "mode=fast", "label=x"] };
  const changeArgv = ["run", "local", "change", "count=1", "mode=fast", "label=x"];
  const refused = await executeNamed(changeArgs, { surface: "mcp" });
  check("an unconfirmed resolved change stops at confirm", refused.stage, "confirm");
  checkTrue("the refusal is a ConfirmationRequiredError", refused.error instanceof ConfirmationRequiredError);
  check("the resolver resolved the declared effect with confirm", refused.facts, { effect: "change", confirm: true });
  checkTrue("the unconfirmed call never imports the hook module", markerAbsent());
  await clearMarker(MARKER);
  // The confirmed change goes through the real confirm path (executeCommand, mcp, confirmed).
  const confirmed = await executeNamed(changeArgs, { surface: "mcp", confirmed: true });
  check("the confirmed change reaches run", confirmed.stage, "run");
  checkTrue("the confirmed change reaches the hook", confirmed.error === undefined);
  checkTrue("the confirmed change imported the hook module", !markerAbsent());
  checkTrue("the confirmed change received dryRun false", JSON.stringify(confirmed.json).includes('"dryRun":false'));

  // 3. Lock before import: a held instance lock refuses the change with the module
  // unimported; a read action runs under the same held lock.
  await clearMarker(MARKER);
  const held = await takeLock(lock.ctx, "recipe run fixture", "op-held");
  try {
    const locked = await runCaptured(changeArgv);
    checkTrue("a held lock refuses the change", locked.error instanceof Error);
    checkTrue("the lock refusal precedes the module import", markerAbsent());
    const underLock = await runCaptured(["run", "local", "read"]);
    checkTrue("a read action runs under the held lock", underLock.error === undefined);
    checkTrue("the read action's module was imported", !markerAbsent());
  } finally {
    await held.release();
  }

  // 4. Dry-run: reaches the hook as input.dryRun, reads (no confirm), and a held lock
  // is irrelevant because no lock is taken.
  await clearMarker(MARKER);
  const dry = await executeNamed({ ...changeArgs, "dry-run": true }, { surface: "mcp" });
  check("dry-run reaches the run stage without confirm: true", dry.stage, "run");
  checkTrue("dry-run raises no ConfirmationRequiredError", !(dry.error instanceof ConfirmationRequiredError));
  check("dry-run resolves the facts to read", dry.facts?.effect, "read");
  checkTrue("the dry-run result document says dryRun true", (dry.json as { dryRun?: boolean } | undefined)?.dryRun === true);
  // Helpers read ctx.dryRun: the hook's context must carry the flag on a dry run only.
  const ctxDryOn = await executeNamed({ action: "run", name: "local", "recipe-action": "ctxdry", "dry-run": true }, { surface: "mcp" });
  check("a dry-run hook context says dryRun", (ctxDryOn.json as { ctxDry?: boolean } | undefined)?.ctxDry, true);
  const ctxDryOff = await executeNamed({ action: "run", name: "local", "recipe-action": "ctxdry" }, { surface: "mcp", confirmed: true });
  check("a real-run hook context does not", (ctxDryOff.json as { ctxDry?: boolean } | undefined)?.ctxDry, false);
  await clearMarker(MARKER);
  const heldDry = await takeLock(lock.ctx, "recipe run fixture", "op-held-dry");
  try {
    const underLock = await runCaptured([...changeArgv, "--dry-run"]);
    checkTrue("dry-run runs under a held lock", underLock.error === undefined);
    checkTrue("the dry-run hook saw dryRun true", (underLock.json as { dryRun?: boolean } | undefined)?.dryRun === true);
  } finally {
    await heldDry.release();
  }
  const undried = await execute(["run", "local", "read"], { surface: "terminal" });
  check("without --dry-run the hook sees false", (undried.json as { dryRun?: boolean } | undefined)?.dryRun, false);

  // 5. Result pipeline: undefined -> { ok: true }, the 64 KiB bound, secret masking.
  const noop = await execute(["run", "local", "noop"], { surface: "terminal" });
  check("a hook returning nothing yields the ok payload", noop.json, { ok: true });
  const big = await execute(["run", "local", "big"], { surface: "terminal" });
  checkTrue("an oversized result fails at the run stage", big.stage === "run" && big.error instanceof Error);
  checkTrue("the failure names the result bound", big.error instanceof Error && big.error.message.includes("result") && big.error.message.includes("bound"));

  // 6. Serialization contract: serialize the RAW result first, then deep-mask the parse.
  const tojson = await execute(["run", "local", "tojson"], { surface: "terminal" });
  checkTrue("a secret through toJSON never rides the payload", !String(tojson.output).includes(SECRET) && String(tojson.output).includes("***"));
  const secretKey = await execute(["run", "local", "secret-key"], { surface: "terminal" });
  checkTrue("a secret object KEY comes out masked", !String(secretKey.output).includes(SECRET) && String(secretKey.output).includes("***"));
  const dated = await execute(["run", "local", "date"], { surface: "terminal" });
  checkTrue("a Date result keeps its ISO string", String(dated.output).includes("1970-01-01T00:00:00.000Z"));
  const cyclic = await execute(["run", "local", "cyclic"], { surface: "terminal" });
  checkTrue("a cyclic result refuses at the run stage", cyclic.stage === "run" && cyclic.error instanceof Error);
  checkTrue("the serialization refusal is the sanitized one-line message",
    cyclic.error instanceof Error && String(cyclic.error.message).includes(["recipe", JSON.stringify("local"), "action", JSON.stringify("cyclic")].join(String.fromCharCode(32))) && !cyclic.error.message.includes(String.fromCharCode(10)) && !String(cyclic.error.message).includes(["Converting", "circular"].join(String.fromCharCode(32))));
  const unserializable = await execute(["run", "local", "unserializable"], { surface: "terminal" });
  checkTrue("a result JSON cannot represent refuses at the run stage, not with a parser error", unserializable.stage === "run" && unserializable.error instanceof Error && !String(unserializable.error.name).includes("SyntaxError"));
  const valueSecret = await execute(["run", "local", "secret"], { surface: "terminal" });
  checkTrue("the value secret is masked in the emitted payload", !String(valueSecret.output).includes(SECRET) && String(valueSecret.output).includes("***"));
  const thrown = await execute(["run", "local", "throwing"], { surface: "terminal" });
  checkTrue("a thrown secret error reaches the run stage masked", thrown.stage === "run" && thrown.error instanceof Error);
  checkTrue("the thrown error message contains the mask, not the secret", thrown.error instanceof Error && String(thrown.error.message).includes("***") && !String(thrown.error.message).includes(SECRET));

  // 7. The declared destroy action runs through the real confirm path.
  await clearMarker(DESTROY_MARKER);
  const destroyRun = await executeNamed({ action: "run", name: "local", "recipe-action": "destroy" }, { surface: "mcp", confirmed: true });
  check("the declared destroy action reaches run", destroyRun.stage, "run");
  checkTrue("the destroy action's hook ran", existsSync(DESTROY_MARKER));
  await clearMarker(DESTROY_MARKER);

  // 8. The confirm decision reads the app's OWN recipes root (P1 regression): the default
  // root declares x as read, the app's custom root as change. Unconfirmed, the call must
  // stop at confirm decided from the CUSTOM manifest; neither hook may have run. Confirmed,
  // the custom root's hook runs — proving the selected root.
  await clearMarker(DEFAULT_X_MARKER);
  await clearMarker(CUSTOM_X_MARKER);
  const customArgs = { action: "run", name: "local", "recipe-action": "x" };
  const unconfirmedCustom = await executeNamed(customArgs, { surface: "mcp" }, customApp);
  check("a custom-root change stops at confirm without confirm: true", unconfirmedCustom.stage, "confirm");
  check("the refusal carries the custom root's resolved facts", unconfirmedCustom.facts, { effect: "change", confirm: true });
  checkTrue("the default root's hook never ran", !existsSync(DEFAULT_X_MARKER));
  checkTrue("the custom root's hook never ran", !existsSync(CUSTOM_X_MARKER));
  const confirmedCustom = await executeNamed(customArgs, { surface: "mcp", confirmed: true }, customApp);
  check("the confirmed custom-root call reaches run", confirmedCustom.stage, "run");
  checkTrue("the CUSTOM root's hook ran (the selected root)", existsSync(CUSTOM_X_MARKER));
  checkTrue("the default root's hook never ran", !existsSync(DEFAULT_X_MARKER));
  await clearMarker(DEFAULT_X_MARKER);
  await clearMarker(CUSTOM_X_MARKER);

  // 9. The terminal surface's --json flag: parsed, and the JSON document emitted. Without
  // --json the terminal path logs to stderr; with it, the document goes to stdout only.
  const terminal = await execute(["run", "local", "read", "--json"], { surface: "terminal" });
  checkTrue("the parser accepts --json for run", terminal.error === undefined);
  check("a terminal --json run emits the JSON payload", terminal.json, { dryRun: false });
  // Uncaptured: --json emits the document on stdout; without it the terminal path keeps
  // the progress-style log line on stderr.
  const raw = (argv: string[]): Promise<string> => captureStderr(async () => { await executeCommand(app, "recipe", { kind: "argv", argv }, { surface: "terminal", transport: lock.ctx.transport }); });
  const plainStderr = await raw(["run", "local", "read"]);
  const jsonStderr = await raw(["run", "local", "read", "--json"]);
  checkTrue("without --json the terminal path keeps the log line", plainStderr.includes(["==>", "local", "run", "read:"].join(String.fromCharCode(32))) && !jsonStderr.includes(["local", "run", "read:"].join(String.fromCharCode(32))));
} finally {
  await rm(root, { recursive: true, force: true });
}
finish("recipe run-action");
