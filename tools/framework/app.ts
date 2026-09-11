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
  /** The command's machine-readable output is a single JSON document, so a tool call can
   *  return it as structuredContent instead of leaving the caller to parse a log.
   *
   *  The command does not change to satisfy this: it already emits that JSON through emit()
   *  when its output is captured, which is exactly what `--json` prints on a console. The
   *  flag says the output can be trusted to parse, and nothing more — an output that turns
   *  out not to parse is returned as text, not as an error. */
  readonly structured?: boolean;
  /** The command observes and never changes anything. Lets a tool result state `changed:
   *  false` as a fact rather than as an assumption, which is what makes it safe for an
   *  agent to call between steps. */
  readonly readOnly?: boolean;
  /** Refines read-only reporting for command groups with mixed subcommands. */
  readonly readOnlyWhen?: (args: string[]) => boolean;
}

/** A variable the application needs, and where it is expected. */
export interface AppSecret {
  readonly name: string;
  readonly location: "repo-env" | "target-env";
  readonly usedBy: string;
  readonly required?: boolean;
}

export interface AppDefinition {
  /** Short identifier, used in messages. */
  readonly name: string;
  readonly description: string;
  /** Extra settings the application reads from the environment. Optional: most read what
   *  the framework already parsed. */
  readonly settings?: (env: Env) => Record<string, string>;
  /** Secrets required before the service can start. Returned dynamically because the list
   *  usually depends on what is configured on the target. */
  readonly secrets?: (ctx: Context) => Promise<AppSecret[]>;
  /** Where this application keeps its recipes. The recipe mechanism belongs to the
   *  framework; the recipes themselves are the application's data, so their location is
   *  declared here rather than assumed to be <repo>/recipes. */
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
