// Shared by the state checks: the mutation guard a modelled target transport needs on top of its
// own stubs — the atomic `mkdir` claim, `ln` and `rmdir` of the instance's operation.mutation
// directory. This module has no top-level side effects — check files import it.

import type { Context } from "#framework/core/context.ts";

export function modelMutationGuard(ctx: Context): void {
  const exec = ctx.transport.exec.bind(ctx.transport);
  let held = false;
  ctx.transport.exec = async (command, args, options) => {
    const target = command === "test" && args[0] === "-d" ? args[1] ?? "" : args[0] ?? "";
    if (command === "mkdir" && target.endsWith("/operation.mutation")) {
      if (held) return { code: 1, stdout: "", stderr: "File exists" };
      held = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "ln") {
      const [source, destination] = args;
      if (source === undefined || destination === undefined) return { code: 1, stdout: "", stderr: "Invalid link" };
      try {
        if (await ctx.transport.exists(destination)) return { code: 1, stdout: "", stderr: "File exists" };
        await ctx.transport.writeFile(destination, await ctx.transport.readFile(source));
        return { code: 0, stdout: "", stderr: "" };
      } catch {
        return { code: 1, stdout: "", stderr: "No such file" };
      }
    }
    if (command === "test" && args[0] === "-d" && target.endsWith("/operation.mutation")) {
      return { code: held ? 0 : 1, stdout: "", stderr: "" };
    }
    if (command === "rmdir" && target.endsWith("/operation.mutation")) {
      held = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    return exec(command, args, options);
  };
}
