// Materialization: a group entry `{ summary, group, details, ...BODY }` becomes an ordinary
// AppCommand, the body stays reachable through specOf only while `run` is the materialized one,
// runOnContext parses -> prepares -> runs on the context it is given, and the structural mistakes
// of a declaration throw when its module loads. Plus the spec paths of callFactsFor / effectProfile.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import { setsCommands } from "#framework/commands/interface/groups/openclawCommands.sets.ts";
import type { AppCommand } from "#framework/core/app.ts";
import {
  ArgumentError, CommandDeclarationError, UnknownActionError, callFactsFor, commandBody, defineAction, effectProfile, materializeCommands,
  multiActionBody, runOnContext, specOf, type ArgumentSpec, type DeploymentScope,
} from "#framework/core/command/index.ts";
import type { Context } from "#framework/core/context.ts";
import { countValue } from "#framework/core/values/value.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const calls: string[] = [];
const ctx = { transport: { description: "stub" } } as unknown as Context;

const ARGS = [
  { name: "n", kind: "option", valueName: "n", parse: countValue(), description: "d" },
  { name: "dry-run", kind: "flag", effect: "read", description: "d" },
  { name: "wipe", kind: "flag", effect: "destroy", description: "d" },
] as const satisfies readonly ArgumentSpec[];

const SINGLE = commandBody({
  effect: "change",
  arguments: ARGS,
  prepare: ({ values }) => {
    calls.push("prepare");
    if (values.n === 13) throw new ArgumentError("unlucky", "n");
    return { doubled: (values.n ?? 0) * 2 };
  },
  run: async (_on, plan) => {
    calls.push(`run ${plan.doubled}`);
  },
});

const MULTI = multiActionBody({
  effect: "read",
  action: { description: "the action" },
  defaultAction: "show",
  actions: {
    show: defineAction({ summary: "show", run: async () => { calls.push("show"); } }),
    purge: defineAction({
      summary: "purge", effect: "destroy",
      arguments: [{ name: "dry-run", kind: "flag", effect: "read", description: "d" }, { name: "target", kind: "positional", required: true, description: "d" }],
      prepare: ({ action, values }) => { calls.push(`prepare ${action}`); return values.target; },
      run: async (_on, target) => { calls.push(`purge ${target}`); },
    }),
  },
});

let sawScope: DeploymentScope | undefined;
const DEPLOYMENT = commandBody({
  effect: "change", needs: "deployment", arguments: [],
  run: async (scope) => { sawScope = scope; },
});

const LEGACY: AppCommand = { summary: "old", group: "change", run: async () => {}, destructive: true, readOnlyWhen: (args) => args.includes("--dry-run") };

const commands = materializeCommands({
  single: { summary: "one", group: "change", details: "more", structured: true, exportsSecrets: true, ...SINGLE },
  multi: { summary: "many", group: "save-move", consoleOnly: true, ...MULTI },
  deployment: { summary: "dep", group: "low-level", ...DEPLOYMENT },
  prep: { summary: "prep", group: "start-stop", ...commandBody({ effect: "change", preparesEnvironment: true, arguments: [], run: async () => {} }) },
  legacy: LEGACY,
});

// --- the AppCommand face -------------------------------------------------------------------------------

