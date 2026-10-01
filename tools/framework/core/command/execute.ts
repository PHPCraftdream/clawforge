// The one execution pipeline for the console and MCP: parse → confirm → prepare →
// environment → context → run. Every stage's failure is returned (never thrown) as an
// Execution, so a surface decides how to report it; the terminal `--json` failure document
// (entry/cli.ts's former reportJsonFailure) is emitted here, once for both surfaces' caller.
//
// Not re-exported from core/command/index.ts: this file pulls the runtime and integration
// layers (context, transport, environment provisioning), which the declaration model must not.

import type { AppCommand, AppDefinition } from "#src/core/app.ts";
import { callFacts, callFactsFor, legacyPreparesEnvironment, type CallFacts, type EffectShape } from "#src/core/command/effect.ts";
import { ConfirmationRequiredError, UnknownArgumentError } from "#src/core/command/errors.ts";
import { parseCall } from "#src/core/command/parse.ts";
import { localScope, specData, specOf, specShape, type DeploymentScope, type ParsedCall } from "#src/core/command/spec.ts";
import { createContext, type Context, type ContextOptions } from "#src/core/context.ts";
import { maskSecrets, UserError } from "#src/core/io/log.ts";
import { emit, machineWritesCount, stdoutBytesWritten } from "#src/core/io/output.ts";
import { useApplicationRecipesDir, envFile } from "#src/runtime/deployment.ts";
import { createTransport, type Transport } from "#src/runtime/transport/transport.ts";
import { clearRecipesDir } from "#src/service/recipe.ts";
import { ensureEnvironment } from "#src/integration/provision.ts";

/** How and by whom a command is run. */
export interface CommandIo {
  readonly surface: "terminal" | "mcp";
  /** MCP: the call carried confirm: true. */
  readonly confirmed?: boolean;
  /** Checks' seam, the way ContextOptions.transport is: stands in for the transport both
   *  createContext and the deployment scope would otherwise build. */
  readonly transport?: Transport;
}

/** Where a call stopped: parse → confirm → prepare → environment → context → run. */
export type Stage = "parse" | "confirm" | "prepare" | "environment" | "context" | "run";

/** A returned failure: which stage refused, with what. `facts` is set from the confirm
 *  stage on, for the MCP envelope. */
export interface Execution {
  readonly stage: Stage;
  readonly error?: unknown;
  readonly facts?: CallFacts;
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

function jsonRequested(argv: readonly string[]): boolean {
  const sep = argv.indexOf("--");
  return (sep === -1 ? argv : argv.slice(0, sep)).includes("--json");
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
 *  the caller. A legacy command (no spec) runs exactly as before: argv as is, its own
 *  predicates deciding environment preparation. */
export async function executeCommand(app: AppDefinition, name: string, argv: readonly string[], io: CommandIo): Promise<Execution> {
  const command = app.commands[name]!;
  const entry = specOf(command);
  const writesAtStart = machineWritesCount();
  const stdoutAtStart = stdoutBytesWritten();

  // Terminal `--json` failure contract: a command invoked with its own declared --json flag
  // that fails still prints a machine-readable answer, unless it already printed (or
  // streamed) something of its own. Never for an argument error — that is reported as such.
  const failed = (stage: Stage, error: unknown, facts?: CallFacts, shape?: EffectShape, action?: string): Execution => {
    if (io.surface === "terminal" && !(error instanceof UnknownArgumentError)
      && declaresJsonFlag(command, shape, action)
      && jsonRequested(argv)
      && machineWritesCount() === writesAtStart && stdoutBytesWritten() === stdoutAtStart) {
      const message = maskSecrets(error instanceof Error ? error.message : String(error));
      emit(`${JSON.stringify({ error: { message } }, null, 2)}\n`);
    }
    return { stage, error, ...(facts === undefined ? {} : { facts }) };
  };

  if (entry !== undefined) {
    const shape = specShape(entry);
    let call: ParsedCall<Record<string, unknown>>;
    try {
      call = parseCall(shape, argv, name);
    } catch (error) {
      return failed("parse", error);
    }
    const facts = callFacts(shape, call);
    if (io.surface === "mcp" && facts.effect === "destroy" && io.confirmed !== true) {
      return failed("confirm", new ConfirmationRequiredError(name), facts, shape, call.action);
    }
    const data = specData(entry);
    const phases = data.kind === "single" ? data : data.actions[call.action!];
    let plan: unknown;
    try {
      useApplicationRecipesDir(app.recipesDir);
      clearRecipesDir();
      plan = phases.prepare === undefined ? call.values : await phases.prepare(call, localScope());
    } catch (error) {
      return failed("prepare", error, facts, shape, call.action);
    }
    try {
      if (data.kind === "single" && data.preparesEnvironment && facts.effect !== "read") await ensureEnvironment();
    } catch (error) {
      return failed("environment", error, facts, shape, call.action);
    }
    let on: Context | DeploymentScope;
    try {
      on = data.kind === "single" && data.needs === "deployment"
        ? await deploymentScope(app, io)
        : await createContext(contextOptions(app, io));
    } catch (error) {
      return failed("context", error, facts, shape, call.action);
    }
    try {
      await (phases.run as (on: unknown, plan: unknown) => Promise<void>)(on, plan);
    } catch (error) {
      return failed("run", error, facts, shape, call.action);
    }
    return { stage: "run", facts };
  }

  const facts = callFactsFor(command, [...argv]);
  if (io.surface === "mcp" && facts.effect === "destroy" && io.confirmed !== true) {
    return failed("confirm", new ConfirmationRequiredError(name), facts);
  }
  try {
    useApplicationRecipesDir(app.recipesDir);
    clearRecipesDir();
  } catch (error) {
    return failed("prepare", error, facts);
  }
  try {
    // Only a mutating call prepares: legacyPreparesEnvironment also refuses argv the
    // command's own parser would reject, before anything is written.
    if (legacyPreparesEnvironment(command, [...argv])) await ensureEnvironment();
  } catch (error) {
    return failed("environment", error, facts);
  }
  let ctx: Context;
  try {
    ctx = await createContext(contextOptions(app, io));
  } catch (error) {
    return failed("context", error, facts);
  }
  try {
    await command.run(ctx, [...argv]);
  } catch (error) {
    return failed("run", error, facts);
  }
  return { stage: "run", facts };
}
