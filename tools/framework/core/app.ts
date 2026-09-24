// The application API: what a piece of code declares in order to be driven by this
// framework, from the console and over MCP.
//
// The framework knows how to reach a target (transport), translate paths between
// coordinate systems (path bridge) and operate a containerised service (runtime). It knows
// nothing about OpenClaw. An application supplies that knowledge: its settings, its
// commands, and which secrets it needs.
//
// A minimal application is a single file:
//
//   export default defineApp({
//     name: "hello",
//     description: "Example",
//     commands: {
//       ping: {
//         summary: "Check the target answers",
//         run: async (ctx) => { info(await ctx.transport.exec("uname", ["-a"]).then(r => r.stdout)); },
//       },
//     },
//   });

import type { Env } from "./env.ts";
import type { Context } from "./context.ts";
import type { MountPoint } from "./paths.ts";

export type ArgumentKind = "positional" | "flag" | "option" | "variadic";

/** Description of an argument, used for help text and for the MCP schema. */
export interface CommandArgument {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  /** How the argument appears on a command line:
   *    positional  <archive>          a bare value, order matters
   *    flag        --force            present or absent, no value
   *    option      --profile share    a named value
   *    variadic    <args…>            every remaining value, in order
   *
   *  One declaration drives three things — the help text, the MCP tool schema and the argv
   *  an MCP call is turned back into. They used to be derived separately, which is how
   *  --profile came to be declared a flag while the parser required a value: over MCP it
   *  arrived as `--profile` alone and swallowed the next argument.
   *
   *  variadic exists for a command whose arguments are not ours to name — `cli` hands them
   *  to another program. It is a list of strings in the tool schema, appended to argv in
   *  order, and there can be only one, last, for the same reason a shell has only one
   *  "everything after this". */
  readonly kind: ArgumentKind;
  /** Accepted values. Enforced before the command runs and published in the tool schema. */
  readonly choices?: readonly string[];
}

export interface AppCommand {
  /** One line shown in the command list and as the MCP tool's short description. */
  readonly summary: string;
  /** Longer explanation shown by `./clawforge help <command>` / `./clawforge <command> --help`, and
   *  appended to the MCP tool description. Optional: a command whose name and summary
   *  already say everything (`up`, `down`) does not need one. Written as plain paragraphs
   *  — this module wraps nothing, it prints each line as given. */
  readonly details?: string;
  readonly run: (ctx: Context, args: string[]) => Promise<void>;
  /** Declared arguments; also what the MCP tool schema is generated from. */
  readonly arguments?: CommandArgument[];
  /** Commands that replace or destroy state. Exposed over MCP only with an explicit
   *  confirmation argument, because a tool call is far easier to trigger by accident than
   *  a typed command. */
  readonly destructive?: boolean;
  /** Keep the *console form* of this command out of MCP — for one whose console behaviour
   *  cannot be a tool call: it streams until interrupted, or it owns stdio for a protocol.
   *
   *  This flag is not permission to leave a capability unreachable over MCP. The surface is
   *  meant to be a mirror: what a terminal can do, a tool call can do. A command marked
   *  here therefore owes one of two things, and tools/checks/mcp-mirror.check.ts fails
   *  until it has one:
   *    - an MCP form declared beside it (a bounded variant — see `logs`, which follows the
   *      log on a terminal and reads a fixed tail as a tool), or
   *    - an entry in MCP_EXEMPTIONS (mcp-server.ts) giving the reason it cannot exist. */
  readonly consoleOnly?: boolean;
  /** The command is expected to work on a deployment that has no .env yet: the framework
   *  creates it, and the gateway token, before building the context. Without this a first
   *  run fails in the settings parser before the command that would fix it ever starts. */
  readonly preparesEnvironment?: boolean;
  /** `--help`/`-h` anywhere in the arguments normally shows this command's own help
   *  instead of running it — the one exception is a command whose whole job is passing
   *  argv through to something else (`cli`), where `--help` is meant for the underlying
   *  tool, not for us. `./clawforge help <command>` still explains the command itself either way;
   *  this only changes what a bare `<command> --help` does. */
  readonly passesThroughHelp?: boolean;
  /** Every successful tool call returns the same structured envelope, declared to clients
   *  as the tool's outputSchema: the command's own captured output carried whole in
   *  `result` — its JSON document when it emits one, its text otherwise — plus the fields
   *  every caller needs: whether the call changed anything, what was found, what to do
   *  next.
   *
   *  The command does not change to satisfy this: it already emits its JSON through emit()
   *  when its output is captured, which is exactly what `--json` prints on a console. What
   *  the flag promises is the envelope, not the JSON: an action whose output is plain text
   *  still answers in the envelope, with that text as its result — because the tool
   *  declares one outputSchema for every action, and a declaration some action does not
   *  satisfy is worse than none. A mixed command therefore declares no per-action
   *  structured metadata; per-action change and confirmation facts belong to
   *  changedWhen and requiresConfirmationWhen. */
  readonly structured?: boolean;
  /** The command observes and never changes anything. Lets a tool result state `changed:
   *  false` as a fact rather than as an assumption, which is what makes it safe for an
   *  agent to call between steps. */
  readonly readOnly?: boolean;
  /** Refines read-only reporting for command groups with mixed subcommands. */
  readonly readOnlyWhen?: (args: string[]) => boolean;
  /** Says whether a call made a change, independently of whether it needs confirmation. */
  readonly changedWhen?: (args: string[]) => boolean;
  /** Refines which calls need explicit MCP confirmation for a mixed command. */
  readonly requiresConfirmationWhen?: (args: string[]) => boolean;
  /** Appends an explicit command-level --force only after MCP confirmation. */
  readonly forceOnConfirmation?: boolean;
  /** The command's successful output carries registered credential values on purpose —
   *  `mcp-creds` is the one — so the response redaction that guards every other healthy
   *  answer (audit 2026-09-22 round 3, P2-05) lets it through instead of answering with
   *  "***" where the caller asked for the value. Declared here, on the record beside the
   *  command, rather than left as an implicit hole in the dispatcher. A failure is never
   *  deliberate: the mask applies to it as to every other command. */
  readonly exportsSecrets?: boolean;
}

