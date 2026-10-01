// Per-action views of a multi-action command's declaration.

import type { CommandArgument } from "#src/core/app.ts";
import { specData, type ArgumentSpec, type CommandBody } from "#src/core/command/spec.ts";

/** One multi-action command's flags/options from what each action's own parser accepts:
 *  `actions` is derived (absent when every action takes it), so completion, --help and the MCP
 *  schema cannot offer a flag the chosen action rejects. First declaration of a name wins;
 *  slices must not set `actions` themselves. Positionals/variadics are not scoped, so skipped.
 *  When the slices describe one name differently (set's `--name`: the set for build/validate,
 *  the object for forget), the descriptions are composed with their own action lists instead
 *  of the first one silently standing for every action (R31-03). */
export function scopeByAction(slices: Readonly<Record<string, readonly CommandArgument[]>>): CommandArgument[] {
  const all = Object.keys(slices);
  const merged = new Map<string, { argument: CommandArgument; byDescription: Map<string, string[]>; actions: string[] }>();
  for (const action of all) {
    for (const argument of slices[action]) {
      if (argument.kind !== "flag" && argument.kind !== "option") continue;
      let entry = merged.get(argument.name);
      if (entry === undefined) merged.set(argument.name, entry = { argument, byDescription: new Map(), actions: [] });
      if (!entry.actions.includes(action)) entry.actions.push(action);
      const actions = entry.byDescription.get(argument.description) ?? [];
      if (!actions.includes(action)) actions.push(action);
      entry.byDescription.set(argument.description, actions);
    }
  }
  return [...merged.values()].map(({ argument, byDescription, actions }) => ({
    ...argument,
    ...(byDescription.size > 1
      ? {
        description: [...byDescription.entries()]
          .map(([description, own]) => `${description} (${own.join(", ")})`)
          .join("; "),
      }
      : {}),
    ...(actions.length === all.length ? {} : { actions }),
  }));
}

/** One composed description split into the segments scopeByAction wrote when the slices
 *  describe one name differently: every segment must end with its own action list, all of
 *  them within the argument's overall actions. Undefined otherwise — a plain description
 *  (or one whose parenthetical is not an action list, like "(default: …)") is not scoped. */
export function splitActionScoped(
  description: string,
  actions: readonly string[] | undefined,
): readonly { description: string; actions: readonly string[] }[] | undefined {
  if (actions === undefined) return undefined;
  const parts = description.split(";").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length < 2) return undefined;
  const split: { description: string; actions: readonly string[] }[] = [];
  for (const part of parts) {
    const match = /\s*\(([^()]*)\)$/.exec(part);
    const own = match === null ? undefined : match[1].split(",").map((token) => token.trim());
    if (own === undefined || !own.every((token) => actions.includes(token))) return undefined;
    split.push({ description: part.slice(0, part.length - match![0].length).trim(), actions: own });
  }
  return split;
}

/** What `arguments` shows for a body. A single action: its arguments as declared. A multi-action
 *  command: the positional `action` (choices in declaration order, required without a default
 *  action), the actions' positionals merged by name (first declaration, unscoped, required only
 *  when every action requires it), then flags and options through scopeByAction in "default
 *  action first, then declaration order" — `required` only when every action requires it.
 *  A name described differently by the actions gets a `summary` composed like its description,
 *  only when every part declares one. */
export function argumentsView(body: CommandBody): readonly CommandArgument[] {
  const data = specData(body);
  if (data.kind === "single") return data.arguments;

  const declared = Object.keys(data.actions);
  const order = data.defaultAction === undefined ? declared : [data.defaultAction, ...declared.filter((name) => name !== data.defaultAction)];
  const slices = Object.fromEntries(order.map((name) => [name, data.actions[name].arguments]));
  const everyAction = (match: (argument: ArgumentSpec) => boolean, name: string): boolean =>
    order.every((action) => slices[action].some((argument) => argument.name === name && match(argument)));

  const action: CommandArgument = {
    name: "action",
    description: data.action.description,
    ...(data.action.summary === undefined ? {} : { summary: data.action.summary }),
    kind: "positional",
    choices: declared,
    ...(data.defaultAction === undefined ? { required: true } : {}),
  };

  const positionals = new Map<string, ArgumentSpec>();
  for (const name of order) {
    for (const argument of slices[name]) {
      if (argument.kind === "positional" && !positionals.has(argument.name)) positionals.set(argument.name, argument);
    }
  }
  const merged = [...positionals.values()].map((argument): CommandArgument => {
    const { required: _required, ...rest } = argument as ArgumentSpec & { required?: boolean };
    return { ...rest, ...(everyAction((other) => (other as { required?: boolean }).required === true, argument.name) ? { required: true } : {}) };
  });

  const scoped = scopeByAction(slices).map((argument): CommandArgument => {
    const { required: _required, summary: _summary, ...rest } = argument as CommandArgument & { required?: boolean; summary?: string };
    const parts = new Map<string, string | undefined>();
    for (const name of order) {
      for (const other of slices[name]) {
        if (other.name === argument.name && !parts.has(other.description)) parts.set(other.description, other.summary);
      }
    }
    const summary = parts.size <= 1
      ? [...parts.values()][0]
      : [...parts.values()].every((part) => part !== undefined)
        ? [...parts.entries()].map(([description, part]) => `${part} (${order.filter((name) => slices[name].some((other) => other.name === argument.name && other.description === description)).join(", ")})`).join("; ")
        : undefined;
    return {
      ...rest,
      ...(summary === undefined ? {} : { summary }),
      ...(everyAction((other) => (other as { required?: boolean }).required === true, argument.name) ? { required: true } : {}),
    };
  });
  return [action, ...merged, ...scoped];
}
