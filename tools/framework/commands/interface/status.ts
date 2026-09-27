// `./clawforge status` — what is running and whether it is actually healthy.
//
// One addition came out of a real bug: the
// runtime's own health verdict is shown next to the HTTP probes, because the two can
// disagree — an image whose healthcheck binary is missing reports "unhealthy" forever
// while the gateway serves traffic.

import { log, info } from "#src/core/log.ts";
import { NotBootstrapped } from "#src/runtime/runtime.ts";
import type { Context } from "#src/core/context.ts";
import { summarizeExposure, exposureOneLiner } from "#src/expose/index.ts";

export async function status(ctx: Context, _args: string[]): Promise<void> {
  info(`target: ${ctx.transport.description} / runtime: ${ctx.runtime.description}`);
  info(`exposure: ${exposureOneLiner(summarizeExposure(ctx, await ctx.runtime.runningConnectionFacts?.()))} — details: ./clawforge expose status`);

  log("containers");
  // showStatus() shells out to compose, which needs somewhere to write its own private env
  // file beside the data directory — absent pre-bootstrap, which is exactly the mkdir a
  // still-root-owned parent refuses. NotBootstrapped is how the runtime says so instead of a
  // raw transport error (UX-05); caught here so status answers plainly instead of crashing,
  // and every other runtime call below is skipped — there is nothing to report on any of
  // them either.
  try {
    await ctx.runtime.showStatus();
  } catch (error) {
    if (!(error instanceof NotBootstrapped)) throw error;
    info("nothing deployed yet — run ./clawforge bootstrap");
    return;
  }

  log("image");
  const reference = await ctx.runtime.imageReference();
  info(reference ?? `image ${ctx.settings.image} not present on the target`);

  log(`health probes at ${ctx.settings.serviceUrl}`);
  for (const endpoint of ["healthz", "startupz", "readyz"]) {
    const code = await ctx.runtime.probe(endpoint);
    info(`${endpoint.padEnd(9)} ${code === 0 ? "unreachable" : code}`);
  }
  info(`${"runtime".padEnd(9)} ${await ctx.runtime.health()}`);

  log("data usage");
  const usage = await ctx.transport.exec(
    "du",
    ["-sh", `${ctx.settings.dataDir}/config`, `${ctx.settings.dataDir}/workspace`, `${ctx.settings.dataDir}/auth-secrets`],
    { allowFailure: true },
  );
  if (usage.code === 0) {
    for (const line of usage.stdout.trimEnd().split("\n")) info(line);
  } else {
    info(`no readable data yet in ${ctx.settings.dataDir}`);
  }
}
