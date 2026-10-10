import { structuredResult } from "#framework/integration/mcp/call.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { inspect } from "#framework/commands/orchestration/inspect/gather.ts";
import { status } from "#framework/commands/interface/status.ts";
import { NotBootstrapped } from "#framework/runtime/runtime.ts";
import { TransportUnreachableError } from "#framework/runtime/transport/transport.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import type { InstanceLockObservation } from "#framework/runtime/lock/instance-lock.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "../fixture.ts";
import { check, finish } from "#checks/kit/harness.ts";

interface LockConsumerResult {
  readonly observed?: { readonly instanceLock?: InstanceLockObservation };
  readonly instanceLock?: InstanceLockObservation;
}

const fixture = await setupFixtureDeployment();
try {
  for (const mode of ["unreachable", "unreadable", "remote"] as const) {
    for (const consumer of [inspect, status]) {
      for (const stage of consumer === status ? ["early", "image", "probe", "health", "usage", "image-error", "image-not-bootstrapped"] as const : ["early"] as const) {
        const ctx = fixture.stubContext({ targetEnv: "ZAI_API_KEY=k\n", mirrorChecksums: fixture.goodChecksums });
        let observations = 0;
        let mutations = 0;
        const exists = ctx.transport.exists.bind(ctx.transport);
        const readFile = ctx.transport.readFile.bind(ctx.transport);
        ctx.transport.exists = async (path) => {
          if (!path.endsWith("/operation.lock")) return exists(path);
          observations += 1;
          if (mode === "unreachable") throw new TransportUnreachableError("fixture target unavailable", "verify the fixture target");
          return true;
        };
        ctx.transport.readFile = async (path) => {
          if (!path.endsWith("/operation.lock/holder.json")) return readFile(path);
          if (mode === "unreadable") throw new Error("fixture lock unreadable");
          return JSON.stringify({ operationId: "remote-operation", what: "apply", host: "fixture-remote.invalid", pid: 123, takenAt: "2026-01-01T00:00:00Z" });
        };
        const rejectMutation = async (): Promise<never> => { mutations += 1; throw new Error("unexpected target mutation"); };
        ctx.transport.writeFile = rejectMutation;
        ctx.transport.mkdirp = rejectMutation;
        ctx.transport.remove = rejectMutation;
        const exec = ctx.transport.exec.bind(ctx.transport);
        ctx.transport.exec = async (command, args, options) => {
          if (["mkdir", "mv", "rm", "rmdir"].includes(command)) return rejectMutation();
          return exec(command, args, options);
        };
        const targetLost = async (): Promise<never> => { throw new TransportUnreachableError("fixture target unavailable", "verify the fixture target"); };
        const imageError = stage === "image-error" ? new Error("fixture unrelated image failure")
          : stage === "image-not-bootstrapped" ? new NotBootstrapped(ctx.settings.dataDir) : undefined;
        ctx.runtime.isRunning = stage === "early" ? targetLost : async () => true;
        ctx.runtime.runningConnectionFacts = stage === "early" ? targetLost : async () => undefined;
        ctx.runtime.imageReference = async () => {
          if (imageError !== undefined) throw imageError;
          if (stage === "image") return targetLost();
          return "fixture-image";
        };
        const probes: string[] = [];
        ctx.runtime.probe = async (endpoint) => {
          probes.push(endpoint);
          if (stage === "probe" && endpoint === "startupz") return targetLost();
          return 200;
        };
        ctx.runtime.health = stage === "health" ? targetLost : async () => "healthy";
        const guardedExec = ctx.transport.exec.bind(ctx.transport);
        let usageReads = 0;
        ctx.transport.exec = async (command, args, options) => {
          if (command === "du") {
            usageReads += 1;
            if (stage === "usage") return targetLost();
          }
          return guardedExec(command, args, options);
        };
        let output = "";
        let thrown: unknown;
        await withOutputSink((chunk) => { output += chunk; }, async () => {
          try { await consumer(ctx, ["--json"]); } catch (error) {
            if (imageError !== undefined) {
              thrown = error;
              return;
            }
            if (!(error instanceof Error) || !error.message.includes("TARGET_UNREACHABLE")) throw error;
          }
        });
        if (imageError !== undefined) {
          check(`${consumer.name}/${mode}/${stage} propagates exact late image error identity`, thrown === imageError, true);
          check(`${consumer.name}/${mode}/${stage} emits no fabricated transport or bootstrap JSON`, output, "");
          check(`${consumer.name}/${mode}/${stage} observes lock once`, observations, 1);
          check(`${consumer.name}/${mode}/${stage} attempts no target mutation`, mutations, 0);
          check(`${consumer.name}/${mode}/${stage} never reaches probes`, probes, []);
          check(`${consumer.name}/${mode}/${stage} never reaches usage`, usageReads, 0);
          continue;
        }
        const document = JSON.parse(output);
        if (stage !== "early") {
          check(`${mode}/${stage} late target loss retains running fact`, document.running, true);
          check(`${mode}/${stage} late target loss retains bootstrapped fact`, document.bootstrapped, true);
          check(`${mode}/${stage} late target loss retains exposure`, document.exposure !== undefined, true);
          check(`${mode}/${stage} late target loss reports transport problem`, document.problem?.code, "TARGET_UNREACHABLE");
          check(`${mode}/${stage} late target loss never invents usage`, document.dataUsage, undefined);
          check(`${mode}/${stage} late target loss retains only observed image`, document.image, stage === "image" ? undefined : "fixture-image");
          check(`${mode}/${stage} retains only completed health facts`, document.health, stage === "image" ? undefined : stage === "probe" ? { healthz: 200 } : stage === "health" ? { healthz: 200, startupz: 200, readyz: 200 } : { healthz: 200, startupz: 200, readyz: 200, runtime: "healthy" });
          check(`${mode}/${stage} probes are attempted once without retry`, probes, stage === "image" ? [] : stage === "probe" ? ["healthz", "startupz"] : ["healthz", "startupz", "readyz"]);
          check(`${mode}/${stage} usage is attempted only after health`, usageReads, stage === "usage" ? 1 : 0);
        }
        const lock = document.observed?.instanceLock ?? document.instanceLock;
        check(`${consumer.name}/${mode}/${stage} consumer JSON retains independent lock state`, lock?.state, mode === "remote" ? "remote" : "unknown");
        check(`${consumer.name}/${mode}/${stage} consumer JSON carries manual lock advice`, lock?.next?.kind, "manual");
        const lockAdvice = document.next?.find((entry: { kind?: string; text?: string }) => entry.kind === "manual" && entry.text === lock?.next?.text);
        check(`${consumer.name}/${mode}/${stage} top-level lock advice is manual`, lockAdvice?.kind, "manual");
        check(`${consumer.name}/${mode}/${stage} top-level lock advice has no argv`, lockAdvice !== undefined && "argv" in lockAdvice, false);
        if (mode === "remote") {
          const foreignLockArgument = /(?:^|\s)(--break-foreign-lock)\s+(?:"([^"]*)"|'([^']*)'|(\S+))(?=\s|$)/.exec(lockAdvice?.text ?? "");
          check(`${consumer.name}/${mode}/${stage} remote advice requires exact fixture host confirmation`, foreignLockArgument === null ? [] : [foreignLockArgument[1], foreignLockArgument[2] ?? foreignLockArgument[3] ?? foreignLockArgument[4]], ["--break-foreign-lock", "fixture-remote.invalid"]);
          check(`${consumer.name}/${mode}/${stage} remote advice requires explicit break permission`, /--break-lock\b/.test(lockAdvice?.text ?? ""), true);
        } else {
          check(`${consumer.name}/${mode}/${stage} unknown observation permits no takeover`, lock?.takeover, "none");
          check(`${consumer.name}/${mode}/${stage} unknown advice grants no takeover flag`, /--break-(?:foreign-)?lock\b/.test(lockAdvice?.text ?? ""), false);
        }
        const lookup = (name: string) => openclawCommands[name];
        const envelope = structuredResult(consumer === inspect ? openclawCommands.inspect : openclawCommands.status, output, "fixture-observation", ["--json"], undefined, lookup);
        check(`${consumer.name}/${mode}/${stage} MCP retains lock observation`, (envelope?.result as LockConsumerResult)?.observed?.instanceLock?.state ?? (envelope?.result as LockConsumerResult)?.instanceLock?.state, mode === "remote" ? "remote" : "unknown");
        check(`${consumer.name}/${mode}/${stage} MCP reports no mutation`, envelope?.changed, false);
        check(`${consumer.name}/${mode}/${stage} manual transport and lock remedies produce no tool steps`, envelope?.nextSteps, []);
        check(`${consumer.name}/${mode}/${stage} MCP never invents takeover mutation tools`, envelope?.nextSteps.some((step) => ["up", "restart", "lock", "apply"].includes(step.tool) || "break-lock" in step.arguments || "break-foreign-lock" in step.arguments), false);
        check(`${consumer.name}/${mode}/${stage} observes lock once`, observations, 1);
        check(`${consumer.name}/${mode}/${stage} attempts no target mutation`, mutations, 0);
      }
    }
  }
} finally { await teardownFixtureDeployment(fixture.deployment); }
finish("inspect-lock-consumers");
