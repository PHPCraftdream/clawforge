// How this process was invoked, for the commands its messages tell a user to run: the
// monorepo gate and the committed shim use the checkout spelling (SHIM_PROGRAM, render.ts);
// the system-wide command is plain `clawforge`, where the checkout spelling does not even
// run in cmd.exe or PowerShell. Entry points set it once, from the environment or their
// own default, before any command runs; the value is read everywhere through the
// accessors, never re-derived from strings.

import { SHIM_PROGRAM } from "./render.ts";

/** The invocation travels to child gate processes as versioned JSON (see serializeInvocation). */
export const INVOCATION_ENV = "CLAWFORGE_INVOCATION";
/** Legacy input: committed shims and launchers written before CLAWFORGE_INVOCATION exist in
 *  users' deployments and are read and mapped (parseLegacyInvokedAs), never written anymore. */
export const INVOKED_AS_ENV = "CLAWFORGE_INVOKED_AS";

export const INVOCATION_VERSION = 1;

export type InvocationMode = "checkout" | "installed" | "local-package";
export type AppSelection = "cwd" | "flag" | "env" | "sole" | "default";
export type InvocationAudience = "terminal" | "mcp";

export interface InvocationApp {
  readonly name: string;
  readonly selectedBy: AppSelection;
}

export interface Invocation {
  /** What the user actually types: the checkout spelling for the checkout gate and the
   *  committed shims, `clawforge` for the system-wide command — the monorepo MCP launcher
   *  names its shim two levels up, so this is a path, not only one of the two names. */
  readonly program: string;
  readonly mode: InvocationMode;
  readonly app?: InvocationApp;
  readonly audience: InvocationAudience;
}

let current: Invocation | undefined;

/** Set once per process, at the entry, before any command runs. */
export function setInvocation(value: Invocation): void {
  current = value;
}

export function invocation(): Invocation {
  return current ??= { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" };
}

export function serializeInvocation(value: Invocation): string {
  return JSON.stringify({ version: INVOCATION_VERSION, ...value });
}

const MODES: readonly InvocationMode[] = ["checkout", "installed", "local-package"];
const SELECTIONS: readonly AppSelection[] = ["cwd", "flag", "env", "sole", "default"];
const AUDIENCES: readonly InvocationAudience[] = ["terminal", "mcp"];

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict: malformed JSON, an unknown version, a wrong shape or an extra field reads as
 *  unset — the entry falls back to its own default, and never trusts half a value. */
export function parseInvocation(text: string): Invocation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!plainObject(parsed)) return undefined;
  const { version, program, mode, app, audience, ...extra } = parsed;
  if (
    version !== INVOCATION_VERSION ||
    typeof program !== "string" || program.trim() === "" ||
    typeof mode !== "string" || !MODES.includes(mode as InvocationMode) ||
    typeof audience !== "string" || !AUDIENCES.includes(audience as InvocationAudience) ||
    Object.keys(extra).length > 0
  ) return undefined;
  // Stored trimmed, like parseLegacyInvokedAs: an untrimmed program renders a broken line.
  const trimmed = program.trim();
  if (app === undefined) return { program: trimmed, mode: mode as InvocationMode, audience: audience as InvocationAudience };
  if (!plainObject(app)) return undefined;
  const { name, selectedBy, ...appExtra } = app;
  if (
    typeof name !== "string" || name.trim() === "" ||
    typeof selectedBy !== "string" || !SELECTIONS.includes(selectedBy as AppSelection) ||
    Object.keys(appExtra).length > 0
  ) return undefined;
  return { program: trimmed, mode: mode as InvocationMode, app: { name: name.trim(), selectedBy: selectedBy as AppSelection }, audience: audience as InvocationAudience };
}

/** A legacy CLAWFORGE_INVOKED_AS prefix mapped onto the value: a program path (the launcher's
 *  relative spelling included), optionally with the hand-written `--app <name>` suffix the old
 *  variable carried. The old variable never said how the deployment was picked; every writer
 *  spelled the suffix by hand for a selection the cwd would not repeat, so `flag`. The mode
 *  follows the program: the bare system-wide command is `installed`, everything else (a path
 *  into the checkout or a deployment) is `checkout`. */
export function parseLegacyInvokedAs(text: string): Invocation | undefined {
  const value = text.trim();
  if (value === "") return undefined;
  const suffix = /^(.*) --app (\S+)$/.exec(value);
  if (suffix === null || suffix[1].trim() === "") {
    // A value that is only a flag suffix, or one with internal spacing, is garbage a
    // hand-written variable picked up on the way: it reads as unset, like the strict parse.
    if (value.startsWith("--") || /\s/.test(value)) return undefined;
    return { program: value, mode: value === "clawforge" ? "installed" : "checkout", audience: "terminal" };
  }
  const program = suffix[1].trim();
  // The same rule for the program of a suffixed value: "--app x --app y" is not a path.
  if (program.startsWith("--") || /\s/.test(program)) return undefined;
  return { program, mode: program === "clawforge" ? "installed" : "checkout", app: { name: suffix[2], selectedBy: "flag" }, audience: "terminal" };
}

/** Reads the invocation a parent handed over and removes both variables, so descendants
 *  never inherit them. The new variable wins when both are set; a value that fails the
 *  strict parse, or an unset/blank variable pair, reads as unset. */
export function takeInvocationFromEnv(): Invocation | undefined {
  const handed = process.env[INVOCATION_ENV];
  const legacy = process.env[INVOKED_AS_ENV];
  delete process.env[INVOCATION_ENV];
  delete process.env[INVOKED_AS_ENV];
  if (handed !== undefined && handed.trim() !== "") {
    const parsed = parseInvocation(handed);
    if (parsed !== undefined) return parsed;
  }
  return parseLegacyInvokedAs(legacy ?? "");
}
