// The --json failure document's differential property: on a parse-stage failure the document
// prints exactly when the parser would have bound `json` as a flag — decided by the ONE
// tokenizer (parse.ts's tokenize, bound the way parseCall binds it), not by a hand-written
// argv scan. Every spelling below is a case a scan gets wrong somewhere:
//   `--interval --json` (R7: a bare option's value), `--opt=value --json` (R8: the flag after
//   an inline value), `--opt full --opt --json` (R9: a repeated option — the parser refuses
//   "given more than once" before it ever reaches `--json`), `--json` after a bare `--`,
//   `--json` in an option's value position, and a verbatim-tail command's literal `--json`.
//
// The oracle mirrors execute.ts's jsonTokenGiven (tokenize over the action parseCall would
// pick); where parseCall succeeds, its own `given` is the second oracle and must agree.

import { executeCommand } from "#framework/core/command/execute.ts";
import {
  commandBody, defineAction, isVerbatim, materializeCommands, multiActionBody, parseCall, scopeByAction, specData, specOf, tokenize,
} from "#framework/core/command/index.ts";
import type { ArgumentSpec, CallShape, EffectShape } from "#framework/core/command/index.ts";
import { ArgumentError } from "#framework/core/command/index.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";

const app: AppDefinition = { name: "json-given-fixture", description: "fixture", commands: openclawCommands };

/** The oracle: tokenize the raw argv exactly as parseCall would (same action pick, same
 *  verbatim-tail decision); a tokenizer refusal means `--json` is never bound. */
type Shape = CallShape & EffectShape;
function jsonTokenGiven(shape: Shape, argv: readonly string[]): boolean {
  try {
    if (shape.actions === undefined) {
      const declared = shape.arguments ?? [];
      return tokenize(declared, argv, undefined, isVerbatim(declared)).given.includes("json");
    }
    const names = Object.keys(shape.actions);
    const first = argv[0];
    let action: string;
    let rest: readonly string[];
    if (first !== undefined && !first.startsWith("-") && names.includes(first)) {
      action = first;
      rest = argv.slice(1);
    } else if (shape.defaultAction !== undefined) {
      action = shape.defaultAction;
      rest = argv;
    } else return false;
    const declared = shape.actions[action]?.arguments ?? [];
    const siblings = scopeByAction(Object.fromEntries(names.map((name) => [name, shape.actions![name]?.arguments ?? []])));
    return tokenize(declared, rest, { action, siblings }, isVerbatim(declared)).given.includes("json");
  } catch {
    return false;
  }
}

function recordingTransport(): Transport {
  return new Proxy({}, {
    get: () => () => {
      throw new Error("json-given check: the transport must not be contacted");
    },
  }) as unknown as Transport;
}

/** Whether the pipeline printed the {error:{message}} document. */
async function runCase(command: string, argv: string[], on: AppDefinition = app) {
  const chunks: string[] = [];
  const execution = await withOutputSink((chunk) => {
    chunks.push(chunk);
  }, () => executeCommand(on, command, argv, { surface: "terminal", transport: recordingTransport() }));
  const printed = chunks.some((chunk) => {
    try {
      return typeof (JSON.parse(chunk) as { error?: { message?: unknown } }).error?.message === "string";
    } catch {
      return false;
    }
  });
  return { execution, printed };
}

function exampleOf(argument: ArgumentSpec): string {
  if (argument.kind === "positional" || argument.kind === "option") {
    if (argument.choices !== undefined) return argument.choices[0];
    if (argument.parse !== undefined) return argument.parse.example;
  }
  return "x";
}

/** A value the argument refuses, so the case always stops at the parse stage. */
function invalidOf(argument: ArgumentSpec): string {
  if (argument.kind !== "option" && argument.kind !== "positional") return "";
  if (argument.choices !== undefined) {
    let outside = "outside-the-list";
    while (argument.choices.includes(outside)) outside += "-x";
    return outside;
  }
  if (argument.parse !== undefined) return argument.parse.invalidExample;
  return "";
}

