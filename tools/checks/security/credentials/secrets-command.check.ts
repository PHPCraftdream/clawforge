// Checks two secrets/MCP behaviors fixed earlier in this project's history but never
// covered by a dedicated regression test:
//
//  - `./clawforge secrets --init-store` on an existing store must refuse without --force, and
//    leave the file byte-for-byte untouched — not just refuse and then overwrite anyway.
//  - `./clawforge mcp-setup` must merge into .mcp.json rather than clobbering other servers, and
//    must recover from a file it cannot parse instead of throwing.
//
// No target for part 1: a real temporary deployment directory drives secretStoreFile()
// end to end, with requirements() short-circuited to [] via a config path that does not
// exist. Part 2 necessarily touches the real .mcp.json at the repo root — mcpConfigFile in
// mcp.ts is hardcoded, not parameterized — so the original content is saved and restored
// in a finally block from the very first read.

import { mkdir, mkdtemp, readFile, writeFile, rm, stat, access } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { secrets } from "../../../framework/commands/management/secrets.ts";
import { mcpSetup, mcpServerEntries, mcpConfigFilePath } from "../../../framework/commands/management/mcp.ts";
import { useDeployment, deploymentDir } from "../../../framework/runtime/deployment.ts";
import { CLAWFORGE_CONTROL_MCP_NAME, CLAWFORGE_MCP_NAME } from "../../../framework/integration/mcp-project.ts";
import { withOutputSink } from "../../../framework/core/output.ts";
import type { Context } from "../../../framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

// ---------------------------------------------------------------------------------------
// Part 1: secrets --init-store
// ---------------------------------------------------------------------------------------

