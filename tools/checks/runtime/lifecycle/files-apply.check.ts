import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { check, finish } from "#checks/kit/harness.ts";
import type { Context } from "#framework/core/context.ts";
import { applyFiles, planFiles } from "#framework/runtime/files-deployment.ts";
import { useDeployment, clearDeployment } from "#framework/runtime/deployment.ts";
import { LocalTransport } from "#framework/runtime/transport/transport.ts";

const deployment = await mkdtemp(resolve(tmpdir(), "files-apply-check-"));
const dataDir = resolve(deployment, "target-data");
const transport = new LocalTransport();
const ctx = { settings: { dataDir }, transport } as unknown as Context;
try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await mkdir(resolve(deployment, "source"), { recursive: true });
  await writeFile(resolve(deployment, "source", "declared.txt"), "managed");
  await writeFile(resolve(deployment, "config", "files.json"), JSON.stringify([{ source: "source", target: "workspace/agent-demo", mode: "overlay" }]));
  useDeployment(deployment);
  await mkdir(dataDir, { recursive: true });
  await mkdir(resolve(deployment, "recipes", "example", "data"), { recursive: true });
  await writeFile(resolve(deployment, "recipes", "example", "recipe.json"), JSON.stringify({ privateFiles: ["data/customer.json"] }));
  await writeFile(resolve(deployment, "recipes", "example", "data", "customer.json"), "private customer data");
  await writeFile(resolve(deployment, "recipes", "example", "data", "public.txt"), "public data");
  await writeFile(resolve(deployment, "recipes", "example", "Public.md"), "uppercase public");
  await writeFile(resolve(deployment, "config", "files.json"), JSON.stringify([{ source: "recipes/example/data", target: "workspace/policy-check", mode: "mirror" }]));
  const policyPlan = await planFiles(ctx);
  check("nested recipe declaration holds private file back", policyPlan.entries[0].files, ["public.txt"]);
  check("nested recipe declaration reports held-back file", policyPlan.warnings.some((warning) => warning.includes("recipes/example/data/customer.json")), true);
  await writeFile(resolve(deployment, "config", "files.json"), JSON.stringify([{ source: "recipes/example", target: "workspace/policy-check", mode: "mirror" }]));
  const casePathPlan = await planFiles(ctx);
  check("portable source path preserves original case", casePathPlan.entries[0].files.includes("Public.md"), true);
  await writeFile(resolve(deployment, "config", "files.json"), JSON.stringify([{ source: "source", target: "workspace/agent-demo", mode: "overlay" }]));
  const target = `${dataDir}/workspace/agent-demo`;
  await transport.mkdirp(target);
  await transport.writeFile(`${target}/memory.md`, "foreign");
  await transport.writeFile(`${target}/stale.md`, "owned stale");
  await transport.writeFile(`${dataDir}/clawwright-files.json`, JSON.stringify({ version: 1, targets: { "workspace/agent-demo": ["stale.md"] } }));
  const preview = await planFiles(ctx);
  check("overlay plan prunes only owned stale files", preview.entries[0].removals, ["stale.md"]);
  await applyFiles(ctx, preview);
  const ledger = JSON.parse(await transport.readFile(`${dataDir}/clawwright-files.json`)) as { targets: Record<string, string[]> };
  check("ledger owns exactly desired source files", ledger.targets["workspace/agent-demo"], ["declared.txt"]);
  check("retained foreign target memory", await transport.exists(`${target}/memory.md`), true);
  check("owned stale file was removed", await transport.exists(`${target}/stale.md`), false);

  await writeFile(resolve(deployment, "source", "declared.txt"), "new content must not land");
  await transport.writeFile(`${dataDir}/clawwright-files.json`, "not json");
  const previousContent = await transport.readFile(`${target}/declared.txt`);
  let strictRefusal = false;
  try { await applyFiles(ctx); } catch { strictRefusal = true; }
  check("invalid ledger refuses apply", strictRefusal, true);
  check("invalid ledger refusal leaves target content unchanged", await transport.readFile(`${target}/declared.txt`), previousContent);

  await writeFile(resolve(deployment, "config", "files.json"), JSON.stringify([{ source: "source", target: "__proto__", mode: "mirror" }]));
  await rm(resolve(dataDir, "clawwright-files.json"), { force: true });
  await applyFiles(ctx);
  const prototypeTargetLedger = JSON.parse(await transport.readFile(`${dataDir}/clawwright-files.json`)) as { targets: Record<string, string[]> };
  check("missing ledger safely applies prototype-like target", Object.hasOwn(prototypeTargetLedger.targets, "__proto__"), true);
  check("prototype-like target records exact source files", prototypeTargetLedger.targets["__proto__"], ["declared.txt"]);

  await transport.writeFile(`${dataDir}/clawwright-files.json`, JSON.stringify({ version: 1, targets: { "workspace/agent-demo": ["declared.txt"] } }));
  await writeFile(resolve(deployment, "config", "files.json"), "[]");
  await applyFiles(ctx);
  check("retiring target removes recorded file", await transport.exists(`${target}/declared.txt`), false);
  check("retiring target leaves foreign file", await transport.exists(`${target}/memory.md`), true);
  check("retirement leaves nonempty directories", await transport.exists(target), true);
  check("retired ownership record is removed", JSON.parse(await transport.readFile(`${dataDir}/clawwright-files.json`)).targets, {});

  const firstSource = resolve(deployment, "failure-first"), secondSource = resolve(deployment, "failure-second");
  await mkdir(firstSource, { recursive: true });
  await mkdir(secondSource, { recursive: true });
  await writeFile(resolve(firstSource, "first.txt"), "first target applied");
  await writeFile(resolve(secondSource, "second.txt"), "second target applied");
  await writeFile(resolve(deployment, "config", "files.json"), JSON.stringify([
    { source: "failure-first", target: "workspace/first", mode: "overlay" },
    { source: "failure-second", target: "workspace/second", mode: "overlay" },
  ]));
  await transport.writeFile(`${dataDir}/clawwright-files.json`, JSON.stringify({ version: 1, targets: {
    "workspace/second": ["prior.txt"],
    "workspace/retired": ["keep.txt"],
  } }));
  const failingPlan = await planFiles(ctx);
  const failingTransport = new Proxy(transport, {
    get(targetTransport, property) {
      if (property === "writeFile") return async (path: string, bytes: Uint8Array) => {
        if (path === `${dataDir}/workspace/second/second.txt`) throw new Error("injected second target write failure");
        return targetTransport.writeFile(path, bytes);
      };
      const value: unknown = Reflect.get(targetTransport, property, targetTransport);
      return typeof value === "function" ? value.bind(targetTransport) : value;
    },
  }) as LocalTransport;
  const failingContext = { settings: { dataDir }, transport: failingTransport } as unknown as Context;
  let injectedFailure: unknown;
  try { await applyFiles(failingContext, failingPlan); } catch (error) { injectedFailure = error; }
  check("second target failure is the injected error", (injectedFailure as Error | undefined)?.message, "injected second target write failure");
  check("first target file survives later failure", await transport.readFile(`${dataDir}/workspace/first/first.txt`), "first target applied");
  const partialLedger = JSON.parse(await transport.readFile(`${dataDir}/clawwright-files.json`)) as { targets: Record<string, string[]> };
  check("published ledger records completed first target", partialLedger.targets["workspace/first"], ["first.txt"]);
  check("ledger retains unprocessed prior second target", partialLedger.targets["workspace/second"], ["prior.txt"]);
  check("ledger retains unprocessed retired ownership", partialLedger.targets["workspace/retired"], ["keep.txt"]);
} finally {
  clearDeployment();
  await rm(deployment, { recursive: true, force: true });
}
finish("files-apply");