let cases = 0;
async function differential(label: string, shape: Shape, command: string, argv: string[], fixture: AppDefinition = app) {
  const { execution, printed } = await runCase(command, argv, fixture);
  cases += 1;
  const oracle = jsonTokenGiven(shape, argv);
  check(`${label}: stops at the parse stage`, execution.stage, "parse");
  check(`${label}: the document prints iff the tokenizer binds --json`, printed, oracle);
}

// --- real commands: every declared json flag, every spelling around a real option --------
interface Unit {
  readonly label: string;
  readonly command: string;
  readonly lead: readonly string[];
  readonly positionals: readonly ArgumentSpec[];
  readonly shape: Shape;
  readonly args: readonly ArgumentSpec[];
}
const units: Unit[] = [];
for (const [command, declaration] of Object.entries(openclawCommands)) {
  const entry = specOf(declaration);
  if (entry === undefined) continue;
  const shape = specData(entry);
  const build = (label: string, lead: readonly string[], args: readonly ArgumentSpec[]): void => {
    if (!args.some((argument) => argument.name === "json" && argument.kind === "flag")) return;
    if (!args.some((argument) => argument.kind === "option")) return;
    units.push({ label, command, lead, positionals: args.filter((argument) => argument.kind === "positional"), shape: shape as Shape, args });
  };
  if (shape.kind === "single") build(command, [], shape.arguments);
  else for (const [action, spec] of Object.entries(shape.actions)) build(`${command} ${action}`, [action], spec.arguments);
}

for (const unit of units) {
  const option = unit.args.find((argument) => argument.kind === "option")!;
  const second = unit.args.find((argument) => argument.kind === "option" && argument !== option);
  const name = `--${option.name}`;
  const bad = invalidOf(option);
  const prefix = [...unit.lead, ...unit.positionals.map(exampleOf)];

  // Where parseCall succeeds (valid values, no --json conflict) its own `given` is the
  // second oracle: the tokenizer must agree with the parser on whether json was bound.
  // A derived "valid" argv can still be refused (choices interplay); then the tokenizer
  // must refuse the same way — json is not bound either way.
  {
    const agree = (argv: string[]): void => {
      cases += 1;
      try {
        const parsed = parseCall(unit.shape, argv, unit.command);
        check(`${unit.label}: the tokenizer agrees with parseCall's given`, jsonTokenGiven(unit.shape, argv), parsed.given.includes("json"));
      } catch (error) {
        // bind/rules refused after tokenize succeeded: no parsed `given` exists, but a
        // refusal that names --json itself must mean the oracle said not-given too.
        checkTrue(`${unit.label}: a refusal naming --json matches the oracle`,
          (error as ArgumentError).argument !== "json" || jsonTokenGiven(unit.shape, argv) === false);
      }
    };
    agree([...prefix, name, exampleOf(option)]);
    agree([...prefix, name, exampleOf(option), "--json"]);
  }

  await differential(`${unit.label}: --opt value --json (the flag after a value)`, unit.shape, unit.command, [...prefix, name, bad, "--json"]);
  await differential(`${unit.label}: --json --opt value (the flag first)`, unit.shape, unit.command, [...prefix, "--json", name, bad]);
  await differential(`${unit.label}: --opt=value --json (R8: inline value, then the flag)`, unit.shape, unit.command, [...prefix, `${name}=${bad}`, "--json"]);
  await differential(`${unit.label}: --opt= --json (inline empty, then the flag)`, unit.shape, unit.command, [...prefix, `${name}=`, "--json"]);
  await differential(`${unit.label}: --opt --json (R7: --json in the value position)`, unit.shape, unit.command, [...prefix, name, "--json"]);
  await differential(`${unit.label}: --opt a --opt b --json (a repeated option)`, unit.shape, unit.command, [...prefix, name, bad, name, bad, "--json"]);
  await differential(`${unit.label}: --opt a --opt --json (R9: repeated, then a bare --json)`, unit.shape, unit.command, [...prefix, name, bad, name, "--json"]);
  await differential(`${unit.label}: --opt (the option as the last token)`, unit.shape, unit.command, [...prefix, name]);
  await differential(`${unit.label}: <positional examples> -- --json (after a bare --)`, unit.shape, unit.command, [...prefix, name, bad, ...unit.positionals.map(exampleOf), "--", "--json"]);
  if (second !== undefined) {
    await differential(`${unit.label}: --json between two options`, unit.shape, unit.command, [...prefix, name, bad, "--json", `--${second.name}`, invalidOf(second)]);
  }
}

