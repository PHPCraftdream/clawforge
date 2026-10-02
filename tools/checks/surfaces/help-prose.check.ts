// Help-prose tokens (design 2.1–2.3): every `{…}` span in a declaration's `details` must
// read as a token, `{clawforge …}` must name a command that takes the argv it spells, and
// `{--name}` must be a flag this very command declares — so a renamed flag breaks the
// check, not the help. The declarations are read where the help reads them: the command
// set, the gate's own commands, version/completion built the way tools/clawforge.ts builds
// them, and control-mcp's shared body.
//
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import type { CommandArgument } from "#framework/core/app.ts";
import {
  ArgumentError, UnknownActionError, UnknownArgumentError, parseCall, specOf, specShape, tokenize,
} from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { checkoutGateCommands } from "#framework/entry/checkout-gate.ts";
import { makeVersionGateCommand } from "#framework/integration/version.ts";
import { makeCompletionGateCommand } from "#framework/integration/completion.ts";
import { CONTROL_MCP_DETAILS, type GateCommand } from "#framework/integration/gate.ts";
import { makeInitGateCommand } from "#framework/integration/deployment/init.ts";
import { parseProse, type ProseToken } from "#framework/core/io/invocation/prose.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";

// The gate as the checkout root builds it — completion closes over the finished array.
const gateCommands: GateCommand[] = [...checkoutGateCommands, makeVersionGateCommand(), makeInitGateCommand("<app-root>")];
gateCommands.push(makeCompletionGateCommand(gateCommands, true));

interface ProseDeclaration {
  readonly name: string;
  readonly details?: string;
  readonly arguments?: readonly CommandArgument[];
}

const controlMcp: ProseDeclaration = {
  name: "control-mcp",
  details: CONTROL_MCP_DETAILS,
  arguments: [],
};

/** One declaration's prose surface: the name the dispatcher resolves, its details and its
 *  declared arguments — the same three fields an AppCommand and a GateCommand both carry. */
function face(
  name: string,
  command: { readonly details?: string; readonly arguments?: readonly CommandArgument[] },
): ProseDeclaration {
  return { name, details: command.details, arguments: command.arguments };
}

const declarations: readonly ProseDeclaration[] = [
  ...Object.entries(openclawCommands).map(([name, command]) => face(name, command)),
  ...gateCommands.map((command) => face(command.name, command)),
  controlMcp,
];
const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));
/** Every name the dispatcher can resolve (gate.ts's knownCommandNames) — what `help` takes. */
const knownNames = new Set(declarations.map((declaration) => declaration.name));
const gateByName = new Map(gateCommands.map((command) => [command.name, command]));

/** A `<placeholder>` stands in for one plain word (design 4.2's P4); what example the
 *  declaration would offer is its business, not the token's. */
const PLACEHOLDER = /^<.*>$/;
const EXAMPLE = "x";

/** Every `{…}` span claiming to be a token: one whose content opens with neither clawforge
 *  nor -- is prose (JSON in the text) and ignored. Tokens do not nest, so a span ends at
 *  the first "}". */
function claimedSpans(details: string): readonly string[] {
  return (details.match(/\{[^{}]*\}/g) ?? []).filter((span) => {
    const content = span.slice(1, -1);
    return content.startsWith("clawforge") || content.startsWith("--");
  });
}

/** Why the parser refuses an argv, undefined when it accepts it. Strict about names, lenient
 *  about values: a placeholder filled with `x` can still violate an argument's own
 *  choices/parse, and that is the declaration's shape talking — an ArgumentError naming an
 *  argument this declaration has is left alone, one naming anything else (an unknown flag,
 *  an unknown action word) is the token's fault. */
function parseProblem(parse: () => unknown, declared: readonly CommandArgument[] | undefined): string | undefined {
  try {
    parse();
    return undefined;
  } catch (error) {
    if (error instanceof UnknownActionError || error instanceof UnknownArgumentError) return error.message;
    if (error instanceof ArgumentError) {
      const named = error.argument !== undefined && declared?.some((argument) => argument.name === error.argument) === true;
      return named ? undefined : error.message;
    }
    return String(error);
  }
}

