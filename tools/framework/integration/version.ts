// `--version`, `-v` and `version`: the framework version, answered before any deployment is resolved.

import { frameworkVersion } from "../commands/management/lock.ts";
import { emit } from "../core/io/output.ts";
import { die } from "../core/io/log.ts";
import { parseDeclaredArgs } from "../core/arguments.ts";
import type { GateCommand } from "./gate.ts";
import type { CommandArgument } from "../core/app.ts";

export const VERSION_ARGUMENTS: CommandArgument[] = [
  { name: "json", description: "Emit { name, version } instead of the one-line text", kind: "flag" },
];

export const VERSION_COMMAND_NAME = "version";

/** `--version`/`-v` as the first token become `version`: one declaration serves all spellings. */
export function normalizeVersionAlias(argv: string[]): string[] {
  if (argv[0] === "--version" || argv[0] === "-v") return [VERSION_COMMAND_NAME, ...argv.slice(1)];
  return argv;
}

export const versionGateCommand: GateCommand = {
  name: VERSION_COMMAND_NAME,
  summary: "Print clawforge's own version (also: --version, -v)",
  details: "Reads the framework's package.json, as `inspect` does. No deployment is resolved, no .env is read, no lock is touched.",
  arguments: VERSION_ARGUMENTS,
  run: async (args) => {
    const parsed = parseDeclaredArgs(VERSION_ARGUMENTS, args);
    const version = await frameworkVersion();
    if (version === undefined) die("cannot determine the framework version — package.json is missing or unreadable");
    if (parsed.json === true) emit(`${JSON.stringify({ name: "clawforge", version })}\n`);
    else emit(`clawforge ${version}\n`);
    return 0;
  },
};
