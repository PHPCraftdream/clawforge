// The per-call effectOf resolver: a narrow extension point in the confirm stage.
//
// Every case below runs the real pipeline (executeBody, needs: "nothing" so no deployment is
// built) and asserts structure — the observed stages, the error class, reachability — never
// rendered prose:
//
//   - an action whose effectOf returns { effect: "change", confirm: true } owes an MCP
//     confirmation like a destroy does, and the resolver runs BEFORE the confirm decision
//     (prepare is never reached on a refusal);
//   - effectOf returning read lowers the call (no confirm), returning undefined keeps the
//     static facts, throwing keeps them too (fail closed — a resolver error never skips a
//     confirmation);
//   - a declared read flag given wins over the resolver: effectOf is not consulted at all;
//   - a shape without effectOf behaves exactly as before (change needs no confirmation).

import { commandBody, ConfirmationRequiredError, defineAction, multiActionBody } from "#framework/core/command/index.ts";
import { executeBody, type Execution, type Stage } from "#framework/core/command/execute.ts";
import type { CommandBody } from "#framework/core/command/spec.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

/** The observed stages of one execution, through the CommandIo seam. */
async function run(body: CommandBody, argv: readonly string[], io: { surface: "terminal" | "mcp"; confirmed?: boolean }): Promise<{ execution: Execution; stages: Stage[] }> {
  const stages: Stage[] = [];
  const execution = await executeBody("fixture", body, { kind: "argv", argv: [...argv] }, { ...io, observe: (stage) => stages.push(stage) });
  return { execution, stages };
}

// --- a resolver that requires confirmation on a change -----------------------------------------

const APPLY = multiActionBody({
  effect: "read",
  action: { description: "what to do" },
  actions: {
    apply: defineAction({
      summary: "apply from the manifest",
      effect: "change",
      needs: "nothing",
      effectOf: async () => ({ effect: "change", confirm: true }),
      run: async () => {},
    }),
    probe: defineAction({ summary: "probe", effect: "read", needs: "nothing", run: async () => {} }),
  },
});

{
  const { execution, stages } = await run(APPLY, ["apply"], { surface: "mcp" });
  check("an unconfirmed resolved change stops at the confirm stage", execution.stage, "confirm");
  checkTrue("the refusal is a ConfirmationRequiredError", execution.error instanceof ConfirmationRequiredError);
  checkTrue("the confirm decision ran before prepare", stages.includes("parse") && !stages.includes("prepare"));
  check("the refusal carries the resolved facts", execution.facts, { effect: "change", confirm: true });

  const terminal = await run(APPLY, ["apply"], { surface: "terminal" });
  check("the same call on the terminal reaches prepare", terminal.stages.includes("prepare"), true);

  const confirmed = await run(APPLY, ["apply"], { surface: "mcp", confirmed: true });
  check("confirm: true passes the resolved change through", confirmed.execution.stage, "run");
}

// --- a resolver that lowers the call to read -----------------------------------------------------

const LOWERS = multiActionBody({
  effect: "change",
  action: { description: "what to do" },
  actions: {
    sync: defineAction({
      summary: "syncs when the manifest is empty",
      effect: "change",
      needs: "nothing",
      effectOf: async () => ({ effect: "read" }),
      run: async () => {},
    }),
  },
});

{
  const { execution } = await run(LOWERS, ["sync"], { surface: "mcp" });
  check("a resolved read passes confirm without confirm: true", execution.stage, "run");
  check("the facts carry the resolved effect, no confirm", execution.facts, { effect: "read" });
}

// --- a resolver that keeps the static effect, and one that throws --------------------------------

const UNDEFINED_RESOLVER = commandBody({
  effect: "destroy",
  arguments: [],
  needs: "nothing",
  effectOf: async () => undefined,
  run: async () => {},
});
const THROWING_RESOLVER = commandBody({
  effect: "destroy",
  arguments: [],
  needs: "nothing",
  effectOf: async () => {
    throw new Error("resolver blew up");
  },
  run: async () => {},
});

{
  const undefinedResolver = await run(UNDEFINED_RESOLVER, [], { surface: "mcp" });
  check("an undefined result keeps the static destroy (confirm stage)", undefinedResolver.execution.stage, "confirm");
  check("an undefined result keeps the static facts", undefinedResolver.execution.facts, { effect: "destroy" });

  const throwing = await run(THROWING_RESOLVER, [], { surface: "mcp" });
  check("a throwing resolver keeps the static destroy (confirm stage)", throwing.execution.stage, "confirm");
  checkTrue("the throw still refuses as a confirmation", throwing.execution.error instanceof ConfirmationRequiredError);
  check("a throwing resolver keeps the static facts", throwing.execution.facts, { effect: "destroy" });
}

// --- a declared read flag given wins: the resolver is not consulted -------------------------------

let consulted = false;
const FLAG_READ = multiActionBody({
  effect: "destroy",
  action: { description: "what to do" },
  actions: {
    plan: defineAction({
      summary: "plans instead of applying",
      effect: "destroy",
      needs: "nothing",
      arguments: [{ name: "dry-run", kind: "flag", description: "show what would change", effect: "read" }],
      effectOf: async () => {
        consulted = true;
        throw new Error("the resolver must not run for a declared read");
      },
      run: async () => {},
    }),
  },
});

{
  consulted = false;
  const { execution } = await run(FLAG_READ, ["plan", "--dry-run"], { surface: "mcp" });
  check("a declared read flag given passes without confirm: true", execution.stage, "run");
  checkTrue("the resolver was never consulted", consulted === false);
}

// --- a shape without effectOf is unaffected -------------------------------------------------------

const PLAIN = commandBody({ effect: "change", arguments: [], needs: "nothing", run: async () => {} });

{
  const { execution } = await run(PLAIN, [], { surface: "mcp" });
  check("an existing change command still needs no confirmation", execution.stage, "run");
  check("its facts are the static ones", execution.facts, { effect: "change" });
}

finish("command: the per-call effectOf resolver");