check("a legacy entry passes through as the same object", commands.legacy === LEGACY, true);
check("a legacy entry has no spec", specOf(commands.legacy), undefined);
check("prose and flags come from the entry", [commands.single.summary, commands.single.group, commands.single.details, commands.single.structured, commands.single.exportsSecrets], ["one", "change", "more", true, true]);
check("consoleOnly comes from the entry", commands.multi.consoleOnly, true);
check("a single body's arguments are shown as declared", commands.single.arguments, ARGS);
check("a multi-action body's arguments are the derived view", commands.multi.arguments?.map((argument) => argument.name), ["action", "target", "dry-run"]);
check("the view marks the dry-run flag as purge's", commands.multi.arguments?.find((argument) => argument.name === "dry-run")?.actions, ["purge"]);
check("no argv predicates and no forceOnConfirmation on the face", ["readOnlyWhen", "changedWhen", "requiresConfirmationWhen", "forceOnConfirmation"].filter((key) => key in commands.single || key in commands.multi), []);
check("preparesEnvironment comes from the body", [commands.prep.preparesEnvironment, commands.single.preparesEnvironment], [true, undefined]);
check("a body that can destroy is destructive for outside readers", [commands.single.destructive, commands.multi.destructive, commands.deployment.destructive], [true, true, undefined]);
check("a body that only reads is readOnly for outside readers", [commands.multi.readOnly, commands.single.readOnly], [undefined, undefined]);
check(
  "readOnly: every part reads and no flag raises",
  materializeCommands({ r: { summary: "r", group: "check", ...commandBody({ effect: "read", arguments: [], run: async () => {} }) } }).r.readOnly,
  true,
);

// --- specOf ------------------------------------------------------------------------------------------------

checkTrue("specOf finds a materialized command", specOf(commands.single) !== undefined);
check("and returns its entry", specOf(commands.single)?.summary, "one");
const spread = { ...commands.single, summary: "other" };
check("a spread keeps the spec (the symbol key is copied)", specOf(spread)?.summary, "one");
const replaced = { ...commands.single, run: async () => {} };
check("replacing run drops it", specOf(replaced), undefined);
check("a framework command that is still legacy has none", specOf(openclawCommands.up), undefined);

// --- structural errors at load ---------------------------------------------------------------------------------

/** The stable code of the declaration error `declare` throws; "" when it loads. */
function loadError(declare: () => unknown): string {
  try {
    declare();
  } catch (error) {
    return error instanceof CommandDeclarationError ? error.problem : `not a declaration error: ${(error as Error).message}`;
  }
  return "";
}
const run = async (): Promise<void> => {};
const bad = (arguments_: readonly unknown[]) => () => commandBody({ effect: "read", arguments: arguments_ as readonly ArgumentSpec[], run });
const flag = (name: string, extra: object = {}) => ({ name, kind: "flag", description: "d", ...extra });
const option = (name: string, extra: object = {}) => ({ name, kind: "option", valueName: "v", description: "d", ...extra });

check("a name declared twice", loadError(bad([flag("a"), option("a")])), "duplicate-name");
check("a variadic that is not last", loadError(bad([{ name: "rest", kind: "variadic", description: "d" }, flag("a")])), "variadic-not-last");
check("two variadics", loadError(bad([{ name: "r1", kind: "variadic", description: "d" }, { name: "r2", kind: "variadic", description: "d" }])), "variadic-not-last");
check("an effect on an option", loadError(bad([option("a", { effect: "read" })])), "effect-not-flag");
check("setByConfirm on an option", loadError(bad([option("a", { setByConfirm: true })])), "set-by-confirm-not-flag");
check("parse together with choices", loadError(bad([option("a", { parse: countValue(), choices: ["x"] })])), "parse-with-choices");
check("an option without a valueName", loadError(bad([{ name: "a", kind: "option", description: "d" }])), "option-without-value-name");
check("preparesEnvironment without target", loadError(() => commandBody({ effect: "change", needs: "deployment", preparesEnvironment: true as never, arguments: [], run })), "prepares-environment-needs-target");
check("a defaultAction outside the actions", loadError(() => multiActionBody({ effect: "read", action: { description: "x" }, defaultAction: "nope", actions: { a: defineAction({ summary: "a", run }) } })), "default-action-unknown");
check("a duplicate inside an action", loadError(() => defineAction({ summary: "a", arguments: [flag("x"), flag("x")] as unknown as readonly ArgumentSpec[], run })), "duplicate-name");
check("a multi-action body with no actions", loadError(() => multiActionBody({ effect: "read", action: { description: "x" }, actions: {} })), "no-actions");
check("a good declaration does not throw", loadError(bad([flag("a"), option("b"), { name: "rest", kind: "variadic", description: "d" }])), "");

