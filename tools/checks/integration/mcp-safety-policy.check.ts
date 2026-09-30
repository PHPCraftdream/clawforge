// Pins which MCP actions need confirmation, what that confirmation translates to, and
// whether an action changed state. The real-server fixture uses a local transport only.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { setsCommands } from "#framework/commands/interface/groups/openclawCommands.sets.ts";
import { inputSchema, toArgv, toolEnvelope } from "#framework/integration/mcp/schema.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";

useLinuxHost();

function runServer(script: string, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runProcess(process.execPath, ["--experimental-strip-types", "-e", script], { input: `${input}\n` });
}

// MCP confirmation does not silently change a command's own force flags.
{
  const flags = (name: string): string[] => (openclawCommands[name]?.arguments ?? [])
    .filter((argument) => argument.kind === "flag")
    .map((argument) => argument.name);
  for (const name of ["apply", "rollback", "provision-agent"]) {
    check(`${name} keeps lock takeover separate from force`, [flags(name).includes("force"), flags(name).includes("break-lock")], [false, true]);
  }
  check("confirmed apply does not take over a lock", toArgv(openclawCommands.apply!, { confirm: true }).includes("--break-lock"), false);

  const secrets = openclawCommands.secrets!;
  check("secrets confirmation is conditional", ((inputSchema(secrets).required as string[]) ?? []).includes("confirm"), false);
  for (const [name, args, expected] of [
    ["status", [], false], ["print-template", ["--print-template"], false], ["template", ["--template"], false],
    ["apply", ["--apply"], true], ["init-store", ["--init-store"], true], ["dump", ["--dump"], true],
  ] as const) check(`secrets ${name} confirmation policy`, secrets.requiresConfirmationWhen?.([...args]), expected);

  for (const name of ["restore", "push"]) {
    const command = openclawCommands[name]!;
    check(`${name} adds force after confirmation`, toArgv(command, { confirm: true }).includes("--force"), true);
    check(`${name} leaves force absent without confirmation`, toArgv(command, {}).includes("--force"), false);
  }

  const destroyCmd = openclawCommands.destroy!;
  check("destroy is destructive", destroyCmd.destructive, true);
  check("its dry run (no --yes) is read-only", destroyCmd.readOnlyWhen?.([]), true);
  check("a real run (--yes) is not read-only", destroyCmd.readOnlyWhen?.(["--yes"]), false);
  check("confirm stays conditional in the schema (readOnlyWhen decides, not a bare required)", (inputSchema(destroyCmd).required as string[]).includes("confirm"), false);
  check("destroy keeps --yes and --confirm-name apart from --force", [destroyCmd.arguments?.some((a) => a.name === "force"), destroyCmd.arguments?.some((a) => a.name === "yes"), destroyCmd.arguments?.some((a) => a.name === "confirm-name")], [false, true, true]);

  const set = setsCommands.set!;
  check("set build is mutable but needs no confirmation", [set.readOnlyWhen?.(["build"]), set.requiresConfirmationWhen?.(["build"])], [false, false]);
  check("set build reports its artifact write", toolEnvelope(set, "built", undefined, "set-build", ["build"]).changed, true);
  check("set validate remains read-only", set.readOnlyWhen?.(["validate"]), true);
  check("set try and forget require confirmation", [set.requiresConfirmationWhen?.(["try"]), set.requiresConfirmationWhen?.(["forget"])], [true, true]);
}

// Exercise the actual dispatcher, with stubbed command bodies and local-only context.
{
  const root = await mkdtemp(join(tmpdir(), "clawforge-mcp-policy-"));
  await writeFile(join(root, ".env"), `OC_DATA_DIR=${join(root, "data")}\nOC_TARGET_LOCATION=local\n`, "utf8");
  const url = (name: string): string => new URL(`../../framework/${name}.ts`, import.meta.url).href;
  const script = `
    const { serveMcp } = await import(${JSON.stringify(url("integration/mcp/server"))});
    const { useDeployment } = await import(${JSON.stringify(url("runtime/deployment"))});
    const { managementCommands } = await import(${JSON.stringify(url("commands/interface/groups/openclawCommands.management"))});
    const { lifecycleCommands } = await import(${JSON.stringify(url("commands/interface/groups/openclawCommands.lifecycle"))});
    const { setsCommands } = await import(${JSON.stringify(url("commands/interface/groups/openclawCommands.sets"))});
    const { log } = await import(${JSON.stringify(url("core/io/log"))});
    await useDeployment(${JSON.stringify(root)});
    const spy = async (_ctx, args) => { log(args.join(" ") || "status"); };
    await serveMcp({ name: "policy", commands: {
      secrets: { ...managementCommands.secrets, run: spy },
      restore: { ...lifecycleCommands.restore, run: spy },
      push: { ...lifecycleCommands.push, run: spy },
      destroy: { ...lifecycleCommands.destroy, run: spy },
      set: { ...setsCommands.set, run: spy },
    }});
  `;
  const requests = [
    { id: 1, name: "secrets", arguments: {} },
    { id: 2, name: "secrets", arguments: { "init-store": true, confirm: true } },
    { id: 3, name: "secrets", arguments: { apply: true } },
    { id: 4, name: "secrets", arguments: { apply: true, confirm: true } },
    { id: 5, name: "restore", arguments: { confirm: true } },
    { id: 6, name: "push", arguments: { confirm: true } },
    { id: 7, name: "set", arguments: { action: "build" } },
    { id: 8, name: "destroy", arguments: {} },
    { id: 9, name: "destroy", arguments: { yes: true } },
    { id: 10, name: "destroy", arguments: { yes: true, "confirm-name": "policy", confirm: true } },
  ].map(({ id, name, arguments: args }) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
  try {
    const run = await runServer(script, requests.map((request) => JSON.stringify(request)).join("\n"));
    check("local MCP fixture exits successfully", run.code, 0);
    const replies = new Map(run.stdout.split("\n").filter(Boolean).map((line) => {
      const response = JSON.parse(line) as { id: number; result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { changed?: boolean } } };
      return [response.id, response.result] as const;
    }));
    check("secrets status needs no confirmation", replies.get(1)?.isError, undefined);
    check("confirmed init-store reaches the command without force", replies.get(2)?.content?.[0]?.text?.includes("--init-store") && !replies.get(2)?.content?.[0]?.text?.includes("--force"), true);
    check("unconfirmed apply is rejected", replies.get(3)?.isError, true);
    check("confirmed apply reaches the command", replies.get(4)?.content?.[0]?.text?.includes("--apply"), true);
    check("confirmed restore reaches the command with force", replies.get(5)?.content?.[0]?.text?.includes("--force"), true);
    check("confirmed push reaches the command with force", replies.get(6)?.content?.[0]?.text?.includes("--force"), true);
    check("set build runs without confirmation and reports changed", [replies.get(7)?.isError, replies.get(7)?.structuredContent?.changed], [undefined, true]);
    check("destroy's dry run needs no confirmation", replies.get(8)?.isError, undefined);
    check("destroy --yes with no confirm is rejected", replies.get(9)?.isError, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

finish("MCP safety policy");
