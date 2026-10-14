// Cancellation safety regressions for local and SSH-shaped transports.
import { spawnLocal } from "#framework/runtime/transport/exec.ts";
import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { warn } from "#framework/core/io/log.ts";
import { withTeardown } from "#framework/commands/management/recipe/recovery/trial/teardown.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(name: string, predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end) await delay(5);
  checkTrue(name, predicate());
}

interface Captured { readonly signal?: AbortSignal; readonly timeoutMs?: number; }
async function localMutation(kind: "build" | "copy" | "mkdir"): Promise<void> {
  const root = await useRecipesRoot(`recipe-trial-signal-local-${kind}`);
  try {
    await root.write("subject", { description: "Pending local mutation", privatePaths: ["state"] });
    const fixture = trialFixture();
    (fixture.ctx.transport as { cancellation: "confirmed-local" }).cancellation = "confirmed-local";
    const timeline: string[] = [];
    const calls: Captured[] = [];
    let pending = false;
    let settle!: () => void;
    const inner = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
    fixture.ctx.transport.exec = async (command: string, args: string[], options?: unknown) => {
      const captured = (options ?? {}) as Captured;
      const target = kind === "mkdir" ? command === "mkdir" && args[0] === "-m" && args[1] === "700"
        : kind === "copy" ? command === "sh" && args[0] === "-c" && args[2] === "recipe-trial-copy"
        : command === "sh" && args[0] === "-c" && args[2] === "recipe-docker" && args.includes("build");
      if (target) {
        pending = true;
        calls.push(captured);
        await new Promise<void>((resolve) => {
          settle = () => { timeline.push("settled"); pending = false; resolve(); };
          captured.signal?.addEventListener("abort", settle, { once: true });
          if (captured.signal?.aborted) settle();
          if (captured.signal === undefined) setTimeout(settle, 25);
        });
        return { code: 1, stdout: "", stderr: "cancelled" };
      }
      if (command === "docker" && args.includes("down")) timeline.push("down");
      if (command === "rm" && args[0] === "-rf") timeline.push("remove-home");
      return inner(command, args, options as never);
    };
    const onOrig = process.on.bind(process);
    const rmOrig = process.removeListener.bind(process);
    const exitOrig = process.exit.bind(process);
    const handlers = new Map<string, () => void>();
    (process as unknown as { on: unknown }).on = (s: string, fn: () => void) => { handlers.set(s, fn); };
    (process as unknown as { removeListener: unknown }).removeListener = () => process;
    let exitCode: number | undefined;
    (process as unknown as { exit: unknown }).exit = (code?: number) => { exitCode = code ?? 0; };
    try {
      const running = runTrialAction(fixture.ctx, ref("subject"));
      await until(`${kind} reaches pending mutation`, () => pending);
      handlers.get("SIGINT")?.();
      await until(`${kind} settles`, () => timeline.includes("settled"));
      await until(`${kind} exits after teardown`, () => exitCode !== undefined);
      check(`${kind} local signal exit`, exitCode, 130);
      checkTrue(`${kind} bounded abort`, calls.length > 0 && calls.every((c) => c.signal instanceof AbortSignal && (c.timeoutMs ?? 0) > 0));
      checkTrue(`${kind} cleanup followed settlement`, timeline.indexOf("settled") < timeline.indexOf("remove-home"));
      await running.catch(() => undefined);
    } finally {
      (process as unknown as { on: unknown }).on = onOrig;
      (process as unknown as { removeListener: unknown }).removeListener = rmOrig;
      (process as unknown as { exit: unknown }).exit = exitOrig;
    }
  } finally { await root.dispose(); }
}

await localMutation("build");
await localMutation("copy");
await localMutation("mkdir");

