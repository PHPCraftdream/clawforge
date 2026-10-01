// The advice a message or an error hands the user: one command to run, a line for
// another shell, or a manual step. Data only — rendering lives in render.ts.

export type Shell = "posix" | "cmd" | "pwsh";

export interface CommandAdvice {
  readonly kind: "clawforge";
  /** The command word and its arguments, WITHOUT the program and without `--app`; an
   *  explicit deployment is `app` instead. */
  readonly argv: readonly string[];
  readonly app?: string;
  readonly note?: string;
}

export interface ShellAdvice {
  readonly kind: "shell";
  readonly shell: Shell;
  readonly text: string;
  readonly note?: string;
}

export interface ManualAdvice {
  readonly kind: "manual";
  readonly text: string;
}

export type Advice = CommandAdvice | ShellAdvice | ManualAdvice;

/** A command to run. A string is cut on single spaces (so a double space, an empty
 *  element, or a quote character is rejected — pass that element as an array instead);
 *  `argv[0]` may not be `--app`, whose deployment is the `app` option. */
export function command(
  argv: string | readonly string[],
  options?: { readonly app?: string; readonly note?: string },
): CommandAdvice {
  if (typeof argv === "string" && /["']/.test(argv)) {
    throw new Error("command(): a quote character needs an array element, not a string");
  }
  const parts = typeof argv === "string" ? argv.split(" ") : argv;
  if (parts.some((part) => part === "")) {
    throw new Error("command(): an empty argument element");
  }
  if (parts[0] === "--app") {
    throw new Error("command(): the deployment is the app option, not --app");
  }
  return {
    kind: "clawforge",
    argv: parts,
    ...(options?.app === undefined ? {} : { app: options.app }),
    ...(options?.note === undefined ? {} : { note: options.note }),
  };
}

export function shellLine(
  shell: Shell,
  text: string,
  options?: { readonly note?: string },
): ShellAdvice {
  return { kind: "shell", shell, text, ...(options?.note === undefined ? {} : { note: options.note }) };
}

export function manual(text: string): ManualAdvice {
  return { kind: "manual", text };
}
