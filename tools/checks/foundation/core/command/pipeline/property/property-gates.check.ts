// The gate registry's declaration sweep: effect declared, the MCP confirm schema derived
// from it, a destructive gate command's tool call refused before running, and required-
// argument and `choices` refusals byte-identical console-vs-MCP. Split from
// property.check.ts for the source layout's line cap; no deployment fixture is needed —
// declaration-only, no pipeline run.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { commandRegistry } from "#framework/integration/gate.ts";
import { checkoutGate, installedGate } from "#framework/entry/registry.ts";
import { effectProfile, bind, bindNamed, callFacts, parseCall, requiredArgumentRefusal, specData, specOf, specShape, tokenize } from "#framework/core/command/index.ts";
import type { ArgumentSpec, Effect } from "#framework/core/command/index.ts";
import { inputSchema } from "#framework/integration/mcp/server.ts";

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
    // The effect lives in the body now (design D6); the profile, the schema and the confirm
    // stage all read it through specOf — no second `effect` field to agree with.
    const effect = (specData(specOf(command)!) as { effect: Effect }).effect;
    check(`${entry.name}: the effect is declared in the body`, ["read", "change", "destroy"].includes(effect), true);
    const profile = effectProfile(command);
    const schema = inputSchema(command) as { properties: Record<string, unknown>; required: string[] };
    if (profile.destructive) {
      checkTrue(`${entry.name}: the MCP schema declares confirm`, schema.properties.confirm !== undefined);
      if (profile.alwaysDestroys) checkTrue(`${entry.name}: confirm is required in the schema`, schema.required.includes("confirm"));
      // The confirm stage is the pipeline's own (executeBody), shared with the deployment's
      // commands — pinned here from the declaration: the destructive call reads as destroy
      // (so MCP owes confirm), the bare call as the body's base effect (so it does not).
      const shape = specShape(specOf(command)!);
      const yesFlags = (command.arguments ?? []).filter((argument) => argument.kind === "flag" && (argument as { effect?: Effect }).effect !== undefined && (argument as { effect?: Effect }).effect !== "read").map((argument) => `--${argument.name}`);
      const example = (command.arguments ?? []).filter((argument) => argument.kind === "positional").map(() => "demo");
      check(`${entry.name}: the dry-run call reads as the base effect`, callFacts(shape, parseCall(shape, example)).effect, effect);
      if (yesFlags.length > 0) {
        check(`${entry.name}: the destructive flag form reads as destroy — MCP owes confirm`, callFacts(shape, parseCall(shape, [...yesFlags, ...example])).effect, "destroy");
      }
    } else {
      checkTrue(`${entry.name}: a non-destructive gate command declares no confirm`, schema.properties.confirm === undefined);
    }
    for (const argument of command.arguments ?? []) {
      if (argument.required !== true) continue;
      // Gate commands are spec bodies now: the console and the MCP dispatch both refuse the
      // missing operand in the binder's own required voice — validate is shape-only.
      let consoleRefusal: string | undefined;
      try {
        parseCall(specShape(specOf(command)!), [], entry.name);
      } catch (error) {
        consoleRefusal = (error as Error).message;
      }
      check(`${entry.name}: a missing required ${argument.name} is refused in the binder's voice`,
        requiredArgumentRefusal(argument as ArgumentSpec, entry.name), consoleRefusal);
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
      // Choices are the parser's for a spec body: the named dispatch (bindNamed) must refuse
      // in the same words the console argv does — one shared builder (review R17).
      let namedRefusal: string | undefined;
      try {
        bindNamed(specShape(specOf(entry)!), { kind: "named", args: { [argument.name]: value } }, entry.name);
      } catch (error) {
        namedRefusal = (error as Error).message;
      }
      check(`${entry.name} ${argument.name}: one choices voice`, consoleRefusal ?? "", namedRefusal ?? "");
    }
  }
}

finish("pipeline: gate commands — effects, confirmation, one voice");
