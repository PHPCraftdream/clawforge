// The parity table: what each of the 41 framework commands does to state for representative
// argv. The rows are literal data pinned from the argv predicates the commands carried before
// the effect model (readOnly / readOnlyWhen / changedWhen / requiresConfirmationWhen /
// destructive), so a command that moves to a spec keeps its facts, and a predicate that drifts
// fails here. Plus the shape rules of the model itself, on synthetic specs.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import { ArgumentError, callFacts, callFactsFor, effectProfile, shapeProfile, type EffectShape } from "#framework/core/command/index.ts";
import { destructiveSymbol, destructiveMarker, renderFullCommandHelp } from "#framework/core/io/help-render.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { inputSchema } from "#framework/integration/mcp/schema.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

type Row = readonly [argv: readonly string[], effect: "read" | "change" | "destroy", changed?: boolean];

const TABLE: Readonly<Record<string, readonly Row[]>> = {
  bootstrap: [[[], "change"], [["--check"], "read"], [["--no-pull"], "change"]],
  up: [[[], "change"], [["--break-lock"], "change"]],
  restart: [[[], "change"]],
  down: [[[], "change"]],
  destroy: [[[], "read", false], [["--data"], "read", false], [["--yes"], "destroy", true], [["--data", "--yes"], "destroy", true]],
  logs: [[[], "read"], [["--tail", "5"], "read"]],
  backup: [
    [[], "change", true], [["--dry-run"], "read", false], [["--hot"], "change", true], [["create"], "change", true], [["create", "--dry-run"], "read", false],
    [["list"], "read", false], [["prune-replaced"], "read", false], [["prune-replaced", "--apply"], "destroy", true],
    [["install"], "read", false], [["install", "--apply"], "destroy", true],
    [["uninstall"], "read", false], [["uninstall", "--apply"], "destroy", true],
  ],
  restore: [[[], "destroy"], [["a.tar"], "destroy"], [["--dry-run"], "read"], [["a.tar", "--dry-run"], "read"]],
  pull: [[[], "change"]],
  push: [[[], "destroy"], [["--dry-run"], "read"]],
  verify: [[[], "read"], [["a.tar"], "read"]],
  upgrade: [[[], "destroy"], [["--dry-run"], "read"]],
  smoke: [[[], "change"]],
  inspect: [[[], "read"]],
  doctor: [[[], "read"]],
  plan: [[[], "read"]],
  apply: [[[], "destroy"], [["--dry-run"], "read"]],
  accept: [[[], "change"]],
  rollback: [[[], "destroy"], [["--dry-run"], "read"]],
  operations: [[[], "read"]],
  "apply-config": [[[], "change"], [["--dry-run"], "change"], [["--dump"], "change"]],
  expose: [
    [["ssh"], "read", false], [["status"], "read", false], [["tailscale"], "read", false], [["tailscale", "--apply"], "destroy", true],
  ],
  watch: [
    [["check"], "read", false], [["status"], "read", false], [["test"], "read", false],
    [["install"], "read", false], [["install", "--apply"], "destroy", true],
    [["uninstall"], "read", false], [["uninstall", "--apply"], "destroy", true],
  ],
  incident: [[[], "destroy"], [["--dry-run"], "read"]],
  "recover-env": [[[], "change"], [["--dry-run"], "read"]],
  status: [[[], "read"]],
  lock: [[[], "change"], [["--check"], "read"]],
  cli: [[[], "destroy"], [["agent", "list"], "destroy"]],
  exec: [[[], "destroy"], [["ls"], "destroy"]],
  host: [[[], "destroy"], [["target", "ls"], "destroy"]],
  "cli-start": [[[], "change"]],
  "cli-stop": [[[], "change"]],
  "configure-provider": [[[], "change"]],
  secrets: [
    [[], "read", false], [["--print-template"], "read", false], [["--template"], "change", true],
    [["--template", "--print-template"], "read", false], [["--init-store"], "destroy", true],
    [["--apply"], "destroy", true], [["--dump"], "destroy", true],
  ],
  recipe: [
    [[], "read"], [["list"], "read"], [["status"], "read"], [["logs"], "read"],
    [["install"], "destroy"], [["install", "--dry-run"], "read"], [["remove"], "destroy"], [["remove", "--dry-run"], "read"],
    [["import"], "destroy"], [["new"], "destroy"], [["verify"], "destroy"], [["verify", "--dry-run"], "destroy"],
    [["onboard"], "destroy"], [["diagnose"], "destroy"],
  ],
  "provision-agent": [[[], "change"], [["x"], "change"]],
  deploy: [[[], "destroy"], [["host"], "destroy"], [["host", "--dry-run"], "read"]],
  "mcp-serve": [[[], "change"]],
  "mcp-setup": [[[], "change"]],
  "mcp-creds": [[[], "read"], [["--token"], "read"]],
  set: [
    [["validate"], "read", false], [["diff"], "read", false], [["receipts"], "read", false],
    [["build"], "change", true], [["try"], "destroy", true], [["forget"], "destroy", true], [[], "change", false],
  ],
};

check("the table covers exactly the framework commands", Object.keys(TABLE).sort(), Object.keys(openclawCommands).sort());
check("there are 41 commands", Object.keys(openclawCommands).length, 41);

// The argv the spec parser now refuses by design — a bare variadic/positional command, a
// flag another action owns — named EXPLICITLY, so a regression that makes any other row's
// call refuse fails loudly instead of passing as "refused". Every command keeps a
// positive row above.
const REFUSED: readonly (readonly [name: string, argv: readonly string[]])[] = [
  ["cli", []],
  ["exec", []],
  ["host", []],
  ["deploy", []],
  ["verify", []],
  ["provision-agent", []],
  ["recipe", ["verify", "--dry-run"]],
];
const refusedKey = (name: string, argv: readonly string[]): string => `${name} ${argv.join(" ")}`;
const REFUSED_KEYS = new Set(REFUSED.map(([name, argv]) => refusedKey(name, argv)));

