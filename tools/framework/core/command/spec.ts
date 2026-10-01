// The declaration model of a command: arguments with typed values, an effect, phases.
// Types only; the declaring helpers and the materialization build on them.

import type { Context } from "#src/core/context.ts";
import type { Env } from "#src/core/env.ts";
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

declare const SPEC_BRAND: unique symbol;
/** Erased bodies: built by the declaring helpers, read back only through this module's functions. */
export interface Action { readonly [SPEC_BRAND]: "action" }
export interface CommandBody { readonly [SPEC_BRAND]: "body" }

export interface MultiBody {
  readonly effect: Effect;
  /** The positional action word. */
  readonly action: { readonly description: string; readonly summary?: string };
  /** Declaration order is the order of the word's choices. */
  readonly actions: Readonly<Record<string, Action>>;
  /** Without it the action word is required. */
  readonly defaultAction?: string;
}