function tokenProblem(token: ProseToken, declaration: ProseDeclaration): string | undefined {
  const declared = declaration.arguments ?? [];
  if (token.kind === "program") return undefined;
  if (token.kind === "flag") {
    return declared.some((argument) => argument.name === token.name) ? undefined : `--${token.name} is not a flag this command declares`;
  }
  const argv = token.argv.map((word) => (PLACEHOLDER.test(word) ? EXAMPLE : word));
  const [word, ...rest] = argv;
  if (word === undefined) return "no command word — a lone --app is not a command";
  if (word === "help") {
    if (rest.length === 0) return undefined;
    if (rest.length > 1) return "help takes one command name";
    return knownNames.has(rest[0] ?? "") ? undefined : `help names an unknown command: ${rest[0] ?? ""}`;
  }
  // Dispatched by runApp before the app.commands lookup, so no command object carries it.
  if (word === "control-mcp") return rest.length === 0 ? undefined : "control-mcp takes no arguments";
  const app = openclawCommands[word];
  if (app !== undefined) {
    const body = specOf(app);
    if (body === undefined) return `${word} has no declared command body`;
    return parseProblem(() => parseCall(specShape(body), rest, word), app.arguments);
  }
  const gate = gateByName.get(word);
  if (gate === undefined) return `unknown command: ${word}`;
  return parseProblem(() => tokenize(gate.arguments ?? [], rest), gate.arguments);
}

function validateProse(declaration: ProseDeclaration, details: string): void {
  for (const span of claimedSpans(details)) {
    const tokens = parseProse(span);
    checkTrue(`${declaration.name}: token ${span} reads as one token`, tokens.length === 1);
    const token = tokens[0];
    if (token === undefined) continue;
    const problem = tokenProblem(token, declaration);
    checkTrue(`${declaration.name}: token ${span}${problem === undefined ? "" : ` — ${problem}`}`, problem === undefined);
  }
}

for (const declaration of declarations) {
  if (declaration.details === undefined) continue;
  validateProse(declaration, declaration.details);
}

// No details carry a token yet, so the rules above are vacuous — this table keeps them live
// against the real declarations. Every string parses and must be accepted; a rule that
// stopped rejecting a broken token fails here first.
const SYNTHETIC_TOKENS: readonly (readonly [string, string])[] = [
  ["status", "{clawforge}"],
  ["status", "{clawforge --app <name> status}"],
  ["status", "{clawforge status --json}"],
  ["status", "{--json}"],
  ["logs", "{clawforge logs --tail <n>}"],
  ["apply-config", "{clawforge apply-config --dump --force}"],
  ["apply-config", "{--dry-run}"],
  ["backup", "{clawforge backup list --json}"],
  ["set", "{clawforge set validate --json}"],
  ["check", "{clawforge help logs}"],
  ["check", "{clawforge check --list}"],
  ["list", "{--no-status}"],
  ["version", "{clawforge version --json}"],
  ["control-mcp", "{clawforge control-mcp}"],
];
for (const [name, text] of SYNTHETIC_TOKENS) {
  const declaration = byName.get(name);
  checkTrue(`synthetic token table names a real declaration: ${name}`, declaration !== undefined);
  if (declaration !== undefined) validateProse(declaration, text);
}

// Group data must not freeze an invocation into a command line: a renderer call in a group
// file or in service/inspection.ts bakes the program spelling into the declaration.
const RENDERER_CALLS = ["commandLine(", "renderAdvice("];
const groupsDir = resolve(monorepoRoot, "tools", "framework", "commands", "interface", "groups");
const structureFiles = [
  ...(await readdir(groupsDir)).filter((name) => name.endsWith(".ts")).map((name) => resolve(groupsDir, name)),
  resolve(monorepoRoot, "tools", "framework", "service", "inspection.ts"),
];
for (const file of structureFiles) {
  const text = await readFile(file, "utf8");
  const name = relative(monorepoRoot, file).split("\\").join("/");
  for (const call of RENDERER_CALLS) checkTrue(`${name} holds no ${call}`, !text.includes(call));
}

finish("help prose");
