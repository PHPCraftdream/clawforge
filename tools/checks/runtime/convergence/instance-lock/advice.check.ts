import { hostname } from "node:os";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import { ArgumentError } from "#framework/core/command/errors.ts";
import { UserError } from "#framework/core/io/log.ts";
import { guardedWith, observeInstanceLock } from "#framework/runtime/lock/instance-lock.ts";
import { machineName } from "#framework/runtime/lock/process-identity.ts";
import { createBackup } from "#framework/commands/lifecycle/backup/index.ts";
import { ROUND_TRIP_ENTRY, runArchiveChecks } from "#framework/commands/lifecycle/smoke/round-trip.ts";
import { captureFailure, FIXTURE_LOCK_HOME, FIXTURE_LOCK_PATH, stubContext } from "./fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";


const now = Date.now();
const fresh = new Date(now).toISOString();
const old = new Date(now - 3_600_000).toISOString();
const local = machineName();
const expectedPhysicalHost = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? hostname();
async function checkExpectedHost(label: string, host: unknown): Promise<void> {
  check(`${label}: host type`, typeof host, "string");
  const value = typeof host === "string" ? host : "";
  const separator = value.lastIndexOf(":");
  const scope = value.slice(separator + 1);
  check(`${label}: physical host`, [separator >= 0, value.slice(0, separator)], [true, expectedPhysicalHost]);
  await requires("linux-host", `${label}: Linux pid scope`, () => check(`${label}: Linux pid scope`, /^linux-(?:[1-9][0-9]*|unknown)$/.test(scope), true));
  await requires("windows-host", `${label}: Windows pid scope`, () => check(`${label}: Windows pid scope`, scope, "win32"));
}
const foreign = "advice-foreign:win32";
const holderPath = `${FIXTURE_LOCK_PATH}/holder.json`;
const guardPath = `${FIXTURE_LOCK_HOME}/operation.mutation`;
const base = { operationId: "independent-owner", what: "recipe install", by: "display only", generation: "seed-generation", takenAt: fresh };
const scenarios = [
  { name: "dead recent", record: { ...base, host: local, pid: 99999999 }, state: "dead", takeover: "explicit-break-lock", allowed: true },
  { name: "dead old", record: { ...base, takenAt: old, host: local, pid: 99999999 }, state: "dead", takeover: "explicit-break-lock", allowed: true },
  { name: "foreign", record: { ...base, host: foreign, pid: 99999999 }, state: "remote", takeover: "foreign-confirmation-required", allowed: true },
  { name: "live", record: { ...base, host: local, pid: process.pid }, state: "live", takeover: "none", allowed: false },
  { name: "heartbeat", record: { ...base, takenAt: old, heartbeatAt: fresh, host: local, pid: process.pid }, state: "live", takeover: "none", allowed: false },
  { name: "unknown identity", record: { ...base, takenAt: old, host: local, pid: 0 }, state: "unknown", takeover: "none", allowed: false },
  { name: "unreadable", record: undefined, state: "unknown", takeover: "none", allowed: false },
] as const;

