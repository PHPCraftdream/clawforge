// The one execution pipeline for the console and MCP: parse → confirm → prepare →
// environment → context → run. Every stage's failure is returned (never thrown) as an
// Execution, so a surface decides how to report it; the terminal `--json` failure document
// (entry/cli.ts's former reportJsonFailure) is emitted here, once for both surfaces' caller.
//
// Not re-exported from core/command/index.ts: this file pulls the runtime and integration
// layers (context, transport, environment provisioning), which the declaration model must not.

import type { AppCommand, AppDefinition } from "#src/core/app.ts";
import { callFacts, callFactsFor, legacyPreparesEnvironment, type CallFacts, type EffectShape } from "#src/core/command/effect.ts";
import { ArgumentError, ConfirmationRequiredError, LateArgumentError, UnknownArgumentError } from "#src/core/command/errors.ts";
import { bindNamed, isVerbatim, parseCall, selectAction, tokenize, type CallInput, type CallShape } from "#src/core/command/parse/index.ts";
import { localScope, preparedPlan, specData, specOf, specShape, unitNeeds, type DeploymentScope, type LocalScope, type ParsedCall } from "#src/core/command/spec.ts";
import { createContext, type Context, type ContextOptions } from "#src/core/context.ts";
import { maskSecrets, UserError, CommandFailedError } from "#src/core/io/log.ts";
import { renderCurrentAdviceRows } from "#src/core/io/invocation/render.ts";
import { emit, machineWritesCount, stdoutBytesWritten } from "#src/core/io/output.ts";
import { useApplicationRecipesDir, envFile } from "#src/runtime/deployment.ts";
import { createTransport, type Transport } from "#src/runtime/transport/transport.ts";
import { clearRecipesDir } from "#src/service/recipe.ts";
import { ensureEnvironment, provisioningWrote } from "#src/integration/provision.ts";

/** How and by whom a command is run. */
export interface CommandIo {
  readonly surface: "terminal" | "mcp";
  /** MCP: the call carried confirm: true. */
  readonly confirmed?: boolean;
  /** Checks' seam, the way ContextOptions.transport is: stands in for the transport both
   *  createContext and the deployment scope would otherwise build. */
  readonly transport?: Transport;
  readonly observe?: (stage: Stage) => void;
}

/** Where a call stopped: parse → confirm → prepare → environment → context → run. */
export type Stage = "parse" | "confirm" | "prepare" | "environment" | "context" | "run";

/** A returned failure: which stage refused, with what. `facts` is set from the confirm
 *  stage on, for the MCP envelope. */
export interface Execution {
  readonly stage: Stage;
  readonly error?: unknown;
  readonly facts?: CallFacts;
  readonly reachedRun: boolean;
  readonly environmentWrote?: boolean;
  readonly exitCode?: number;
}

/** The deployment scope `needs: "deployment"` commands run on: the local view plus the
 *  service name and a transport selected from the .env location settings — no Settings
 *  parse, no Context (recover-env exists to repair the facts a Context is built from). */
export async function deploymentScope(app: AppDefinition, io: CommandIo): Promise<DeploymentScope> {
  const local = localScope();
  const env = await local.env();
  if (env === undefined) throw new UserError(`${envFile()} does not exist`);
  const transport = io.transport ?? await createTransport({
    location: env.OC_TARGET_LOCATION,
    wslDistro: env.OC_WSL_DISTRO,
    sshHost: env.OC_SSH_HOST,
  });
  return { ...local, service: app.service?.name ?? "app", transport: async () => transport };
}

/** Whether the call selects a declared `json` flag: on a spec command the chosen action's
 *  own arguments, on a legacy command the flat declaration (the contract's original gate). */
function declaresJsonFlag(command: AppCommand, shape: EffectShape | undefined, action: string | undefined): boolean {
  const has = (args: readonly { readonly name: string; readonly kind: string }[] | undefined): boolean =>
    args?.some((argument) => argument.name === "json" && argument.kind === "flag") === true;
  if (shape === undefined || shape.actions === undefined) {
    return has(shape?.arguments ?? command.arguments);
  }
  return action === undefined ? false : has(shape.actions[action]?.arguments);
}

/** The legacy AppCommand path's json decision: the tokenizer over the flat declaration —
 *  a `--json` an option swallows as its value does not request the document, and a
 *  tokenizer refusal means the parser refuses the call, so json is never bound either. */
