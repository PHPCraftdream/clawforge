// The command set the framework offers for an OpenClaw-style service.
//
// A deployment lists these under its own name; it does not reimplement them. Argument
// descriptions live here too, because they are what `--help`, the MCP tool schemas and the
// argv of an MCP call are all generated from — so every entry below must match what the
// command's own parser accepts. An argument the parser knows and this list does not is
// invisible over MCP; the reverse is a call that fails.
//
// `details` is optional longer text, shown by `./clawforge help <command>` and folded into the
// MCP tool description. A command whose name and summary already say everything (`up`,
// `down`, `logs`) skips it — the point is to explain what is not obvious from the name,
// not to restate it.
//
// Split by command family so no one file holds every entry: each fragment owns its own
// imports and its own slice of openclawCommands, merged back into one object below. The
// split is purely organisational — every command's name, shape and behaviour is unchanged.

import type { AppCommand } from "#src/core/app.ts";
import { lifecycleCommands } from "./groups/openclawCommands.lifecycle.ts";
import { orchestrationCommands } from "./groups/openclawCommands.orchestration.ts";
import { managementCommands } from "./groups/openclawCommands.management.ts";
import { setsCommands } from "./groups/openclawCommands.sets.ts";

export const openclawCommands: Record<string, AppCommand> = {
  ...lifecycleCommands,
  ...orchestrationCommands,
  ...managementCommands,
  ...setsCommands,
};