for (const [name, rows] of Object.entries(TABLE)) {
  for (const [argv, effect, changed] of rows) {
    const label = `${name} ${argv.join(" ")}`.trim();
    if (REFUSED_KEYS.has(refusedKey(name, argv))) {
      let error: unknown;
      try {
        callFactsFor(openclawCommands[name], argv);
      } catch (caught) {
        error = caught;
      }
      checkTrue(`${label}: refused as an argument error before any effect`, error instanceof ArgumentError);
      continue;
    }
    const facts = callFactsFor(openclawCommands[name], argv);
    check(`${label}: effect`, facts.effect, effect);
    // For a spec command `changed` is the model's, not a predicate's: read → false,
    // otherwise true — the same rule the MCP envelope applies. A legacy command reports
    // its own changedWhen, which is what the row pinned.
    check(`${label}: changed`, changed === undefined ? facts.changed : facts.changed ?? (facts.effect === "read" ? false : true), changed);
  }
}
// --- the static profile: literal, then against what the renderers print today ----------------

const DESTRUCTIVE = [
  "destroy", "backup", "restore", "push", "upgrade", "apply", "rollback", "expose", "watch", "incident",
  "cli", "exec", "host", "secrets", "recipe", "deploy", "set",
];
const ALWAYS_DESTROYS = ["cli", "exec", "host"];
const BY_ACTION = ["backup", "expose", "watch", "recipe", "set"];

async function helpNote(name: string): Promise<string> {
  let printed = "";
  await withOutputSink((chunk) => {
    printed += chunk;
  }, async () => {
    renderFullCommandHelp(name, openclawCommands[name]);
  });
  return printed;
}

for (const [name, command] of Object.entries(openclawCommands)) {
  const destructive = DESTRUCTIVE.includes(name);
  const alwaysDestroys = ALWAYS_DESTROYS.includes(name);
  check(`${name}: profile`, effectProfile(command), { destructive, alwaysDestroys, byAction: BY_ACTION.includes(name) });

  // The list marker, the tool description marker and the confirm field, as the renderers print them.
  check(`${name}: list marker`, destructiveSymbol(command), !destructive ? "" : alwaysDestroys ? " !" : " *");
  check(`${name}: description marker`, destructiveMarker(command), !destructive ? "" : alwaysDestroys ? " (destructive)" : " (destructive for some actions)");
  const schema = inputSchema(command) as { properties: Record<string, { description?: string }>; required: string[] };
  check(`${name}: confirm field present`, "confirm" in schema.properties, destructive);
  check(`${name}: confirm required`, schema.required.includes("confirm"), alwaysDestroys);
  if (destructive) {
    check(`${name}: confirm wording`, schema.properties.confirm.description, alwaysDestroys ? "Must be true: destroys state" : "Confirm a destructive action");
    const note = await helpNote(name);
    const expected = alwaysDestroys ? "replaces or destroys state." : BY_ACTION.includes(name)
      ? "depending on the action given." : "depending on the flags given.";
    checkTrue(`${name}: --help note ends "${expected}"`, note.includes(expected));
  }
}

// --- the model's own rules, on synthetic specs ---------------------------------------------------

const SHAPE: EffectShape = {
  effect: "change",
  actions: {
    list: { effect: "read", arguments: [] },
    install: { effect: "read", arguments: [{ name: "apply", kind: "flag", description: "x", effect: "destroy" }] },
    create: {
      arguments: [
        { name: "dry-run", kind: "flag", description: "x", effect: "read" },
        { name: "wipe", kind: "flag", description: "x", effect: "destroy" },
        { name: "plain", kind: "flag", description: "x" },
      ],
    },
  },
};
check("an action's own effect is its base", callFacts(SHAPE, { action: "list", given: [] }).effect, "read");
check("an action without one takes the body's", callFacts(SHAPE, { action: "create", given: [] }).effect, "change");
check("a flag raises the base", callFacts(SHAPE, { action: "install", given: ["apply"] }).effect, "destroy");
check("a flag without an effect leaves it", callFacts(SHAPE, { action: "create", given: ["plain"] }).effect, "change");
check("a read flag wins over a destroy flag", callFacts(SHAPE, { action: "create", given: ["wipe", "dry-run"] }).effect, "read");
check("the strongest given flag wins", callFacts(SHAPE, { action: "create", given: ["plain", "wipe"] }).effect, "destroy");
check("a flag of another action does not count", callFacts(SHAPE, { action: "list", given: ["apply"] }).effect, "read");
check("a single body is its own base", callFacts({ effect: "destroy", arguments: [{ name: "dry-run", kind: "flag", description: "x", effect: "read" }] }, { given: ["dry-run"] }).effect, "read");
check("spec profile: destructive through a flag, by action", shapeProfile(SHAPE), { destructive: true, alwaysDestroys: false, byAction: true });
check("spec profile: every base destroy, no read flag", shapeProfile({ effect: "destroy", arguments: [] }), { destructive: true, alwaysDestroys: true, byAction: false });
check("spec profile: a read flag lifts alwaysDestroys", shapeProfile({ effect: "destroy", arguments: [{ name: "dry-run", kind: "flag", description: "x", effect: "read" }] }).alwaysDestroys, false);
check("spec profile: reads only", shapeProfile({ effect: "read", arguments: [] }), { destructive: false, alwaysDestroys: false, byAction: false });

finish("effect parity");
