// `clawforge status` — what is running and whether it is actually healthy.
//
// One addition came out of a real bug: the
// runtime's own health verdict is shown next to the HTTP probes, because the two can
// disagree — an image whose healthcheck binary is missing reports "unhealthy" forever
// while the gateway serves traffic.

import { log, info, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { NotBootstrapped } from "#src/runtime/runtime.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import { unreachableProblem } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";
import { summarizeExposure, exposureOneLiner } from "#src/commands/operate/expose/index.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";

export const STATUS_ARGUMENTS = [
  { name: "json", description: "Emit status as JSON instead of text", kind: "flag" },
] as const;

/** The command body; status(ctx, args) stays for callers that already hold a Context. */
export const STATUS = commandBody({
  effect: "read",
  arguments: STATUS_ARGUMENTS,
  async run(ctx, { json }) {
    await runStatus(ctx, json === true);
  },
});

export async function status(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(STATUS, ctx, args);
}

async function runStatus(ctx: Context, jsonOnly: boolean): Promise<void> {
  if (jsonOnly || isCaptured()) {
    await emitStatusReport(ctx);
    return;
  }

  info(`target: ${ctx.transport.description} / runtime: ${ctx.runtime.description}`);

  // The exposure line and showStatus() both reach the target, so both sit inside this one
  // try: an unreachable target must be reported the same way either time. NotBootstrapped
  // means the target is reachable but nothing is there yet — caught here so status answers
  // plainly instead of crashing, skipping every other runtime call below.
  try {
    info(`exposure: ${exposureOneLiner(summarizeExposure(ctx, await ctx.runtime.runningConnectionFacts?.()))} — details: ${commandLine("expose status")}`);

    log("containers");
    await ctx.runtime.showStatus();
  } catch (error) {
    if (error instanceof TransportUnreachableError) {
      const found = unreachableProblem(error);
      // The remedy rides as advice (rf6-fix33): formatError renders the arrow line, so
      // the headline alone is thrown — no hand-spelled second copy of nextAction here.
      die(`${found.code}  ${found.detail}`, found.next);
    }
    if (!(error instanceof NotBootstrapped)) throw error;
    info(`nothing deployed yet — run ${commandLine("bootstrap")}`);
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
  // Both calls reach the target, so both sit in the one try: an unreachable target can fail
  // on the exposure read before isRunning() ever runs.
  let exposure: ReturnType<typeof summarizeExposure> | undefined;
  let running: boolean;
  try {
    exposure = summarizeExposure(ctx, await ctx.runtime.runningConnectionFacts?.());
    running = await ctx.runtime.isRunning();
  } catch (error) {
    if (error instanceof TransportUnreachableError) {
      const found = unreachableProblem(error);
      emit(
        `${JSON.stringify(
          {
            target: ctx.transport.description,
            runtime: ctx.runtime.description,
            // The whole shared-builder problem, severity and advice included — the shape
            // inspect/doctor serialize, not a hand-picked subset (rf6-fix33).
            problem: found,
          },
          null,
          2,
        )}\n`,
      );
      die(`${found.code}  ${found.detail}`, found.next);
    }
    if (!(error instanceof NotBootstrapped)) throw error;
    emit(
      `${JSON.stringify(
        {
          target: ctx.transport.description,
          runtime: ctx.runtime.description,
          // Not yet assigned only if the exposure read itself is what threw NotBootstrapped;
          // the target is still reachable either way, so the local-only fallback answers it.
          exposure: exposure ?? summarizeExposure(ctx, undefined),
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