// --- runOnContext ----------------------------------------------------------------------------------------------------

await runOnContext(SINGLE, ctx, ["--n", "4"]);
check("parse, then prepare, then run with the plan", calls.splice(0), ["prepare", "run 8"]);

for (const [label, argv, expected] of [
  ["a parse refusal reaches neither prepare nor run", ["--n", "x"], []],
  ["a prepare refusal reaches no run", ["--n", "13"], ["prepare"]],
] as const) {
  const error = await runOnContext(SINGLE, ctx, [...argv]).then(() => undefined, (caught: unknown) => caught);
  check(label, [error instanceof ArgumentError, calls.splice(0)], [true, expected]);
}
check("the refused argument is named", (await runOnContext(SINGLE, ctx, ["--n", "13"]).catch((error: ArgumentError) => error.argument)), "n");
calls.length = 0;

await runOnContext(MULTI, ctx, []);
await runOnContext(MULTI, ctx, ["purge", "x", "--dry-run"]);
check("an action word picks the action's own prepare and run; none takes the default", calls.splice(0), ["show", "prepare purge", "purge x"]);
check("an unknown action is refused before anything runs", [(await runOnContext(MULTI, ctx, ["zap"]).catch((error: unknown) => error)) instanceof UnknownActionError, calls], [true, []]);
check("the face's run is runOnContext", await commands.single.run(ctx, ["--n", "1"]).then(() => calls.splice(0)), ["prepare", "run 2"]);
check("and names the command in a refusal", (await commands.multi.run(ctx, ["purge"]).catch((error: Error) => error.message)), "multi purge needs <target>");
calls.length = 0;

await runOnContext(DEPLOYMENT, ctx, []);
check("needs: deployment runs on a scope, not the context", [sawScope?.service, typeof sawScope?.transport, (sawScope as unknown) === ctx], ["app", "function", false]);
check("whose transport is the context's", await sawScope?.transport(), ctx.transport);

// --- the spec paths of callFactsFor and effectProfile -----------------------------------------------------------------

check("a body's base effect", callFactsFor(commands.single, []), { effect: "change" });
check("a read flag wins", callFactsFor(commands.single, ["--dry-run", "--wipe"]).effect, "read");
check("a destroy flag raises", callFactsFor(commands.single, ["--wipe"]).effect, "destroy");
check("a refused argv throws instead of guessing", await Promise.resolve().then(() => callFactsFor(commands.single, ["--n", "x"])).catch((error: ArgumentError) => error.argument), "n");
check("an action's own effect", [callFactsFor(commands.multi, []).effect, callFactsFor(commands.multi, ["purge", "x"]).effect], ["read", "destroy"]);
check("an action's read flag", callFactsFor(commands.multi, ["purge", "x", "--dry-run"]).effect, "read");
check("a spec command has no changedWhen, so no `changed`", callFactsFor(commands.multi, ["purge", "x"]).changed, undefined);
check("profile: destructive through a flag", effectProfile(commands.single), { destructive: true, alwaysDestroys: false, byAction: false });
check("profile: by action, destructive through an action", effectProfile(commands.multi), { destructive: true, alwaysDestroys: false, byAction: true });
check("profile: a body with nothing destructive", effectProfile(commands.deployment), { destructive: false, alwaysDestroys: false, byAction: false });
check("a legacy command still takes the legacy path", [callFactsFor(commands.legacy, ["--dry-run"]).effect, callFactsFor(commands.legacy, []).effect, effectProfile(commands.legacy)], ["read", "destroy", { destructive: true, alwaysDestroys: false, byAction: false }]);
check("the real set command is still legacy, with its own predicates", [specOf(setsCommands.set), callFactsFor(setsCommands.set, ["try"]).effect], [undefined, "destroy"]);

finish("materialization");