/** A variable the application needs, and where it is expected. */
export interface AppSecret {
  readonly name: string;
  readonly location: "repo-env" | "target-env";
  readonly usedBy: string;
  /** Required unless explicitly false. */
  readonly required?: boolean;
}

export interface AppDefinition {
  /** Short identifier, used in messages. */
  readonly name: string;
  readonly description: string;
  /** Extra environment defaults for the application. The hook receives a copy of the parsed
   *  `.env`; values it returns are available in `ctx.settings.env`. Explicit `.env` values
   *  win, and framework derived settings are rebuilt from the merged environment. */
  readonly settings?: (env: Env) => Record<string, string>;
  /** Secrets required before the service can start. Returned dynamically because the list
   *  usually depends on what is configured on the target. */
  readonly secrets?: (ctx: Context) => Promise<AppSecret[]>;
  /** Recipe root, relative to the deployment or absolute. An active set source takes priority. */
  readonly recipesDir?: string;
  /** How the data directory appears inside the container. The framework translates paths
   *  but does not know what the image looks like inside, so the map comes from here. */
  readonly mounts?: (dataDir: string) => MountPoint[];
  /** Which service the runtime operates. Without this the framework would have to guess a
   *  service name, which is exactly the kind of hidden assumption the split is meant to
   *  remove. The container is not named here: it is found through the compose project, so
   *  it stays distinct per deployment. */
  readonly service?: {
    readonly name: string;
    readonly logTail?: string;
  };
  readonly commands: Record<string, AppCommand>;
}

/** Identity function that exists for the types: it turns a plain object into a checked
 *  application definition at the point of declaration rather than at the point of use. */
export function defineApp(definition: AppDefinition): AppDefinition {
  if (definition.name.trim() === "") throw new Error("an application needs a name");
  if (Object.keys(definition.commands).length === 0) {
    throw new Error(`application "${definition.name}" declares no commands`);
  }
  return definition;
}

/** Commands that may be exposed as MCP tools. */
export function mcpCommands(app: AppDefinition): [string, AppCommand][] {
  return Object.entries(app.commands).filter(([, command]) => command.consoleOnly !== true);
}
