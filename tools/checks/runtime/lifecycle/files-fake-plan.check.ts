import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { check, finish } from "#checks/kit/harness.ts";
import type { Context } from "#framework/core/context.ts";
import { applyFiles, planFiles } from "#framework/runtime/files-deployment.ts";
import { clearDeployment, useDeployment } from "#framework/runtime/deployment.ts";
import { LocalTransport, type Transport } from "#framework/runtime/transport/transport.ts";

const deployment = await mkdtemp(resolve(tmpdir(), "files-fake-plan-check-"));
const dataDir = resolve(deployment, "data");
const local = new LocalTransport();
const contents = new Map<string, Uint8Array>();
const directoryListing = new Map<string, string[]>([[`${dataDir}/workspace/agent-demo`, ["owned-old.md", "memory.md", "stale.md"]]]);
const removals: string[] = [];
let ledger = JSON.stringify({ version: 1, targets: { "workspace/agent-demo": ["owned-old.md", "stale.md"] } });
const targetDirectory = `${dataDir}/workspace/agent-demo`;
const transport = new Proxy(local, {
  get(target, property) {
    if (property === "listFiles") return async (directory: string) => [...(directoryListing.get(directory) ?? [])];
    if (property === "readFile") return async (path: string) => path.endsWith("clawwright-files.json") ? ledger : contents.has(path) ? Buffer.from(contents.get(path)!).toString("utf8") : target.readFile(path);
    if (property === "existsEntry" || property === "exists") return async (path: string) => path.endsWith("clawwright-files.json") || contents.has(path) || target.exists(path);
    if (property === "writeFile") return async (path: string, bytes: Uint8Array) => {
      if (path.endsWith("clawwright-files.json")) {
        ledger = Buffer.from(bytes).toString("utf8");
        return;
      }
      contents.set(path, Buffer.from(bytes));
      const directory = path.slice(0, path.lastIndexOf("/"));
      const rel = path.slice(directory.length + 1);
      const entries = directoryListing.get(directory) ?? [];
      if (!entries.includes(rel)) entries.push(rel);
      directoryListing.set(directory, entries);
    };
    if (property === "remove") return async (path: string) => {
      removals.push(path);
      contents.delete(path);
      const directory = path.slice(0, path.lastIndexOf("/"));
      directoryListing.set(directory, (directoryListing.get(directory) ?? []).filter((entry) => `${directory}/${entry}` !== path));
    };
    if (property === "mkdirp") return async () => undefined;
    if (property === "removeEmptyTree") return async () => false;
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as Transport;
const ctx = { settings: { dataDir }, transport } as unknown as Context;
try {
  await mkdir(resolve(deployment, "config"), { recursive: true });
  await mkdir(resolve(deployment, "source"), { recursive: true });
  await mkdir(targetDirectory, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  contents.set(`${targetDirectory}/owned-old.md`, Buffer.from("old owned"));
  contents.set(`${targetDirectory}/memory.md`, Buffer.from("foreign memory"));
  contents.set(`${targetDirectory}/stale.md`, Buffer.from("stale owned"));
  await writeFile(resolve(deployment, "source", "owned-new.md"), "new");
  useDeployment(deployment);
  const declaration = resolve(deployment, "config", "files.json");
  await writeFile(declaration, JSON.stringify([{ source: "source", target: "workspace/agent-demo", mode: "mirror" }]));
  const mirror = await planFiles(ctx);
  check("fake-transport mirror plans all undeclared listings for removal", mirror.entries[0].removals, ["owned-old.md", "memory.md", "stale.md"]);
  await writeFile(declaration, JSON.stringify([{ source: "source", target: "workspace/agent-demo", mode: "overlay" }]));
  const overlay = await planFiles(ctx);
  check("fake-transport overlay plans only previously owned files for removal", overlay.entries[0].removals, ["owned-old.md", "stale.md"]);
  await applyFiles(ctx, overlay);
  check("fake-transport apply preserves foreign memory content", Buffer.from(contents.get(`${targetDirectory}/memory.md`)!).toString("utf8"), "foreign memory");
  check("fake-transport apply never removes foreign memory", removals.includes(`${targetDirectory}/memory.md`), false);
  check("fake-transport apply removes stale owned content", contents.has(`${targetDirectory}/stale.md`), false);
  check("fake-transport apply writes desired content", Buffer.from(contents.get(`${targetDirectory}/owned-new.md`)!).toString("utf8"), "new");
} finally {
  clearDeployment();
  await rm(deployment, { recursive: true, force: true });
}
finish("files-fake-plan");
