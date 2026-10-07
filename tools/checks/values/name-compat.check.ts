// Names that predate the Windows device-name rule stay readable: a deployment directory, an
// installed-set record, a set artifact and an agent config named `aux` are reached by their
// readers (safeName); attempting to create reserved `con` names is refused per creator type.

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createName, readName } from "#framework/core/values/names.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanApps } from "#framework/integration/deployment/names.ts";
import { removeApp } from "#framework/integration/deployment/remove.ts";
import { handoverArgv } from "#framework/entry/resolve.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { NotBootstrapped } from "#framework/runtime/runtime.ts";
import { readInstalledSet, readInstalledSetStrict, unpackArtifactVerified, installedSetFile } from "#framework/set/artifacts/install.ts";
import { setManifestId } from "#framework/set/artifacts/model.ts";
import { checksumOf } from "#framework/service/checksums.ts";
import { packArtifact } from "#checks/sets/pack.ts";
import { parseAgentConfig } from "#framework/commands/management/provision-agent/declaration.ts";
import { reservedNameMessage } from "#framework/core/values/names.ts";
import { createApp } from "#framework/integration/deployment/scaffold.ts";
import type { Context } from "#framework/core/context.ts";
import { check, checkTrue, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import * as kinds from "#framework/core/values/kinds.ts";
import { ValueError } from "#framework/core/values/value.ts";

const DEVICE = "aux";
const root = await mkdtemp(join(tmpdir(), "clawforge-name-compat-"));
const apps = await isolatedAppsRoot("name-compat");
try {
  // A deployment directory named like a device: listed, selectable, removable.
  const appsRoot = join(root, "apps");
  await mkdir(join(appsRoot, DEVICE), { recursive: true });
  await writeFile(join(appsRoot, DEVICE, "app.ts"),
    'export default { name: "fixture", description: "fixture", service: { name: "gateway" }, commands: { noop: { summary: "noop", run: async () => {} } } };\n');
  await writeFile(join(appsRoot, DEVICE, ".env"), "OC_DATA_DIR=/srv/aux/data\nOC_TARGET_LOCATION=local\nOPENCLAW_GATEWAY_PORT=18111\n");
  check("a deployment directory named aux is listed", (await scanApps(appsRoot)).names, [DEVICE]);
  check("--app aux is accepted by the handover", handoverArgv(DEVICE, ["--app", DEVICE]), { argv: ["--app", DEVICE] });
  const buildContext = async (): Promise<Context> => ({ runtime: { isRunning: async () => { throw new NotBootstrapped("/srv/aux"); } }, transport: { description: "local" } }) as unknown as Context;
  const code = await withOutputSink(() => {}, () => removeApp(readName("deployment", DEVICE), true, { appsRoot, buildContext }));
  check("remove-app aux succeeds", code, 0);
  check("and the directory is gone", await access(join(appsRoot, DEVICE)).then(() => true, () => false), false);

  // An installed-set record named aux reads (tolerant and strict readers alike).
  const id = "a".repeat(64);
  const files = new Map<string, string>();
  const ctx = {
    settings: { dataDir: "/srv/data" },
    transport: {
      exists: async (path: string) => files.has(path),
      readFile: async (path: string) => { const text = files.get(path); if (text === undefined) throw new Error("ENOENT"); return text; },
    },
  } as unknown as Context;
  files.set(installedSetFile(ctx), JSON.stringify({ id, name: DEVICE, installedAt: "2026-01-01T00:00:00.000Z", requires: { framework: "0.1.0", image: "i" }, previous: { id, name: DEVICE, installedAt: "2026-01-01T00:00:00.000Z" } }));
  check("the tolerant reader reads an installed record named aux", (await readInstalledSet(ctx))?.name, DEVICE);
  check("the strict reader reads it too", (await readInstalledSetStrict(ctx))?.name, DEVICE);

  // An artifact built under the name aux verifies.
  const source = join(root, "source");
  await mkdir(join(source, "config"), { recursive: true });
  await writeFile(join(source, "config", "desired-state.json"), "[]");
  const manifest = {
    version: 1, name: DEVICE, requires: { framework: "0.1.0", image: `image@sha256:${"a".repeat(64)}` },
    files: { "config/desired-state.json": checksumOf("[]") }, recipes: {}, secrets: [], acceptance: {},
  };
  await writeFile(join(source, "set.json"), `${JSON.stringify(manifest)}\n`);
  const artifact = join(root, "aux.tar.gz");
  await packArtifact(source, manifest, artifact);
  const unpacked = await unpackArtifactVerified(artifact);
  check("an artifact named aux verifies", unpacked.verified.id, setManifestId(manifest));
  await rm(unpacked.staging, { recursive: true, force: true });

  // An agent config naming aux reads; provisioning (minting) refuses it with the device-name reason.
  const config = { agentId: DEVICE, mcpServerName: "wiki", cronJobName: "nightly" };
  check("an agent config named aux reads", parseAgentConfig(config).agentId, DEVICE);
  const agentMintRefusal = (() => { try { parseAgentConfig({ ...config, agentId: "con" }, true); return undefined; } catch (error) { return (error as Error).message; } })();
  check("provision-agent creator path uses its specific reserved-name reason", agentMintRefusal, reservedNameMessage("agent", "con"));
// Literal, not derived from names.ts: the check must fail if the product list shrinks.
const RESERVED = ["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];
const KINDS = ["deployment", "recipe", "set", "store", "agent", "owned-object"] as const;
for (const kind of KINDS) {
  for (const name of RESERVED) {
    let minted: string | undefined;
    try {
      createName(kind, name);
    } catch (error) {
      minted = (error as Error).message;
    }
    checkTrue(`${kind}: creating "${name}" is refused with the reserved-name text`, minted === reservedNameMessage(kind, name));
    checkTrue(`${kind}: reading "${name}" stays legal`, readName(kind, name) === name);
  }
}

// The console/MCP argument surface: the create-mode parser refuses at parse, the read-mode
// parser accepts.
let parserClause: string | undefined;
try {
  kinds.name("deployment", "create").parse("con");
} catch (error) {
  parserClause = (error as ValueError).clause;
}
// Hoisted so the comparison line holds no backtick literal (ratchet hygiene).
const expectedClause = `: ${reservedNameMessage("deployment", "con")}`;
checkTrue('the deployment create parser refuses "con" with the reserved-name clause', parserClause === expectedClause);
checkTrue('the deployment read parser accepts "aux"', kinds.name("deployment", "read").parse("aux") === "aux");
for (const kind of KINDS) {
  for (const name of RESERVED) {
    let refused: string | undefined;
    try {
      kinds.name(kind, "create").parse(name);
    } catch (error) {
      refused = (error as Error).message;
    }
    const expected = `: ${reservedNameMessage(kind, name)}`;
    checkTrue(`${kind}: the create parser refuses "${name}" with the reserved-name clause`, refused === expected);
  }
}

// Minting through the real writer, table-driven across the whole reserved list.
for (const name of RESERVED) {
  const refusal = await createApp(readName("deployment", name)).then(() => undefined, (error: unknown) => (error as Error).message);
  checkTrue(`new-app refuses the reserved deployment name "${name}" with the reserved-name reason`, refusal === reservedNameMessage("deployment", name));
}
} finally {
  await apps.dispose();
  await rm(resolve(root), { recursive: true, force: true });
}

finish("name compatibility");
