// Checks the one declaration that feeds help text, MCP schemas and argv.
//
// No instance and no target: these are the pure parts of the contract.

import { openclawCommands } from "../../../framework/commands/interface/index.ts";
import { inputSchema, toArgv, validate } from "../../../framework/integration/mcp-server.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

// --- every declaration is well formed ----------------------------------------

for (const [name, command] of Object.entries(openclawCommands)) {
  for (const argument of command.arguments ?? []) {
    check(
      `${name}.${argument.name} declares a kind`,
      ["positional", "flag", "option", "variadic"].includes(argument.kind),
      true,
    );
    if (argument.kind === "flag") {
      check(`${name}.${argument.name} flag has no choices`, argument.choices, undefined);
    }
  }

  // A required positional after an optional one can never be supplied.
  const positionals = (command.arguments ?? []).filter((argument) => argument.kind === "positional");
  let seenOptional = false;
  for (const argument of positionals) {
    if (argument.required !== true) seenOptional = true;
    else if (seenOptional) {
      check(`${name}.${argument.name} required positional comes before optional ones`, false, true);
    }
  }
}

// --- schema ------------------------------------------------------------------

const verifySchema = inputSchema(openclawCommands.verify) as {
  properties: Record<string, { type: string; enum?: string[] }>;
  required: string[];
};
check("an option is a string in the schema", verifySchema.properties.profile.type, "string");
check("choices reach the schema", verifySchema.properties.profile.enum, ["full", "migrate", "share"]);
check("a required argument is marked", verifySchema.required.includes("archive"), true);

const pushSchema = inputSchema(openclawCommands.push) as {
  properties: Record<string, { type: string }>;
  required: string[];
};
check("a flag is a boolean in the schema", pushSchema.properties.force.type, "boolean");
check("destructive commands require confirm", pushSchema.required.includes("confirm"), true);

// --- argv --------------------------------------------------------------------

check(
  "an option keeps its name and value",
  toArgv(openclawCommands.pull, { profile: "share" }),
  ["--profile", "share"],
);
check(
  "a positional stays bare and comes first",
  toArgv(openclawCommands.verify, { archive: "/tmp/a b.tar.gz", profile: "migrate" }),
  ["/tmp/a b.tar.gz", "--profile", "migrate"],
);
check("a false flag is omitted", toArgv(openclawCommands.backup, { hot: false }), []);
check("a true flag is passed", toArgv(openclawCommands.backup, { hot: true }), ["--hot"]);
check(
  "confirm waives the terminal prompt",
  toArgv(openclawCommands.push, { confirm: true }),
  ["--force"],
);
check(
  "an explicit force is not doubled",
  toArgv(openclawCommands.push, { confirm: true, force: true }),
  ["--force"],
);

// --- validation --------------------------------------------------------------

check("a good call has no problems", validate(openclawCommands.pull, { profile: "share" }), []);
check(
  "an unknown argument is rejected",
  validate(openclawCommands.status, { bogus: "x" }),
  ["unknown argument: bogus"],
);
check(
  "a value outside the choices is rejected",
  validate(openclawCommands.pull, { profile: "everything" }),
  ["profile must be one of: full, migrate, share"],
);
check(
  "a wrong type is rejected",
  validate(openclawCommands.backup, { hot: "yes" }),
  ["hot takes true or false"],
);
check(
  "a missing required argument is rejected",
  validate(openclawCommands.verify, {}),
  ["archive is required"],
);

// --- variadic: the arguments of another program ---------------------------------------------

const cliSchema = inputSchema(openclawCommands.cli) as {
  properties: Record<string, { type?: string; items?: { type?: string } }>;
  required: string[];
};
check("a variadic argument is an array in the schema", cliSchema.properties.args?.type, "array");
check("its items are strings", cliSchema.properties.args?.items?.type, "string");
check("a required variadic is required", cliSchema.required.includes("args"), true);

check(
  "a variadic list becomes argv in order",
  toArgv(openclawCommands.cli, { confirm: true, args: ["config", "get", "gateway.mode"] }),
  ["config", "get", "gateway.mode"],
);
check(
  "values keep their spaces rather than being re-split",
  toArgv(openclawCommands.cli, { confirm: true, args: ["agent", "-m", "two words"] }),
  ["agent", "-m", "two words"],
);
check("an absent variadic contributes nothing", toArgv(openclawCommands.cli, { confirm: true }), []);

check("a well-formed variadic passes validation", validate(openclawCommands.cli, { args: ["status"] }), []);
check(
  "a variadic given a bare string is refused",
  validate(openclawCommands.cli, { args: "status" }),
  ["args takes a list of non-empty strings"],
);
check(
  "a variadic containing a non-string is refused",
  validate(openclawCommands.cli, { args: ["status", 7] }),
  ["args takes a list of non-empty strings"],
);
check(
  "a variadic containing an empty string is refused",
  validate(openclawCommands.cli, { args: ["status", ""] }),
  ["args takes a list of non-empty strings"],
);
check("a missing required variadic is reported", validate(openclawCommands.cli, {}), ["args is required"]);

process.stderr.write(failed === 0 ? "all argument checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
