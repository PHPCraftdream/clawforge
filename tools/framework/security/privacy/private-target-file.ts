import { randomBytes } from "node:crypto";
import type { Context } from "../../core/context.ts";
import { OWNER, needsOwnerEscalation, runMaybePrivileged } from "../../runtime/datadir.ts";
import { PRIVATE_STAGING_MARKER, privateWriteCommand } from "../../runtime/transport/quoting.ts";

/** Publishes private target content atomically, with its runtime owner set before rename. */
export async function publishPrivateTargetFile(ctx: Context, path: string, content: string): Promise<void> {
  const staging = `${path}${PRIVATE_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  let created = false;
  try {
    if (typeof ctx.transport.writePrivateFile === "function") {
      await ctx.transport.writePrivateFile(staging, content);
    } else {
      const [command, args] = privateWriteCommand(staging);
      await ctx.transport.exec(command, args, { input: content });
    }
    created = true;
    await runMaybePrivileged(ctx, staging, "chown", [OWNER, staging], { force: await needsOwnerEscalation(ctx, OWNER) });
    await runMaybePrivileged(ctx, staging, "mv", ["-fT", "--", staging, path]);
  } catch (error) {
    if (created) await runMaybePrivileged(ctx, staging, "rm", ["-f", "--", staging]).catch(() => {});
    throw error;
  }
}
