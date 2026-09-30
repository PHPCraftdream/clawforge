// How this process was invoked, for the commands its messages tell a user to run: the
// monorepo gate and the committed shim are `./clawforge`; the system-wide command is
// `clawforge` (and `./clawforge` does not even run in cmd.exe or PowerShell). Entry points
// set it before any command runs; everything renders at call time, never in constants.

/** Set by the committed shim; read and removed by the entry, so descendants never inherit it. */
export const INVOKED_AS_ENV = "CLAWFORGE_INVOKED_AS";

const MONOREPO_PREFIX = "./clawforge";
let prefix = MONOREPO_PREFIX;

/** Sets the prefix hints are rendered with, e.g. `clawforge` or `./clawforge --app staging`. */
export function setInvocation(value: string): void {
  prefix = value.trim() === "" ? MONOREPO_PREFIX : value.trim();
}

export function invocation(): string {
  return prefix;
}

/** Reads and clears the env var; undefined when unset or blank. */
export function takeInvokedAs(): string | undefined {
  const value = process.env[INVOKED_AS_ENV]?.trim();
  delete process.env[INVOKED_AS_ENV];
  return value === undefined || value === "" ? undefined : value;
}

/** A command hint: `cli("bootstrap --check")` is `clawforge bootstrap --check` or `./clawforge …`. */
export function cli(rest: string): string {
  return rest === "" ? prefix : `${prefix} ${rest}`;
}

// A bare `./clawforge` word: not part of a path, an escaped regex, or a quoted argv element
// (`'./clawforge'` is a real command line, not a hint).
const HINT = /(?<![\w./\\'-])\.\/clawforge(?![\w/'"-])/g;

/** Rewrites the `./clawforge` hints already written into a message to this invocation.
 *  Identity under the default prefix. A hint that names its own `--app` keeps that one. */
export function localizeHints(text: string): string {
  if (prefix === MONOREPO_PREFIX || !text.includes(MONOREPO_PREFIX)) return text;
  const bare = prefix.replace(/ --app \S+$/, "");
  return text.replace(HINT, (match, offset: number, whole: string) =>
    whole.startsWith(" --app ", offset + match.length) ? bare : prefix,
  );
}