async function sshWait(secondSignal: boolean): Promise<void> {
  const onOrig = process.on.bind(process);
  const rmOrig = process.removeListener.bind(process);
  const exitOrig = process.exit.bind(process);
  const handlers = new Map<string, () => void>();
  (process as unknown as { on: unknown }).on = (s: string, fn: () => void) => { handlers.set(s, fn); };
  (process as unknown as { removeListener: unknown }).removeListener = () => process;
  let exitCode: number | undefined;
  (process as unknown as { exit: unknown }).exit = (code?: number) => { exitCode = code ?? 0; };
  const project = secondSignal ? "ssh-second-project" : "ssh-late-project";
  const home = `/tmp/${project}`;
  const controller = new AbortController();
  const events: string[] = [];
  let resource = false;
  let lateTimer: ReturnType<typeof setTimeout> | undefined;
  let signalAt = 0;

  try {
    const output: string[] = [];
    const run = withOutputSink((chunk) => output.push(chunk), () => withTeardown({ project, home, envFile: "", overrideFile: "", pinnedFile: "", dataDir: "", definitionFile: "" }, async (register) => {
      register({ name: "remove late resource", run: async () => { events.push("cleanup"); resource = false; } });
      await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      lateTimer = setTimeout(() => { resource = true; events.push("remote-late-create"); }, 50);
    }, () => controller.abort(), 1000, "local-only", () => true, () => 120,
    () => warn(`SSH target mutation wait for project "${project}" at ${home}`)));
    signalAt = Date.now();
    handlers.get("SIGINT")?.();
    await until("SSH wait begins", () => output.some((chunk) => chunk.includes(`project "${project}" at ${home}`)) || output.some((chunk) => chunk.includes("waiting through watchdog rounding")));
    if (secondSignal) handlers.get("SIGINT")?.();

    await until("SSH signal path exits", () => exitCode !== undefined);
    if (secondSignal) {
      check("second signal exits nonzero", exitCode, 1);
      checkTrue("second signal leaves named resources without cleanup", !events.includes("cleanup"));
      checkTrue("diagnostic identity", output.some((chunk) => chunk.includes("project" + String.fromCharCode(32) + `"${project}"` + String.fromCharCode(32) + "at" + String.fromCharCode(32) + home)));

      checkTrue("second signal cancels pending fake late mutation", lateTimer !== undefined);
      checkTrue("named project and home", output.some((chunk) => chunk.includes("project" + String.fromCharCode(32) + `"${project}"`) && chunk.includes(home)));
    } else {
      await run;
      check("SSH signal exit", exitCode, 130);
      check("SSH target wait respects the watchdog duration", Date.now() - signalAt >= 120, true);
      checkTrue("late mutation happened before cleanup", events.indexOf("remote-late-create") < events.indexOf("cleanup"));
      checkTrue("late resource was created and removed", events.includes("remote-late-create") && events.includes("cleanup") && !resource);
    }
  } finally {
    (process as unknown as { on: unknown }).on = onOrig;
    (process as unknown as { removeListener: unknown }).removeListener = rmOrig;
    (process as unknown as { exit: unknown }).exit = exitOrig;
  }
}
await sshWait(false);
await sshWait(true);

// A scope that ignores abort remains fail-closed.
{
  const handlers = new Map<string, () => void>();
  const onOrig = process.on.bind(process);
  const rmOrig = process.removeListener.bind(process);
  const exitOrig = process.exit.bind(process);
  (process as unknown as { on: unknown }).on = (s: string, fn: () => void) => { handlers.set(s, fn); };
  (process as unknown as { removeListener: unknown }).removeListener = () => process;
  let exitCode: number | undefined;
  (process as unknown as { exit: unknown }).exit = (code?: number) => { exitCode = code ?? 0; };
  let cleaned = false;
  try {
    const run = withTeardown({ project: "stubborn", home: "/tmp/stubborn", envFile: "", overrideFile: "", pinnedFile: "", dataDir: "", definitionFile: "" }, async (register) => {
      register({ name: "destructive", run: async () => { cleaned = true; } });
      await new Promise<void>(() => {});
    }, undefined, 10, "confirmed-local");
    handlers.get("SIGTERM")?.();
    await until("unsettled scope exits nonzero", () => exitCode !== undefined);
    check("unsettled scope exit", exitCode, 1);
    checkTrue("unsettled scope starts no cleanup", !cleaned);
    void run.catch(() => undefined);
  } finally {
    (process as unknown as { on: unknown }).on = onOrig;
    (process as unknown as { removeListener: unknown }).removeListener = rmOrig;
    (process as unknown as { exit: unknown }).exit = exitOrig;
  }
}
const childController = new AbortController();
const child = spawnLocal(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { allowFailure: true, timeoutMs: 10_000, signal: childController.signal });
childController.abort();
const childResult = await child;
checkTrue("child process terminated", childResult.code !== 0 && childResult.timedOut === undefined);
finish("recipe-trial-round4-signal-pending");
