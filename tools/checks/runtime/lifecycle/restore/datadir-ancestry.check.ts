// assertCanonicalAncestry (runtime/datadir.ts) — one ancestry walk for datadir and restore.
//
// The two copies this helper replaced had drifted: restore's accepted an empty `readlink -f`
// answer with exit 0 (reading "cannot verify" as "verified") and datadir's ignored the
// caller's privilege prefix. Both behaviours are asserted here against a stub transport.

import { assertCanonicalAncestry } from "#framework/runtime/datadir.ts";
import { check, finish } from "#checks/kit/harness.ts";
import type { Context } from "#framework/core/context.ts";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

/** A transport stub: `readlink -f` answers `answer`, the exists probes report a path present
 *  unless it ends in "/missing" — so a walk from a missing leaf lands on its parent. */
function stubTransport(answer: { code: number; stdout: string; stderr: string }): { ctx: Context; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    transport: {
      exists: async (path: string) => !path.endsWith("/missing"),
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return command === "readlink" || args.includes("readlink") ? answer : { code: 1, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  return { ctx, calls };
}

async function outcome(ctx: Context, dataDir: string, prefix: string[] | ((probe: string) => Promise<string[]>) = []): Promise<string> {
  try {
    await assertCanonicalAncestry(ctx, dataDir, prefix);
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

{
  const { ctx, calls } = stubTransport({ code: 0, stdout: "/srv/app/data\n", stderr: "" });
  check("an ancestry that resolves to itself is accepted", await outcome(ctx, "/srv/app/data"), "accepted");
  check("the readlink ran on the deepest existing ancestor", calls[calls.length - 1], { command: "readlink", args: ["-f", "/srv/app/data"] });
}

{
  // The restore copy's hole: exit 0 with no path must refuse, not pass.
  const { ctx } = stubTransport({ code: 0, stdout: "  \n", stderr: "" });
  const emptyAnswer = await outcome(ctx, "/srv/app/data");
  check("an empty readlink answer with exit 0 is a refusal, not a confirmation", emptyAnswer.startsWith("cannot resolve"), true);
}

{
  const { ctx } = stubTransport({ code: 0, stdout: "/elsewhere/data", stderr: "" });
  check("an ancestry redirected through a symlink is refused", (await outcome(ctx, "/srv/app/data")).includes("sits behind a symlink"), true);
}

{
  // A prefix callback (restore's sudo wrapper) must reach the transport and receive the
  // probe the walk settled on, not the configured path.
  const { ctx, calls } = stubTransport({ code: 0, stdout: "/srv/app/data", stderr: "" });
  const seen: string[] = [];
  const message = await outcome(ctx, "/srv/app/data/missing", async (probe) => {
    seen.push(probe);
    return ["sudo", "-n"];
  });
  check("the walk lands on the deepest existing ancestor", seen, ["/srv/app/data"]);
  check("the privilege prefix is prepended to readlink", calls[calls.length - 1], { command: "sudo", args: ["-n", "readlink", "-f", "/srv/app/data"] });
  check("a canonical deepest ancestor is accepted", message, "accepted");
}

finish("datadir ancestry");
