// `./clawforge status` — what is running and whether it is actually healthy.
//
// One addition came out of a real bug: the
// runtime's own health verdict is shown next to the HTTP probes, because the two can
// disagree — an image whose healthcheck binary is missing reports "unhealthy" forever
// while the gateway serves traffic.

import { log, info } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { NotBootstrapped } from "#src/runtime/runtime.ts";
import type { Context } from "#src/core/context.ts";
import { summarizeExposure, exposureOneLiner } from "#src/commands/operate/expose/index.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";

/** Drives both status's own parser and its openclawCommands declaration. */
export const STATUS_ARGUMENTS: CommandArgument[] = [
  { name: "json", description: "Emit status as JSON instead of text", kind: "flag" },
];

export async function status(ctx: Context, args: string[]): Promise<void> {
  const jsonOnly = parseDeclaredArgs(STATUS_ARGUMENTS, args).json === true;

  if (jsonOnly || isCaptured()) {
    await emitStatusReport(ctx);
    return;
  }

  info(`target: ${ctx.transport.description} / runtime: ${ctx.runtime.description}`);
  info(`exposure: ${exposureOneLiner(summarizeExposure(ctx, await ctx.runtime.runningConnectionFacts?.()))} — details: ./clawforge expose status`);

  log("containers");
  // showStatus() shells out to compose, which needs somewhere to write its own private env
  // file beside the data directory — absent pre-bootstrap, which is exactly the mkdir a
  // still-root-owned parent refuses. NotBootstrapped is how the runtime says so instead of a
  // raw transport error; caught here so status answers plainly instead of crashing,
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

/** The machine-readable counterpart of the text path above. Never the raw `docker compose
 *  ps` table showStatus() streams straight to the terminal — that is not structured data —
 *  so `running` (isRunning(), the one fact every Runtime can answer) stands in for it. */
async function emitStatusReport(ctx: Context): Promise<void> {
  const exposure = summarizeExposure(ctx, await ctx.runtime.runningConnectionFacts?.());

  let running: boolean;
  try {
    running = await ctx.runtime.isRunning();
  } catch (error) {
    if (!(error instanceof NotBootstrapped)) throw error;
    emit(
      `${JSON.stringify(
        {
          target: ctx.transport.description,
          runtime: ctx.runtime.description,
          exposure,
          bootstrapped: false,
          running: false,
          image: null,
          health: null,
          serviceUrl: null,
          dataUsage: null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const reference = await ctx.runtime.imageReference();
  const health = {
    healthz: await ctx.runtime.probe("healthz"),
    startupz: await ctx.runtime.probe("startupz"),
    readyz: await ctx.runtime.probe("readyz"),
    runtime: await ctx.runtime.health(),
  };

  const usage = await ctx.transport.exec(
    "du",
    ["-sh", `${ctx.settings.dataDir}/config`, `${ctx.settings.dataDir}/workspace`, `${ctx.settings.dataDir}/auth-secrets`],
    { allowFailure: true },
  );
  const dataUsage = usage.code === 0
    ? usage.stdout
      .trimEnd()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const tab = line.indexOf("\t");
        return tab === -1
          ? { size: line.trim(), path: "" }
          : { size: line.slice(0, tab).trim(), path: line.slice(tab + 1).trim() };
      })
    : null;

  emit(
    `${JSON.stringify(
      {
        target: ctx.transport.description,
        runtime: ctx.runtime.description,
        exposure,
        bootstrapped: true,
        running,
        image: reference ?? null,
        health,
        serviceUrl: ctx.settings.serviceUrl,
        dataUsage,
      },
      null,
      2,
    )}\n`,
  );
}
