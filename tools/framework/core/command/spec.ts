// The declaration model of a command: arguments with typed values, an effect, phases.
//
// A body (commandBody / multiActionBody) is the implementation side: arguments, effect, the
// phases that run. An entry in a group file is `{ summary, group, details, ...BODY }`;
// materializeCommands turns each into a plain AppCommand, so every reader of AppCommand
// keeps working while the body stays reachable through specOf.

import { access, readFile } from "node:fs/promises";
import type { AppCommand, CommandArgument, CommandGroup } from "#src/core/app.ts";
import { argumentsView } from "#src/core/command/view.ts";
import { parseCall, type CallShape } from "#src/core/command/parse.ts";
import { shapeProfile, type EffectShape } from "#src/core/command/effect.ts";
import { serviceOf, type Context } from "#src/core/context.ts";
import { parseEnv, type Env } from "#src/core/env.ts";
import { deploymentDir, deploymentName, envFile } from "#src/runtime/deployment.ts";
import type { Transport } from "#src/runtime/transport/transport.ts";
import type { ValueParser } from "#src/core/values/value.ts";

/** What a call does to state: read < change < destroy. */
export type Effect = "read" | "change" | "destroy";
export type Needs = "deployment" | "target";

interface ArgumentBase<N extends string> {
  readonly name: N;
  /** The full help text. */
  readonly description: string;
  /** At most 60 characters, for the MCP schema; required when `description` is longer. */
  readonly summary?: string;
}

export interface FlagSpec<N extends string = string> extends ArgumentBase<N> {
  readonly kind: "flag";
  /** Raises the call's effect when the flag is given (`read` overrides it). */
  readonly effect?: Effect;
  /** Set by an MCP confirm: true instead of by the caller. */
  readonly setByConfirm?: true;
}

export interface ValueSpec<K extends "option" | "positional", N extends string = string, T = unknown> extends ArgumentBase<N> {
  readonly kind: K;
  /** Required on an option. */
  readonly valueName?: string;
  readonly required?: boolean;
  /** Mutually exclusive with `parse`. */
  readonly choices?: readonly string[];
  /** Neither `parse` nor `choices`: any non-empty string. */
  readonly parse?: ValueParser<T>;
}

export interface VariadicSpec<N extends string = string> extends ArgumentBase<N> {
  readonly kind: "variadic";
  readonly required?: boolean;
}

export type ArgumentSpec = FlagSpec | ValueSpec<"option"> | ValueSpec<"positional"> | VariadicSpec;

type ValueOf<A> = A extends { kind: "flag" } ? boolean
  : A extends { kind: "variadic" } ? readonly string[]
  : A extends { parse: ValueParser<infer T> } ? T
  : A extends { choices: readonly (infer C)[] } ? C : string;
type Absent<A> = A extends { kind: "flag" | "variadic" } | { required: true } ? never : undefined;

/** The values a call binds, by argument name. A flag is false and a variadic is [] when absent. */
export type Values<Args extends readonly ArgumentSpec[]> = {
  readonly [A in Args[number] as A["name"]]: ValueOf<A> | Absent<A>;
};

/** `action` is the typed word or the default action; `given` lists flags and options in typing order. */
export interface ParsedCall<V> {
  readonly values: V;
  readonly action?: string;
  readonly given: readonly string[];
}