for (const scenario of scenarios) {
  {
    const { ctx, files, dirs } = stubContext();
    const raw = scenario.record === undefined ? "not JSON" : JSON.stringify(scenario.record);
    dirs.add(FIXTURE_LOCK_PATH);
    dirs.add(`${FIXTURE_LOCK_PATH}/gen-seed-generation`);
    files.set(holderPath, raw);
    const label = `${scenario.name}/observation`;
    const beforeFiles = JSON.stringify([...files]);
    const beforeDirs = JSON.stringify([...dirs]);
    const observation = await observeInstanceLock(ctx, now);
    check(`${label}: observed state`, observation.state, scenario.state);
    check(`${label}: takeover policy`, observation.takeover, scenario.takeover);
    if (scenario.record !== undefined && scenario.state !== "unknown") {
      check(`${label}: observed host`, observation.host, scenario.record.host);
      check(`${label}: observed pid`, observation.pid, scenario.record.pid);
    }
    if (scenario.name === "heartbeat") {
      check(`${label}: heartbeat age`, observation.heartbeatAgeMs, 0);
      check(`${label}: acquisition age`, observation.ageMs, 3_600_000);
    }
    if (scenario.state !== "live") {
      check(`${label}: observation manual`, observation.next?.kind, "manual");
      check(`${label}: observation no argv`, observation.next !== undefined && "argv" in observation.next, false);
    } else {
      check(`${label}: observation read command`, observation.next?.kind, "clawforge");
    }
    check(`${label}: observation preserves files`, JSON.stringify([...files]), beforeFiles);
    check(`${label}: observation preserves directories`, JSON.stringify([...dirs]), beforeDirs);
  }
  for (const request of ["none", "break", "confirmed"] as const) {
    const variesAdvice = request === "none" && scenario.takeover === "explicit-break-lock";
    const unsupportedLive = request === "break" && scenario.name === "live";
    for (const supported of variesAdvice || unsupportedLive ? [true, false] : [true]) {
      const { ctx, files, dirs } = stubContext();
      const raw = scenario.record === undefined ? "not JSON" : JSON.stringify(scenario.record);
      dirs.add(FIXTURE_LOCK_PATH);
      dirs.add(`${FIXTURE_LOCK_PATH}/gen-seed-generation`);
      files.set(holderPath, raw);
      const label = `${scenario.name}/${supported ? "supported" : "unsupported"}/${request}`;
      let bodies = 0;
      const succeeds = scenario.allowed && request !== "none" && (scenario.state !== "remote" || request === "confirmed");
      const failure = await captureFailure(() => guardedWith(ctx, "advice consumer", {
        breakLock: request !== "none",
        breakForeignLockHost: request === "confirmed" ? foreign : undefined,
      }, async () => {
        bodies += 1;
        const published = JSON.parse(files.get(holderPath) ?? "null");
        check(`${label}: replacement operation`, published?.what, "advice consumer");
        check(`${label}: replacement pid`, published?.pid, process.pid);
        await checkExpectedHost(label, published?.host);
        check(`${label}: replacement generation`, typeof published?.generation === "string" && published.generation !== "seed-generation", true);
        check(`${label}: replacement marker`, dirs.has(`${FIXTURE_LOCK_PATH}/gen-${published?.generation}`), true);
        check(`${label}: old marker displaced`, dirs.has(`${FIXTURE_LOCK_PATH}/gen-seed-generation`), false);
      }, { breakLockSupported: supported }));
      check(`${label}: body count`, bodies, succeeds ? 1 : 0);
      check(`${label}: captured Error`, failure instanceof Error, !succeeds);
      check(`${label}: captured UserError`, failure instanceof UserError, !succeeds);
      if (!succeeds) {
        const advice = failure instanceof UserError ? failure.advice : [];
        check(`${label}: refusal advice count`, advice.length, 1);
        check(`${label}: refusal manual`, advice[0]?.kind, "manual");
        check(`${label}: refusal no argv`, advice[0] !== undefined && "argv" in advice[0], false);
        check(`${label}: owner bytes preserved`, files.get(holderPath), raw);
        check(`${label}: owner marker preserved`, dirs.has(`${FIXTURE_LOCK_PATH}/gen-seed-generation`), true);
        check(`${label}: owner directory preserved`, dirs.has(FIXTURE_LOCK_PATH), true);
        check(`${label}: no displaced directory`, [...dirs].some((path) => path.startsWith(`${FIXTURE_LOCK_PATH}.stale-`)), false);
      } else {
        check(`${label}: no failure`, failure, undefined);
        check(`${label}: released holder`, files.has(holderPath), false);
        check(`${label}: released directory`, dirs.has(FIXTURE_LOCK_PATH), false);
        check(`${label}: displaced tree removed`, [...dirs].some((path) => path.startsWith(`${FIXTURE_LOCK_PATH}.stale-`)), false);
      }
      check(`${label}: mutation guard cleaned`, dirs.has(guardPath), false);
    }
  }
}

for (const [name, flags] of [
  ["bootstrap", ["--break-lock", "--break-foreign-lock"]],
  ["pull", ["--break-lock", "--break-foreign-lock"]],
  ["backup", ["--break-lock"]],
  ["smoke", ["--break-lock"]],
] as const) {
  for (const flag of flags) {
    let contacts = 0;
    const denied = new Proxy(stubContext().ctx.transport, {
      get() {
        contacts += 1;
        throw new Error("unexpected target contact");
      },
    });
    const stages: string[] = [];
    const argv = [flag, ...(flag === "--break-foreign-lock" ? [foreign] : []), "--totally-unknown-flag"];
    const execution = await executeCommand({ name: "advice-parser", description: "independent parse input", commands: openclawCommands }, name,
      { kind: "argv", argv }, { surface: "terminal", transport: denied, observe: (stage) => stages.push(stage) });
    const label = `${name}/${flag}`;
    const error = execution.error;
    check(`${label}: parse stage`, execution.stage, "parse");
    check(`${label}: only parse observed`, JSON.stringify(stages), JSON.stringify(["parse"]));
    check(`${label}: no run`, execution.reachedRun, false);
    check(`${label}: ArgumentError`, error instanceof ArgumentError, true);
    check(`${label}: controlling argument`, error instanceof ArgumentError ? error.argument : undefined,
      name === "backup" ? "break-lock" : name === "smoke" ? "--break-lock" : "--totally-unknown-flag");
    check(`${label}: no target contact`, contacts, 0);
  }
}

