import { randomBytes } from "node:crypto";
import type { Context } from "../../core/context.ts";
import { OWNER, needsOwnerEscalation, runMaybePrivileged, sudoFor } from "../../runtime/datadir.ts";
import { PRIVATE_STAGING_MARKER, privateWriteCommand } from "../../runtime/transport/quoting.ts";

/** Publishes private target content atomically, with its runtime owner set before rename. */
export async function publishPrivateTargetFile(ctx: Context, path: string, content: string): Promise<void> {
  const staging = `${path}${PRIVATE_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  let created = false;
  const prefix = await sudoFor(ctx, path);
  try {
    if (prefix.length === 0 && typeof ctx.transport.writePrivateFile === "function") {
      await ctx.transport.writePrivateFile(staging, content);
    } else {
      const [command, args] = privateWriteCommand(staging);
      const [head, ...rest] = [...prefix, command, ...args];
      await ctx.transport.exec(head, rest, { input: content });
    }
    created = true;
    await runMaybePrivileged(ctx, staging, "chown", [OWNER, staging], { force: await needsOwnerEscalation(ctx, OWNER) });
    await runMaybePrivileged(ctx, staging, "mv", ["-fT", "--", staging, path]);
  } catch (error) {
    if (created) await runMaybePrivileged(ctx, staging, "rm", ["-f", "--", staging]).catch(() => {});
    throw error;
  }
}