/** What `prepare` may touch: no Context, Transport or Runtime. */
export interface LocalScope {
  deployment(): { readonly name: string; readonly dir: string };
  /** The .env as written, without validation or defaults. */
  env(): Promise<Env | undefined>;
  readText(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
}

export interface DeploymentScope extends LocalScope {
  readonly service: string;
  transport(): Promise<Transport>;
}

type On<N extends Needs> = N extends "deployment" ? DeploymentScope : Context;

interface Phases<V, P, N extends Needs> {
  /** Refusals that need only the arguments and local files; absent: the plan is `call.values`. */
  readonly prepare?: (call: ParsedCall<V>, local: LocalScope) => P | Promise<P>;
  readonly run: (on: On<N>, plan: P) => Promise<void>;
}

export interface SingleBody<A extends readonly ArgumentSpec[], P, N extends Needs> extends Phases<Values<A>, P, N> {
  readonly effect: Effect;
  /** Default "target". */
  readonly needs?: N;
  readonly arguments: A;
  readonly preparesEnvironment?: N extends "target" ? true : never;
}

export interface ActionSpec<A extends readonly ArgumentSpec[], P> extends Phases<Values<A>, P, "target"> {
  readonly summary: string;
  /** Absent: the body's effect. */
  readonly effect?: Effect;
  readonly arguments?: A;
}

/** The stamp on an erased body: the only way to read one back is through this module. */
export const COMMAND_SPEC: unique symbol = Symbol("clawforge.command-spec");

interface PhaseData {
  readonly prepare?: (call: ParsedCall<Record<string, unknown>>, local: LocalScope) => unknown;
  readonly run: (on: never, plan: never) => Promise<void>;
}
interface ActionData extends PhaseData {
  readonly kind: "action";
  readonly summary: string;
  readonly effect?: Effect;
  readonly arguments: readonly ArgumentSpec[];
}
interface SingleData extends PhaseData {
  readonly kind: "single";
  readonly effect: Effect;
  readonly needs: Needs;
  readonly arguments: readonly ArgumentSpec[];
  readonly preparesEnvironment: boolean;
}
interface MultiData {
  readonly kind: "multi";
  readonly effect: Effect;
  readonly action: { readonly description: string; readonly summary?: string };
  readonly actions: Readonly<Record<string, ActionData>>;
  readonly defaultAction?: string;
}

/** Erased: built by defineAction. */
export interface Action { readonly [COMMAND_SPEC]: ActionData }
/** Erased: built by commandBody / multiActionBody. */
export interface CommandBody { readonly [COMMAND_SPEC]: SingleData | MultiData }

export interface MultiBody {
  readonly effect: Effect;
  /** The positional action word. */
  readonly action: { readonly description: string; readonly summary?: string };
  /** Declaration order is the order of the word's choices. */
  readonly actions: Readonly<Record<string, Action>>;
  /** Without it the action word is required. */
  readonly defaultAction?: string;
}

/** A group-file entry: prose and flags of the command beside its body. */
export interface CommandEntry extends CommandBody, Pick<AppCommand, "details" | "structured" | "consoleOnly" | "exportsSecrets"> {
  readonly summary: string;
  readonly group: CommandGroup;
}

// --- structural checks, at module load ---------------------------------------------------------

/** A declaration that cannot be right; `problem` is a stable code, the message names the place. */
export class CommandDeclarationError extends Error {
  name = "CommandDeclarationError";
  readonly problem: string;
  constructor(problem: string, where: string, detail: string) {
    super(`invalid command declaration (${where}): ${detail}`);
    this.problem = problem;
  }
}

function fail(problem: string, where: string, detail: string): never {
  throw new CommandDeclarationError(problem, where, detail);
}

function checkArguments(where: string, args: readonly ArgumentSpec[]): void {
  const seen = new Set<string>();
  args.forEach((argument, index) => {
    const label = `argument ${argument.name}`;
    if (seen.has(argument.name)) fail("duplicate-name", where, `${label} is declared twice`);
    seen.add(argument.name);
    if (argument.kind === "variadic" && index !== args.length - 1) fail("variadic-not-last", where, `${label} is variadic but not last`);
    if (argument.kind !== "flag") {
      const loose = argument as { effect?: unknown; setByConfirm?: unknown };
      if (loose.effect !== undefined) fail("effect-not-flag", where, `${label} has an effect but is not a flag`);
      if (loose.setByConfirm !== undefined) fail("set-by-confirm-not-flag", where, `${label} is setByConfirm but not a flag`);
    }
    if (argument.kind === "option" || argument.kind === "positional") {
      if (argument.parse !== undefined && argument.choices !== undefined) fail("parse-with-choices", where, `${label} has both parse and choices`);
      if (argument.kind === "option" && argument.valueName === undefined) fail("option-without-value-name", where, `${label} is an option without a valueName`);
    }
  });
}

function phasesOf(source: { prepare?: unknown; run: unknown }): PhaseData {
  return { prepare: source.prepare, run: source.run } as unknown as PhaseData;
}

/** A single-action command's body. Structural mistakes throw here, when the module loads. */
export function commandBody<const A extends readonly ArgumentSpec[], P = Values<A>, N extends Needs = "target">(body: SingleBody<A, P, N>): CommandBody {
  const needs: Needs = body.needs ?? "target";
  checkArguments("command body", body.arguments);
  if (body.preparesEnvironment === true && needs !== "target") fail("prepares-environment-needs-target", "command body", "preparesEnvironment needs `needs: \"target\"`");
  const data: SingleData = {
    kind: "single", effect: body.effect, needs, arguments: body.arguments,
    preparesEnvironment: body.preparesEnvironment === true, ...phasesOf(body),
  };
  return { [COMMAND_SPEC]: data };
}

/** One action of a multi-action command. */
export function defineAction<const A extends readonly ArgumentSpec[], P = Values<A>>(action: ActionSpec<A, P>): Action {
  checkArguments(`action ${action.summary}`, action.arguments ?? []);
  const data: ActionData = {
    kind: "action", summary: action.summary, effect: action.effect, arguments: action.arguments ?? [], ...phasesOf(action),
  };
  return { [COMMAND_SPEC]: data };
}

/** A multi-action command's body: the actions in declaration order, an optional default. */
export function multiActionBody(body: MultiBody): CommandBody {
  const names = Object.keys(body.actions);
  if (names.length === 0) fail("no-actions", "multi-action body", "no actions");
  if (body.defaultAction !== undefined && !names.includes(body.defaultAction)) {
    fail("default-action-unknown", "multi-action body", `defaultAction ${body.defaultAction} is not one of ${names.join(", ")}`);
  }
  const actions = Object.fromEntries(names.map((name) => [name, body.actions[name][COMMAND_SPEC]]));
  const data: MultiData = { kind: "multi", effect: body.effect, action: body.action, actions, defaultAction: body.defaultAction };
  return { [COMMAND_SPEC]: data };
}

// --- reading a body back -------------------------------------------------------------------------

/** The internal data behind an erased body (for the view, the effect rules and the runner). */
export function specData(body: CommandBody): SingleData | MultiData {
  return body[COMMAND_SPEC];
}

/** The parse and effect shape of a body: arguments, or per-action arguments and effects. */
export function specShape(body: CommandBody): CallShape & EffectShape {
  const data = specData(body);
  if (data.kind === "single") return { effect: data.effect, arguments: data.arguments };
  return { effect: data.effect, actions: data.actions, defaultAction: data.defaultAction };
}

// --- running on a given context --------------------------------------------------------------------

/** The local, context-free view of the active deployment: its .env as written (no validation,
 *  no defaults), plain file reads. */
export function localScope(): LocalScope {
  const readText = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  return {
    deployment: () => ({ name: deploymentName(), dir: deploymentDir() }),
    env: async () => {
      const text = await readText(envFile());
      return text === undefined ? undefined : parseEnv(text);
    },
    readText,
    exists: async (path) => access(path).then(() => true, () => false),
  };
}

function deploymentScopeOn(ctx: Context): DeploymentScope {
  return { ...localScope(), service: serviceOf(ctx), transport: async () => ctx.transport };
}

/** Parse, prepare, run — on a context the caller already has: no environment preparation,
 *  no confirmation, no --json contract, exactly like calling the command's function directly. */
export async function runOnContext(body: CommandBody, ctx: Context, args: readonly string[], command = ""): Promise<void> {
  const data = specData(body);
  const call = parseCall(specShape(body), args, command);
  const phases: PhaseData = data.kind === "single" ? data : data.actions[call.action!];
  const plan = phases.prepare === undefined ? call.values : await phases.prepare(call, localScope());
  const on = data.kind === "single" && data.needs === "deployment" ? deploymentScopeOn(ctx) : ctx;
  await (phases.run as (on: unknown, plan: unknown) => Promise<void>)(on, plan);
}

// --- materialization -------------------------------------------------------------------------------

const materialized = new WeakMap<object, CommandEntry>();

/** The entry behind a command, only while its `run` is the materialized one: a spread keeps
 *  it, a replaced `run` drops it (the command is then read as a legacy one). */
export function specOf(command: AppCommand): CommandEntry | undefined {
  return materialized.get(command.run);
}

function faceOf(name: string, entry: CommandEntry): AppCommand {
  const data = specData(entry);
  const profile = shapeProfile(specShape(entry));
  const parts: readonly { effect?: Effect; arguments?: readonly ArgumentSpec[] }[] = data.kind === "single" ? [data] : Object.values(data.actions);
  const readOnly = parts.every((part) => (part.effect ?? data.effect) === "read"
    && (part.arguments ?? []).every((argument) => argument.kind !== "flag" || argument.effect === undefined || argument.effect === "read"));
  const run = (ctx: Context, args: string[]): Promise<void> => runOnContext(entry, ctx, args, name);
  const face: AppCommand = {
    summary: entry.summary,
    group: entry.group,
    ...(entry.details === undefined ? {} : { details: entry.details }),
    ...(entry.structured === undefined ? {} : { structured: entry.structured }),
    ...(entry.consoleOnly === undefined ? {} : { consoleOnly: entry.consoleOnly }),
    ...(entry.exportsSecrets === undefined ? {} : { exportsSecrets: entry.exportsSecrets }),
    ...(data.kind === "single" && data.preparesEnvironment ? { preparesEnvironment: true } : {}),
    ...(profile.destructive ? { destructive: true } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    arguments: argumentsView(entry) as CommandArgument[],
    run,
  };
  materialized.set(run, entry);
  return face;
}

/** One call per group object: an entry that carries a body becomes an AppCommand; an
 *  AppCommand (a legacy entry) passes through as the same object. */
export function materializeCommands(entries: Readonly<Record<string, AppCommand | CommandEntry>>): Record<string, AppCommand> {
  return Object.fromEntries(Object.entries(entries).map(([name, entry]) => [
    name,
    COMMAND_SPEC in entry ? faceOf(name, entry as CommandEntry) : entry as AppCommand,
  ]));
}