// --- synthetic shapes: the spellings no single real command carries, incl. verbatim tail --
const pullShape: Shape = {
  effect: "change",
  arguments: [
    { name: "remote", kind: "positional", required: true, description: "where to pull from" },
    { name: "profile", kind: "option", valueName: "profile", description: "the profile" },
    { name: "keep", kind: "option", valueName: "count", description: "what to keep" },
    { name: "json", kind: "flag", description: "machine output" },
  ],
};
const pullApp: AppDefinition = {
  name: "pull-fixture",
  description: "fixture",
  commands: materializeCommands({ pull: { summary: "pull", group: "low-level", ...commandBody({ effect: "change", arguments: pullShape.arguments ?? [], run: async () => {} }) } }),
};
await differential("pull: --profile full --profile --json (R9, concrete case)", pullShape, "pull", ["--profile", "full", "--profile", "--json"], pullApp);
await differential("pull: --interval --json (R7 shape, concrete case)", pullShape, "pull", ["--keep", "--json"], pullApp);
await differential("pull: --keep=0 --json (R8 shape, concrete case)", pullShape, "pull", ["--keep=0", "--json"], pullApp);

const backupShape: Shape = {
  effect: "change",
  defaultAction: "create",
  actions: {
    create: { arguments: [
      { name: "name", kind: "positional", required: true, description: "the name" },
      { name: "profile", kind: "option", valueName: "profile", description: "the profile" },
      { name: "json", kind: "flag", description: "machine output" },
    ] },
    list: { arguments: [
      { name: "format", kind: "option", valueName: "format", required: true, description: "the format" },
      { name: "json", kind: "flag", description: "machine output" },
    ] },
  },
};
const backupApp: AppDefinition = {
  name: "backup-fixture",
  description: "fixture",
  commands: materializeCommands({
    backup: { summary: "backup", group: "low-level", ...multiActionBody({
      effect: "change",
      action: { description: "what to do" },
      defaultAction: "create",
      actions: {
        create: defineAction({ summary: "create", arguments: backupShape.actions!.create!.arguments as readonly ArgumentSpec[], run: async () => {} }),
        list: defineAction({ summary: "list", arguments: backupShape.actions!.list!.arguments as readonly ArgumentSpec[], run: async () => {} }),
      },
    }) },
  }),
};
await differential("backup create: --json before the action-less default", backupShape, "backup", ["--profile", "full", "--json"], backupApp);
await differential("backup list: --json with the action word", backupShape, "backup", ["list", "--json"], backupApp);

const execShape: Shape = {
  effect: "change",
  arguments: [
    { name: "profile", kind: "option", valueName: "profile", choices: ["debug"], description: "the profile" },
    { name: "json", kind: "flag", description: "machine output" },
    { name: "command", kind: "variadic", verbatim: true, description: "what to run" },
  ],
};
const execApp: AppDefinition = {
  name: "exec-fixture",
  description: "fixture",
  commands: materializeCommands({ exec: { summary: "exec", group: "low-level", ...commandBody({ effect: "change", arguments: execShape.arguments ?? [], run: async () => {} }) } }),
};
await differential("exec: --profile full run --json (a verbatim tail swallows --json)", execShape, "exec", ["--profile", "full", "run", "--json"], execApp);
await differential("exec: --profile full --json run (the flag before the tail)", execShape, "exec", ["--profile", "full", "--json", "run"], execApp);

checkTrue("every differential case ran", cases > 60);
finish("pipeline: the --json document agrees with the tokenizer on a parse failure");