for (const consumer of ["backup create", "smoke standalone", "smoke archives"]) {
  const { ctx: fixtureCtx, files, dirs } = stubContext();
  const raw = JSON.stringify({ ...base, host: local, pid: 99999999 });
  dirs.add(FIXTURE_LOCK_PATH);
  dirs.add(`${FIXTURE_LOCK_PATH}/gen-seed-generation`);
  files.set(holderPath, raw);
  let runtimeCalls = 0;
  const ctx: Context = { ...fixtureCtx, runtime: new Proxy(fixtureCtx.runtime, {
    get(_target, property) {
      return async () => {
        runtimeCalls += 1;
        if (consumer === "backup create" && property === "isRunning" && runtimeCalls === 1) return true;
        throw new Error("lock body reached runtime");
      };
    },
  }) };
  const failure = await captureFailure(() => consumer === "backup create" ? createBackup(ctx)
    : consumer === "smoke standalone" ? ROUND_TRIP_ENTRY.run(ctx)
    : runArchiveChecks(ctx, new Set(["snapshot round-trip is byte-identical"])));
  check(`${consumer}: lock refusal UserError`, failure instanceof UserError, true);
  check(`${consumer}: no lock body runtime`, runtimeCalls, consumer === "backup create" ? 1 : 0);
  const advice = failure instanceof UserError ? failure.advice : [];
  check(`${consumer}: manual advice`, advice.length === 1 && advice[0]?.kind === "manual", true);
  check(`${consumer}: no mutation argv`, advice[0] !== undefined && "argv" in advice[0], false);
  check(`${consumer}: owner preserved`, files.get(holderPath), raw);
  check(`${consumer}: marker preserved`, dirs.has(`${FIXTURE_LOCK_PATH}/gen-seed-generation`), true);
  check(`${consumer}: directory preserved`, dirs.has(FIXTURE_LOCK_PATH), true);
}

for (const confirmation of [undefined, "wrong-host", foreign]) {
  const { ctx, files, dirs } = stubContext();
  const raw = JSON.stringify({ generation: "foreign-guard-generation", pid: 12345, machine: foreign, takenAt: fresh });
  dirs.add(guardPath);
  files.set(`${guardPath}/owner.json`, raw);
  let bodies = 0;
  const label = `foreign guard/${confirmation ?? "unconfirmed"}`;
  const failure = await captureFailure(() => guardedWith(ctx, "up", { breakLock: false, breakForeignLockHost: confirmation }, async () => {
    bodies += 1;
    const holder = JSON.parse(files.get(holderPath) ?? "null");
    check(`${label}: body holds operation`, holder?.what, "up");
    check(`${label}: body holds local pid`, holder?.pid, process.pid);
    await checkExpectedHost(label, holder?.host);
    check(`${label}: body holds fresh generation`, typeof holder?.generation === "string" && holder.generation !== "foreign-guard-generation", true);
    check(`${label}: body holds generation marker`, dirs.has(`${FIXTURE_LOCK_PATH}/gen-${holder?.generation}`), true);
  }));
  const confirmed = confirmation === foreign;
  check(`${label}: body count`, bodies, confirmed ? 1 : 0);
  check(`${label}: captured Error`, failure instanceof Error, !confirmed);
  if (confirmed) {
    check(`${label}: no refusal`, failure, undefined);
    check(`${label}: guard removed`, dirs.has(guardPath), false);
    check(`${label}: guard owner removed`, files.has(`${guardPath}/owner.json`), false);
    check(`${label}: holder removed`, files.has(holderPath), false);
    check(`${label}: lock removed`, dirs.has(FIXTURE_LOCK_PATH), false);
    check(`${label}: no guard remnants`, [...files.keys(), ...dirs].some((path) => path.startsWith(`${guardPath}/`)), false);
    const audit = JSON.parse((files.get(`${FIXTURE_LOCK_HOME}/foreign-lock-takeovers.jsonl`) ?? "null").trim());
    check(`${label}: audit confirmation`, audit?.confirmedHost, foreign);
    check(`${label}: audit displaced generation`, audit?.foreignOwner?.generation, "foreign-guard-generation");
  } else {
    check(`${label}: ordinary Error not UserError`, failure instanceof UserError, false);
    check(`${label}: foreign owner bytes preserved`, files.get(`${guardPath}/owner.json`), raw);
    check(`${label}: foreign directory preserved`, dirs.has(guardPath), true);
    check(`${label}: no operation acquired`, dirs.has(FIXTURE_LOCK_PATH), false);
  }
}

finish("instance lock advice");
