// The gate registry's declaration sweep: effect declared, the MCP confirm schema derived
// from it, a destructive gate command's tool call refused before running, and required-
// argument and `choices` refusals byte-identical console-vs-MCP. Split from
// property.check.ts for the source layout's line cap; no deployment fixture is needed —
// declaration-only, no pipeline run.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { commandRegistry } from "#framework/integration/gate.ts";
import { checkoutGate, installedGate } from "#framework/entry/registry.ts";
import { CONFIRM_REQUIRED, effectProfile, bind, tokenize } from "#framework/core/command/index.ts";
import type { ArgumentSpec } from "#framework/core/command/index.ts";
import { inputSchema } from "#framework/integration/mcp/server.ts";
import { gateConfirmationRefusal, validate } from "#framework/integration/mcp/call.ts";

// --- gate commands: effect declared, destructive confirmed, required enforced -----------------
//
// Every registry entry of origin "gate", from both gates: the effect is declared once, the
// MCP tool schema's confirm field derives from it, a destructive gate command's tool call is
// refused without confirm: true before anything runs, and required arguments are refused the
// same way the deployment's commands are.
for (const gate of [checkoutGate(), installedGate("<app-root>")]) {
  const registry = commandRegistry({ deployment: {}, gate, appName: "property-fixture" });
  for (const entry of registry.entries) {
    if (entry.origin !== "gate" || entry.gate === undefined) continue;
    const command = entry.gate;
    check(`${entry.name}: the effect is declared`, ["read", "change", "destroy"].includes(command.effect), true);
    const profile = effectProfile(command);
    const schema = inputSchema(command) as { properties: Record<string, unknown>; required: string[] };
    if (profile.destructive) {
      checkTrue(`${entry.name}: the MCP schema declares confirm`, schema.properties.confirm !== undefined);
      if (profile.alwaysDestroys) checkTrue(`${entry.name}: confirm is required in the schema`, schema.required.includes("confirm"));
      check(`${entry.name}: an MCP call without confirm is refused`, gateConfirmationRefusal(entry.name, command, {})?.includes(CONFIRM_REQUIRED), true);
      check(`${entry.name}: confirm: true answers no refusal`, gateConfirmationRefusal(entry.name, command, { confirm: true }), undefined);
    } else {
      checkTrue(`${entry.name}: a non-destructive gate command declares no confirm`, schema.properties.confirm === undefined);
      check(`${entry.name}: no refusal without confirm`, gateConfirmationRefusal(entry.name, command, {}), undefined);
    }
    for (const argument of command.arguments ?? []) {
      if (argument.required !== true) continue;
      let consoleRefusal: string | undefined;
      try {
        bind(command.arguments as readonly ArgumentSpec[], tokenize(command.arguments as readonly ArgumentSpec[], []), { command: entry.name });
      } catch (error) {
        consoleRefusal = (error as Error).message;
      }
      check(`${entry.name}: a missing required ${argument.name} reads as the console refusal`, validate(command, {}, { name: entry.name })[0], consoleRefusal);
    }
  }
}

// One voice for `choices`: for every declared choices argument of every gate command, the
// MCP validate's problem is byte-identical to what the console dispatch throws for the same
// argument and value — the parser's own refusal, one shared builder (review R17).
for (const gate of [checkoutGate(), installedGate("<app-root>")]) {
  for (const entry of gate) {
    for (const argument of entry.arguments ?? []) {
      const choices = (argument as { choices?: readonly string[] }).choices;
      if (choices === undefined || (argument.kind !== "option" && argument.kind !== "positional")) continue;
      let value = "outside-the-list";
      while (choices.includes(value)) value += "-x";
      let consoleRefusal: string | undefined;
      try {
        bind(entry.arguments as readonly ArgumentSpec[], tokenize(entry.arguments as readonly ArgumentSpec[], argument.kind === "positional" ? [value] : [`--${argument.name}`, value]), { command: entry.name });
      } catch (error) {
        consoleRefusal = (error as Error).message;
      }
      check(`${entry.name} ${argument.name}: one choices voice`, validate(entry, { [argument.name]: value }), [consoleRefusal ?? ""]);
    }
  }
}

finish("pipeline: gate commands — effects, confirmation, one voice");