async function runSecretsChecks(): Promise<void> {
  const deployDir = await mkdtemp(resolve(tmpdir(), "clawforge-secrets-check-"));

  try {
    await mkdir(resolve(deployDir, "config"), { recursive: true });
    await mkdir(resolve(deployDir, "secrets"), { recursive: true });
    useDeployment(deployDir);

    // A dataDir that does not exist, paired with a transport that reports its config as
    // absent: requirements(ctx) short-circuits to [] and part 1 never needs a real config.
    const ctx = {
      settings: { dataDir: "/does/not/exist", env: {} },
      transport: {
        description: "stub",
        async exists(path: string): Promise<boolean> {
          return !path.endsWith("openclaw.json");
        },
        async readFile(): Promise<string> {
          return "";
        },
        async writeFile(): Promise<void> {},
        // secrets --apply now takes the instance lock (#186) — a plain mkdir is the atomic
        // claim takeLock() makes; harmless here since nothing else is contending for it.
        async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;

    const storePath = resolve(deployDir, "secrets", "store-a.env");

    // --init-store --store <name> on a fresh store creates the file, mode 0o600, empty
    // template (no values).
    await withOutputSink(
      () => {},
      () => secrets(ctx, ["--init-store", "--store", "store-a"]),
    );

    const firstContent = await readFile(storePath, "utf8");
    check("a fresh store is created", firstContent.length > 0, true);
    check("the fresh template has no values", /=\S/.test(firstContent), false);

    const mode = (await stat(storePath)).mode & 0o777;
    // chmod bits are not meaningful on Windows filesystems (no POSIX permission bits), so
    // this assertion only holds where they are — skip it there rather than assert a lie.
    if (process.platform !== "win32") {
      check("the store file is created with mode 0o600", mode, 0o600);
    }

    // Running --init-store again WITHOUT --force must refuse, and must leave the file
    // untouched — not refuse-then-overwrite.
    const beforeSecondAttempt = await readFile(storePath, "utf8");
    let refusalMessage = "";
    try {
      await withOutputSink(
        () => {},
        () => secrets(ctx, ["--init-store", "--store", "store-a"]),
      );
    } catch (error) {
      refusalMessage = error instanceof Error ? error.message : String(error);
    }
    const afterSecondAttempt = await readFile(storePath, "utf8");

    check("re-running --init-store without --force throws", refusalMessage !== "", true);
    check("the refusal message mentions already exists", refusalMessage.includes("already exists"), true);
    check("the refusal message mentions --force", refusalMessage.includes("--force"), true);
    check("the file content is unchanged after the refused attempt", afterSecondAttempt, beforeSecondAttempt);

    // --force DOES overwrite with a fresh empty template. Prove it by writing a fake value
    // in between and confirming --force wipes it.
    await writeFile(storePath, "SOME_KEY=leftover-value\n", "utf8");
    await withOutputSink(
      () => {},
      () => secrets(ctx, ["--init-store", "--store", "store-a", "--force"]),
    );
    const afterForce = await readFile(storePath, "utf8");
    check("--force overwrites the store", afterForce.includes("leftover-value"), false);
    check("--force produces an empty template again", afterForce, firstContent);

    // --template writes a template file without values.
    await withOutputSink(
      () => {},
      () => secrets(ctx, ["--template"]),
    );
    const templateFile = resolve(deployDir, "config", "secrets.template.env");
    const templateContent = await readFile(templateFile, "utf8");
    check("--template writes a file", templateContent.length > 0, true);
    check("the written template has no values", /=\S/.test(templateContent), false);

    // --print-template emits to the output sink rather than writing a file or touching
    // real stdout.
    let printed = "";
    await withOutputSink(
      (chunk) => {
        printed += chunk;
      },
      () => secrets(ctx, ["--print-template"]),
    );
    check("--print-template emits something", printed.length > 0, true);
    check("the printed template has no values", /=\S/.test(printed), false);

    // --store with a path-traversal name is rejected before any file is touched.
    let traversalMessage = "";
    try {
      await withOutputSink(
        () => {},
        () => secrets(ctx, ["--init-store", "--store", "../../etc/passwd"]),
      );
    } catch (error) {
      traversalMessage = error instanceof Error ? error.message : String(error);
    }
    check("a path-traversal store name is rejected", traversalMessage !== "", true);
    const escapedPath = resolve(deployDir, "..", "..", "etc", "passwd.env");
    const escapedExists = await access(escapedPath).then(
      () => true,
      () => false,
    );
    check("no file is created outside the deployment's secrets directory", escapedExists, false);

    // --apply --store <name> on a store that was never created names the exact fix, not a
    // stale one — it used to point at --template, which writes a values-free listing under
    // config/, not the per-target store under secrets/ that --apply actually reads.
    let applyMessage = "";
    try {
      await withOutputSink(
        () => {},
        () => secrets(ctx, ["--apply", "--store", "missing-store"]),
      );
    } catch (error) {
      applyMessage = error instanceof Error ? error.message : String(error);
    }
    check("applying a missing store is refused", applyMessage !== "", true);
    check("the refusal names the correct fix", applyMessage.includes("--init-store --store missing-store"), true);
    check("the refusal does not point at --template", applyMessage.includes("--template"), false);
  } finally {
    await rm(deployDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// Part 1b: secrets --apply must respect the instance lock, not bypass it
// ---------------------------------------------------------------------------------------
//
// Before the fix, applyStore() wrote config/.env on the target with no takeLock()/guarded()
// call at all — it could run concurrently with apply/restore/rollback and race against them.

async function runLockChecks(): Promise<void> {
  const deployDir = await mkdtemp(resolve(tmpdir(), "clawforge-secrets-lock-check-"));
  try {
    await mkdir(resolve(deployDir, "config"), { recursive: true });
    await mkdir(resolve(deployDir, "secrets"), { recursive: true });
    useDeployment(deployDir);

    const storeName = "store-locked";
    const storePath = resolve(deployDir, "secrets", `${storeName}.env`);
    await writeFile(storePath, "", "utf8");

    function stubCtx(lockAlreadyHeld: boolean): Context {
      const holder = JSON.stringify({
        operationId: "op-holder", what: "apply", by: "someone@host pid 1", takenAt: new Date().toISOString(),
      });
      return {
        settings: { dataDir: "/does/not/exist", env: {} },
        transport: {
          description: "stub",
          async exists(path: string): Promise<boolean> {
            return !path.endsWith("openclaw.json");
          },
          async readFile(path: string): Promise<string> {
            return path.endsWith("holder.json") ? holder : "";
          },
          async writeFile(): Promise<void> {},
          async remove(): Promise<void> {},
          async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
            if (command === "mkdir" && args[0] !== "-p") return { code: lockAlreadyHeld ? 1 : 0, stdout: "", stderr: "" };
            if (command === "test" && args[0] === "-d") return { code: lockAlreadyHeld ? 0 : 1, stdout: "", stderr: "" };
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      } as unknown as Context;
    }

    let refused = "";
    try {
      await withOutputSink(
        () => {},
        () => secrets(stubCtx(true), ["--apply", "--store", storeName]),
      );
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    check("secrets --apply refuses when another operation already holds the instance lock", refused.includes("another operation is changing this instance"), true);

    let unlockedMessage = "";
    try {
      await withOutputSink(
        () => {},
        () => secrets(stubCtx(false), ["--apply", "--store", storeName]),
      );
    } catch (error) {
      unlockedMessage = error instanceof Error ? error.message : String(error);
    }
    // requirements() short-circuits to [] (no config), so applyStore() proceeds through the
    // lock and only fails later, at loadSecrets()'s own "empty content" guard — a DIFFERENT
    // failure than the lock refusal above, which is exactly what proves it got past the lock.
    check(
      "with no competing lock, secrets --apply gets past the lock check (fails later, for an unrelated reason)",
      unlockedMessage.includes("refusing to install an empty secrets file"),
      true,
    );
  } finally {
    await rm(deployDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// Part 2: mcp-setup
// ---------------------------------------------------------------------------------------

// Never touches the real .mcp.json at the checkout root — this very checkout's own MCP
// client may depend on it while these checks run, and a process interrupted mid-test used
// to be able to leave it deleted or half-written. Every case below either calls
// mcpServerEntries()/mcpConfigFilePath() directly (pure, no file I/O) or runs the full
// mcpSetup() against a disposable temp directory (installed mode: a committed ./clawforge shim
// right at deploymentDir(), a consumer repo's own project root, not apps/<name>) — never
// against monorepoRoot.
async function runMcpChecks(): Promise<void> {
  const ctx = {
    settings: { location: "wsl" },
    paths: {
      async toTarget(path: string): Promise<string> {
        return path;
      },
    },
    transport: {
      clientInvocation(entry: string, args: string[]): { command: string; args: string[] } {
        return { command: "echo", args: ["hi", entry, ...args] };
      },
    },
  } as unknown as Context;

  // --- command shape and config-file choice: pure, no I/O — safe to check for every mode,
  // monorepo included, without ever writing anywhere -----------------------------------

  {
    const name = CLAWFORGE_MCP_NAME;
    const entries = await mcpServerEntries(ctx);
    // Not wrapped through the transport (the client shares this filesystem), and not `./clawforge`
    // either: a client spawns the command directly, with no shell, and the shim is a bash
    // script — which is ENOENT on Windows even where `./clawforge` works fine in a terminal.
    check("wsl mode runs the CLI through node, not the shell shim", entries[name].command, "node");
    check(
      "wsl mode names the monorepo entry, the deployment and the command",
      entries[name].args.some((arg) => arg.includes('../../tools/clawforge.ts') && arg.includes('--app')) && entries[name].args.at(-1) === "mcp-serve",
      true,
    );
    check(
      "monorepo mode keeps the client config inside the selected application",
      await mcpConfigFilePath(ctx),
      resolve(deploymentDir(), ".mcp.json"),
    );
  }

  {
    // ssh is the one mode a plain relative command cannot work for — the client runs on a
    // different machine from the target, so it genuinely needs the transport's own
    // wrapping (whatever ctx.transport.clientInvocation() produces), not ./clawforge directly.
    const sshCtx = { ...ctx, settings: { location: "ssh" } } as unknown as Context;
    const name = CLAWFORGE_MCP_NAME;
    const entries = await mcpServerEntries(sshCtx);
    check("SSH targets still launch the local tooling, which owns the transport", entries[name].command, "node");
    check(
      "ssh mode's wrapping still carries --app and mcp-serve",
      entries[name].args.some((arg) => arg.includes('--app')) && entries[name].args.at(-1) === "mcp-serve",
      true,
    );
  }

  // --- mcpSetup's read/merge/write/recover logic: mode-independent (mcpConfigFilePath is
  // the only thing that branches on mode, and it is already covered above with no I/O at
  // all), so it only needs covering once — always against a throwaway temp directory ----

  const installedDir = await mkdtemp(resolve(tmpdir(), "clawforge-mcp-installed-check-"));
  try {
    await writeFile(resolve(installedDir, "clawforge"), "#!/usr/bin/env bash\n", "utf8");
    useDeployment(installedDir);
    const name = CLAWFORGE_MCP_NAME;
    const configFile = resolve(installedDir, ".mcp.json");

    const entries = await mcpServerEntries(ctx);
    check("installed mode runs the CLI through node too", entries[name].command, "node");
    check("installed mode does not pass --app", entries[name].args.includes("--app"), false);
    check("installed mode still names the mcp-serve command", entries[name].args.includes("mcp-serve"), true);
    // The package's own bin, found from where this module was loaded rather than assumed —
    // and written with forward slashes so the same config works on either platform.
    check(
      "installed mode points at the package's Node entry point",
      entries[name].args.some((arg) => arg.includes('@clawforge/framework/app') && arg.includes('bin.js')),
      true,
    );
    check(
      "installed mode's config path sits next to the deployment, not the monorepo root",
      await mcpConfigFilePath(ctx),
      configFile,
    );

    // .mcp.json does not exist yet: mcp-setup creates it with this deployment's two
    // entries — the bridge to OpenClaw's own channels (mcp-serve) and this deployment's
    // own commands as tools (control-mcp).
    await withOutputSink(
      () => {},
      () => mcpSetup(ctx, []),
    );
    const created = JSON.parse(await readFile(configFile, "utf8")) as { mcpServers: Record<string, unknown> };
    check("a missing .mcp.json is created", Object.keys(created.mcpServers).length, 2);
    check("the created file keys the mcp-serve entry", Object.prototype.hasOwnProperty.call(created.mcpServers, name), true);
    check(
      "the created file keys the control-mcp entry",
      Object.prototype.hasOwnProperty.call(created.mcpServers, CLAWFORGE_CONTROL_MCP_NAME),
      true,
    );

    // .mcp.json exists with an entry for a different server: after mcp-setup, both entries
    // are present.
    const otherServer = { "someone-else": { command: "echo", args: ["hi"] } };
    await writeFile(configFile, `${JSON.stringify({ mcpServers: otherServer }, null, 2)}\n`, "utf8");
    await withOutputSink(
      () => {},
      () => mcpSetup(ctx, []),
    );
    const merged = JSON.parse(await readFile(configFile, "utf8")) as { mcpServers: Record<string, unknown> };
    check("the other server is kept", Object.prototype.hasOwnProperty.call(merged.mcpServers, "someone-else"), true);
    check(
      "the other server's config is untouched",
      JSON.stringify(merged.mcpServers["someone-else"]),
      JSON.stringify(otherServer["someone-else"]),
    );
    check("our mcp-serve entry is added", Object.prototype.hasOwnProperty.call(merged.mcpServers, name), true);
    check(
      "our control-mcp entry is added",
      Object.prototype.hasOwnProperty.call(merged.mcpServers, CLAWFORGE_CONTROL_MCP_NAME),
      true,
    );

    // .mcp.json contains invalid JSON: mcp-setup does not throw, and overwrites with a
    // fresh valid file.
    await writeFile(configFile, "{ not valid json", "utf8");
    let threw = false;
    try {
      await withOutputSink(
        () => {},
        () => mcpSetup(ctx, []),
      );
    } catch {
      threw = true;
    }
    check("invalid JSON is refused before replacing client settings", threw, true);
    check("the unparsable configuration is preserved", await readFile(configFile, "utf8"), "{ not valid json");
  } finally {
    await rm(installedDir, { recursive: true, force: true });
  }
}

await runSecretsChecks();
await runLockChecks();
await runMcpChecks();

process.stderr.write(failed === 0 ? "all secrets-command checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
