// Native shell environment isolation on a disposable executable.
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIO, readCompose } from "#framework/runtime/docker/side-stack/io.ts";
import { toSettings } from "#framework/core/env.ts";
import type { PathBridge } from "#framework/core/paths.ts";
import type { ExecOptions, Transport } from "#framework/runtime/transport/transport.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";

const paths = { toTarget: async () => "/verified/recipes/db/compose.yml" } as unknown as PathBridge;
const connectionKeys = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "SSH_AUTH_SOCK"];
// These are inert fixture values; none is installed in the real process environment.
const settings = toSettings(Object.fromEntries([
  ["OC_DATA_DIR", "/fixture/data"],
  ["RECIPE_INTERPOLATION", "fixture-interpolation"],
  ...connectionKeys.map((key) => [key, `fixture-${key}`]),
]));
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
          const result = spawnSync(command, args, { cwd: root, env: environment, input: options?.input, encoding: "utf8", timeout: options?.timeoutMs, maxBuffer: 16_384 });
          executed.push({ code: result.status, signal: result.signal });
          return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
        },
      } as unknown as Transport;
      const targetIO = createIO(targetTransport, paths, () => settings, "current", "tool-definition.yml", []);
      const result = await targetIO.run(["ps", "--all", "--quiet"]);
      check("inert Docker executable exits normally", executed, [{ code: 0, signal: null }]);
      check("actual target process retains connection and argv but not interpolation", result.stdout.split("\0"),
        [targetPath, targetHome, "absent", "absent", ...targetConnections, "ps", "--all", "--quiet", ""]);
      const selected = await readCompose(targetIO, ["config", "--format", "json"]);
      check("selected declarations override ambient interpolation without changing Docker connection", selected.stdout.split("\0"),
        [targetPath, targetHome, "fixture-interpolation", "absent", ...targetConnections,
          "compose", "--env-file", "/dev/null", "--project-name", "current", "--file", "/verified/recipes/db/compose.yml",
          "--project-directory", "/verified/recipes/db", "config", "--format", "json", ""]);
      const credential = "'single' \"double\" $(printf unsafe) \\backslash";
      const quotedSettings = toSettings({ ...settings.env, RECIPE_INTERPOLATION: credential });
      const quotedIO = createIO(targetTransport, paths, () => quotedSettings, "current", "tool-definition.yml", []);
      const quoted = await readCompose(quotedIO, ["config", "--format", "json"]);
      check("native shell preserves credential syntax without executing substitution", quoted.stdout.split("\0")[2], credential);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
finish("recipe native connection and interpolation isolation");