function legacyJsonGiven(command: AppCommand, argv: readonly string[]): boolean {
  try {
    return tokenize(command.arguments ?? [], argv).given.includes("json");
  } catch {
    return false;
  }
}

/** The pre-parse stand-in for a parsed call's `given`: the real tokenizer (parse.ts's
 *  tokenize, bound to the action selectAction would choose and the same verbatim-tail
 *  decision) over the raw argv — so an option's value (`--interval --json`), a repeated
 *  option (`--profile full --profile --json`), `--opt=value --json` and a post-`--` token
 *  read exactly as the parser reads them. A tokenizer refusal means the parser stops
 *  before `--json`, so it would not bind it. */
function jsonTokenGiven(shape: CallShape & EffectShape, argv: readonly string[]): boolean {
  try {
    const chosen = selectAction(shape, { kind: "argv", argv });
    const declared = chosen.slice;
    const action = chosen.selected.name;
    // Deliberately no `refuse` here: the probe reads what the tokenizer binds, not what the
    // declaration refuses ahead of tokenizing.
    const tokens = tokenize(declared, chosen.rest, action === undefined ? undefined : { action, siblings: chosen.siblings }, isVerbatim(declared));
    return tokens.given.includes("json");
  } catch {
    return false;
  }
}

/** Deep-masks a JSON-ready value — strings and keys — the way the MCP envelope masks its
 *  own, so a secret that reached an advice argv cannot ride the failure document out. */
function maskedJson(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (Array.isArray(value)) return value.map(maskedJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[maskSecrets(key)] = maskedJson(entry);
    return out;
  }
  return value;
}

/** The context both spec and legacy target commands run on: built here, not by the command —
 *  an application never constructs a transport itself. */
function contextOptions(app: AppDefinition, io: CommandIo): ContextOptions {
  return {
    mounts: app.mounts,
    service: app.service,
    settings: app.settings,
    secrets: app.secrets,
    afterBackup: app.afterBackup,
    beforeRestore: app.beforeRestore,
    transport: io.transport,
  };
}

/** The one pipeline. Precondition: `app.commands[name]` exists and `--help` was handled by
 *  the caller. Takes a CallInput: the console passes {kind:"argv"}, an MCP tool call
 *  {kind:"named"}. A legacy command (no spec) runs exactly as before: argv as is, its own
 *  predicates deciding environment preparation. */
