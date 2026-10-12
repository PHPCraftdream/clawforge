// Authored regression only: strip source text, record the IO boundary; never spawn Docker.
import { readFile, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { createIO, RecipeReadError } from "#framework/runtime/docker/side-stack/io.ts";
import { toSettings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import type { ExecOptions, Transport } from "#framework/runtime/transport/transport.ts";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";

// Strip mode rejects parameter properties, enums, runtime namespaces and import aliases.
// No transformed source is evaluated, and no CLI/static-check subprocess is started.
const sources = [
  "../../../../framework/service/recipe.ts",
  "../../../../framework/runtime/runtime.ts",
  "../../../../framework/runtime/docker/runtime-docker.ts",
  "../../../../framework/runtime/docker/side-stack/index.ts",
  "../../../../framework/runtime/docker/side-stack/io.ts",
  "../../../../framework/runtime/docker/side-stack/inspection.ts",
  "../../../../framework/runtime/docker/side-stack/recovery.ts",
  "../../../../framework/runtime/docker/side-stack/migration-plan.ts",
  "../../../../framework/runtime/docker/side-stack/migration.ts",
  "../../../../framework/runtime/docker/side-stack/storage.ts",
  "../../../../framework/commands/management/recipe/index.ts",
  "../../../../framework/commands/management/recipe/recovery/inspect.ts",
  "../../../../framework/commands/management/recipe/recovery/recover.ts",
  "../../../../framework/commands/management/recipe/recovery/migrate.ts",
  "../../../../framework/commands/management/recipe/recovery/migration-verifier.ts",
  "fixture.ts", "inspect.check.ts", "recover.check.ts", "recover-command.check.ts",
  "migrate.check.ts", "semantic/storage.ts", "io-syntax.check.ts",
  "semantic/private-parent.check.ts", "semantic/app-contract-journal.check.ts",
  "semantic/helper-boundary.check.ts", "semantic/migration-verifier.check.ts",
  "../../../integration/recipe/recipe-identity.check.ts",
  "../../service/restore/restore-ownership.check.ts",
  "../../../management/recipe/inspect.check.ts",
  "../../../management/recipe/recovery-confirmation.check.ts",
  "../../../management/recipe/migration-hook.check.ts",
  "../../../management/recipe/consumer-endpoints.check.ts",
];
for (const source of sources) {
  let error: unknown;
  try { stripTypeScriptTypes(await readFile(new URL(source, import.meta.url), "utf8"), { mode: "strip" }); }
  catch (caught) { error = caught; }
  check(`recipe slice uses erasable syntax: ${source}`, error, undefined);
}
for (const kind of ["transport", "malformed"] as const) {
  const error = new RecipeReadError(kind, "fixture");
  check(`RecipeReadError retains explicit ${kind} field`, error.causeKind, kind);
  checkTrue(`RecipeReadError owns ${kind} field`, Object.hasOwn(error, "causeKind") && error instanceof Error);
}

const calls: { command: string; args: string[]; options?: ExecOptions }[] = [];
const transport = {
  async exec(command: string, args: string[], options?: ExecOptions) {
    calls.push({ command, args: [...args], options });
    return { code: 0, stdout: "", stderr: "" };
  },
} as unknown as Transport;
const paths = { toTarget: async () => "/verified/recipes/db/compose.yml" } as unknown as PathBridge;
const connectionKeys = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "SSH_AUTH_SOCK"];
// These are inert fixture values; none is installed in the real process environment.
const settings = toSettings(Object.fromEntries([
  ["OC_DATA_DIR", "/fixture/data"],
  ["RECIPE_INTERPOLATION", "fixture-interpolation"],
  ...connectionKeys.map((key) => [key, `fixture-${key}`]),
]));
const io = createIO(transport, paths, () => settings, "current", "tool-definition.yml", []);
await io.run(["ps", "--all", "--quiet"]);
const call = calls[0]!;
checkTrue("IO clears configured operator interpolation", call.options?.unsetEnv?.includes("RECIPE_INTERPOLATION") === true);
for (const key of connectionKeys) {
  checkTrue(`IO does not unset actual operator Docker connection ${key}`, !call.options?.unsetEnv?.includes(key));
  checkTrue(`IO does not inject configured fixture Docker connection ${key}`, !call.args.join(" ").includes(`fixture-${key}`));
}
check("IO uses bounded non-streaming failure-aware transport", { allowFailure: call.options?.allowFailure, stream: call.options?.stream }, { allowFailure: true, stream: false });
checkTrue("IO supplies finite positive timeout", Number.isFinite(call.options?.timeoutMs) && call.options!.timeoutMs! > 0);
await requires("posix-host", "recipe IO target executable uses native POSIX filesystem modes", async () => {
  await requires("posix-sh", "recipe IO target environment isolation through an inert Docker executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "recipe-io-environment-"));
    try {
      const executable = join(root, "docker");
      await writeFile(executable, '#!/bin/sh\nprintf "%s\\0" "$PATH" "$HOME" "${RECIPE_INTERPOLATION-absent}" "${TARGET_ONLY_INTERPOLATION-absent}" "$DOCKER_HOST" "$DOCKER_CONTEXT" "$DOCKER_CONFIG" "$DOCKER_TLS_VERIFY" "$DOCKER_CERT_PATH" "$SSH_AUTH_SOCK" "$@"\n');
      await chmod(executable, 0o700);
      const targetPath = `${root}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;
      const targetHome = "/target/home";
      const targetConnections = connectionKeys.map((key) => `target-${key}`);
      const targetEnvironment = { ...process.env, PATH: targetPath, HOME: targetHome,
        RECIPE_INTERPOLATION: "ambient-interpolation", TARGET_ONLY_INTERPOLATION: "target-only-secret",
        ...Object.fromEntries(connectionKeys.map((key, index) => [key, targetConnections[index]!])) };
      const executed: { code: number | null; signal: string | null }[] = [];
      const targetTransport = {
        async exec(command: string, args: string[], options?: ExecOptions) {
          const environment: Record<string, string | undefined> = { ...targetEnvironment };
          for (const key of options?.unsetEnv ?? []) delete environment[key];
          const result = spawnSync(command, args, { env: environment, encoding: "utf8", timeout: options?.timeoutMs, maxBuffer: 16_384 });
          executed.push({ code: result.status, signal: result.signal });
          return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
        },
      } as unknown as Transport;
      const targetIO = createIO(targetTransport, paths, () => settings, "current", "tool-definition.yml", []);
      const result = await targetIO.run(["ps", "--all", "--quiet"]);
      check("inert Docker executable exits normally", executed, [{ code: 0, signal: null }]);
      check("actual target process retains connection and argv but not interpolation", result.stdout.split("\0"),
        [targetPath, targetHome, "absent", "absent", ...targetConnections, "ps", "--all", "--quiet", ""]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
finish("recipe IO erasable syntax and connection isolation");
