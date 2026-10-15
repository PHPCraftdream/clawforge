// Signal teardown: the product registers `process.on` handlers for SIGINT/SIGTERM/SIGHUP
// that run the SAME teardown step list and exit 128+n. The handlers are captured here by
// temporarily replacing process.on/removeListener (the registration call is the product's
// own, inside withTeardown), the SIGINT handler is invoked while the body is parked on a
// never-answered readiness poll, and process.exit is intercepted so the check survives: the
// same down + image rm + scratch-removal steps must run and the exit code must be 130.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { ref, trialFixture, useRecipesRoot } from "../fixture.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(name: string, condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 10_000 && !condition(); waited += 20) await sleep(20);
  checkTrue(name, condition());
}

const root = await useRecipesRoot("clawforge-recipe-trial-signals");
try {
  await root.write("subject", { description: "A recipe with a build service and a readiness poll" });
  const fixture = trialFixture();
  // A build service so the teardown's image-rm step has a recorded tag to remove.
  fixture.baseConfigJson = JSON.stringify({ services: {
    app: { build: { context: "." }, ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }] },
  } });

  // Park the readiness poll forever until the signal path has been observed.
  let release: (() => void) | undefined;
  const held = new Promise<Record<string, { running: boolean; health?: string }>>((resolveHold) => { release = () => resolveHold({}); });
  const stackOriginal = fixture.ctx.runtime.stack;
  fixture.ctx.runtime.stack = ((project: string, definitionPath: string, options: Parameters<typeof stackOriginal>[2]) => {
    void stackOriginal(project, definitionPath, options);
    return { serviceStates: () => held };
  }) as typeof stackOriginal;

  const onOriginal = process.on.bind(process);
  const removeListenerOriginal = process.removeListener.bind(process);
  const exitOriginal = process.exit.bind(process);
  const handlers = new Map<string, () => void>();
  (process as unknown as { on: unknown }).on = (signal: string, handler: () => void) => { handlers.set(signal, handler); };
  (process as unknown as { removeListener: unknown }).removeListener = () => {};
  let exitCode: number | undefined;
  (process as unknown as { exit: unknown }).exit = (code?: number) => { exitCode = code ?? 0; };

  try {
    const run = runTrialAction(fixture.ctx, ref("subject"));
    await waitFor("the trial reached compose up before the signal", () => fixture.docker.some((argv) => argv.includes("up")));
    const handler = handlers.get("SIGINT");
    checkTrue("the SIGINT handler was registered on the real process", handler !== undefined);
    handler?.();

    await waitFor("the signal teardown finished and asked to exit", () => exitCode !== undefined);
    check("the signalled run exits 128+2", exitCode, 130);
    checkTrue("the teardown ran compose down", fixture.docker.some((argv) => argv.includes("down") && argv.includes("--volumes")));
    checkTrue("the teardown ran the trial build image rm", fixture.docker.some((argv) => argv[0] === "image" && argv[1] === "rm" && argv[2] === "--force"));
    checkTrue("the teardown removed the scratch home", fixture.removed.some((p) => p.includes(".clawforge-recipe-trial-")));
    checkTrue("no build-tagged image argv carries a live image", fixture.docker.every((argv) => !argv.includes("nginx")));

    // Release the parked body so the check process can end cleanly; the run's own epilogue
    // re-enters process.exit with the signal code, which the stub keeps recording. The
    // released body may answer ready or die on the empty poll — either way it must end the
    // signalled run at 130, not crash the check.
    release?.();
    let releasedError = "";
    try { await run; } catch (error) { releasedError = error instanceof Error ? error.message : String(error); }
    check("the signalled exit code stands after the body ends", exitCode, 130);
    checkTrue("the released body ended in the trial's own exit paths", releasedError === "" || /ready|teardown|refuses/.test(releasedError));
  } finally {
    (process as unknown as { on: unknown }).on = onOriginal;
    (process as unknown as { removeListener: unknown }).removeListener = removeListenerOriginal;
    (process as unknown as { exit: unknown }).exit = exitOriginal;
  }
} finally {
  await root.dispose();
}

finish("recipe-trial-signals");