export async function executeCommand(app: AppDefinition, name: string, input: CallInput, io: CommandIo): Promise<Execution> {
  const command = app.commands[name]!;
  const entry = specOf(command);
  const writesAtStart = machineWritesCount();
  const stdoutAtStart = stdoutBytesWritten();

  // Terminal `--json` failure contract: a command invoked with its own declared --json flag
  // that fails still prints a machine-readable answer, unless it already printed (or
  // streamed) something of its own. Never for an unknown-argument error — that is reported as such.
  let environmentWrote = false;
  const failed = (stage: Stage, error: unknown, facts?: CallFacts, shape?: EffectShape, action?: string, jsonGiven?: boolean): Execution => {
    io.observe?.(stage);
    environmentWrote ||= provisioningWrote(error);
    if (io.surface === "terminal" && !(error instanceof UnknownArgumentError)
      && declaresJsonFlag(command, shape, action)
      && (jsonGiven ?? false)
      && machineWritesCount() === writesAtStart && stdoutBytesWritten() === stdoutAtStart) {
      const message = maskSecrets(error instanceof Error ? error.message : String(error));
      // The refusal's remedy travels as data (rf6-fix30): the advice a UserError carries is
      // the success documents' `next`, nextActions its rendered form. Masked like the message.
      const advice = error instanceof UserError ? error.advice : [];
      emit(`${JSON.stringify({
        error: { message },
        ...(advice.length === 0 ? {} : {
          nextActions: [...new Set(advice.flatMap(renderCurrentAdviceRows).map(maskSecrets))],
          next: advice.map(maskedJson),
        }),
      }, null, 2)}\n`);
    }
    return { stage, error, reachedRun: stage === "run", ...(stage === "run" && error instanceof CommandFailedError ? { exitCode: error.exitCode } : {}), ...(environmentWrote ? { environmentWrote: true } : {}), ...(facts === undefined ? {} : { facts }) };
  };

  if (entry !== undefined) {
    const shape = specShape(entry);
    let call: ParsedCall<Record<string, unknown>>;
    try {
      call = input.kind === "argv" ? parseCall(shape, input.argv, name) : bindNamed(shape, input, name, { confirmed: io.confirmed === true });
    } catch (error) {
      return failed("parse", error, undefined, undefined, undefined, input.kind === "argv" ? jsonTokenGiven(shape, input.argv) : false);
    }
    const facts = callFacts(shape, call);
    io.observe?.("parse");
    if (io.surface === "mcp" && facts.effect === "destroy" && io.confirmed !== true) {
      return failed("confirm", new ConfirmationRequiredError(name), facts, shape, call.action, call.given.includes("json"));
    }
    io.observe?.("confirm");
    const data = specData(entry);
    const phases = data.kind === "single" ? data : data.actions[call.action!];
    let plan: unknown;
    try {
      useApplicationRecipesDir(app.recipesDir);
      clearRecipesDir();
      const slice = data.kind === "single" ? data : data.actions[call.action!];
      plan = await preparedPlan(slice, call);
    } catch (error) {
      return failed("prepare", error, facts, shape, call.action, call.given.includes("json"));
    }
    io.observe?.("prepare");
    const needs = unitNeeds(data, call.action);
    try {
      if (data.kind === "single" && data.preparesEnvironment && needs === "target" && facts.effect !== "read") environmentWrote = (await ensureEnvironment()).wrote;
    } catch (error) {
      return failed("environment", error, facts, shape, call.action, call.given.includes("json"));
    }
    io.observe?.("environment");
    // Needs are the selected unit's own: `local` stops after prepare — no .env parse, no
    // transport, no Context; the recipes directory was already selected above.
    let on: Context | DeploymentScope | LocalScope;
    try {
      on = needs === "deployment"
        ? await deploymentScope(app, io)
        : needs === "local"
          ? localScope()
          : await createContext(contextOptions(app, io));
    } catch (error) {
      return failed("context", error, facts, shape, call.action, call.given.includes("json"));
    }
    io.observe?.("run");
    try {
      await (phases.run as (on: unknown, plan: unknown) => Promise<void>)(on, plan);
    } catch (error) {
      // A run phase cannot build an ArgumentError (the token is private to core/command) —
      // one reaching here escaped through a nested runOnContext: an invariant breach, raised
      // as the LateArgumentError, text preserved, stage still "run".
      return failed("run", error instanceof ArgumentError && !(error instanceof LateArgumentError) ? new LateArgumentError(error) : error, facts, shape, call.action, call.given.includes("json"));
    }
    return { stage: "run", facts, reachedRun: true, ...(environmentWrote ? { environmentWrote: true } : {}) };
  }

  // Zero legacy commands ship today; a named call reaching one is an invariant breach, not
  // a refusal, so it throws rather than returning an Execution.
  const argv = input.kind === "argv" ? input.argv : (() => { throw new Error("a legacy command cannot take a named call"); })();
  const facts = callFactsFor(command, [...argv]);
  if (io.surface === "mcp" && facts.effect === "destroy" && io.confirmed !== true) {
    return failed("confirm", new ConfirmationRequiredError(name), facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  try {
    useApplicationRecipesDir(app.recipesDir);
    clearRecipesDir();
  } catch (error) {
    return failed("prepare", error, facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  io.observe?.("prepare");
  try {
    // Only a mutating call prepares: legacyPreparesEnvironment also refuses argv the
    // command's own parser would reject, before anything is written.
    if (legacyPreparesEnvironment(command, [...argv])) environmentWrote = (await ensureEnvironment()).wrote;
  } catch (error) {
    return failed("environment", error, facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  io.observe?.("environment");
  let ctx: Context;
  try {
    ctx = await createContext(contextOptions(app, io));
  } catch (error) {
    return failed("context", error, facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  io.observe?.("run");
  try {
    await command.run(ctx, [...argv]);
  } catch (error) {
    return failed("run", error instanceof ArgumentError && !(error instanceof LateArgumentError) ? new LateArgumentError(error) : error, facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  return { stage: "run", facts, reachedRun: true, ...(environmentWrote ? { environmentWrote: true } : {}) };
}
