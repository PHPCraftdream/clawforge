// The secrets template and local store, in isolation from any target: `--init-store` on
// an existing store must refuse without --force and leave the file byte-for-byte
// untouched — not refuse and then overwrite anyway; --force must overwrite with a fresh
// empty template; `--template`/`--print-template` must produce values-free output; a
// path-traversal store name must be rejected before any file is touched; and `--apply`
// on a store that was never created must name the exact fix — it used to point at
// --template, which writes a values-free listing under config/, not the per-target store
// under secrets/ that --apply actually reads.
//
// The store also follows the deployment .env's safe-creation contract: owner-only from
// the first byte, on Windows a closed DACL (the POSIX mode argument Windows ignores
// protects nobody), secrets/ itself sealed so an editor's atomic replacement hands the
// file back no wider than the directory, --apply reporting a store whose protection has
// slipped — and the hint after applying names the action that really applies the values:
// restart for a running instance, up only for a stopped one.
//
// Split out of secrets-command.check.ts; see fixture.ts for the shared deployment and
// the sibling *.check.ts files for the rest.

import { readFile, writeFile, stat, access, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { secrets } from "#framework/commands/management/secrets.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { spawnLocal } from "#framework/runtime/transport.ts";
import type { Context } from "#framework/core/context.ts";
import { setupDeployment, teardownDeployment } from "./fixture.ts";

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

function skip(reason: string): void {
  process.stderr.write(`  skip ${reason}\n`);
}

// The private-file.check.ts idiom, copied rather than imported: check files run for their
// side effects (tools/checks/run.ts imports them all into one process), so nothing may be
// imported from one. The DACL is read back through the real icacls /save — SDDL, trustee
// SIDs, no localized display names — so the store's protection is proven, not trusted.
const systemTool = (name: string): string => join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

const icacls = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  spawnLocal(systemTool("icacls.exe"), args, { allowFailure: true, timeoutMs: 60_000 });

async function windowsOwnerSid(): Promise<string> {
  const result = await spawnLocal(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { allowFailure: true });
  return /S-1-\d+(?:-\d+)+/.exec(result.stdout)?.[0] ?? "";
}

async function savedAces(file: string): Promise<{ daclProtected: boolean; aces: { type: string; flags: string; rights: string; trustee: string }[] }> {
  const saved = join(tmpdir(), `clawforge-store-check-dacl-${randomBytes(6).toString("hex")}.txt`);
  const result = await icacls([file, "/save", saved]);
  if (result.code !== 0) throw new Error(`icacls /save failed: ${result.stdout.trim()}`);
  try {
    const text = await readFile(saved, "utf16le");
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("D:"));
    const aces = [...(line ?? "").matchAll(/\(([^()]*)\)/g)].map((match) => {
      const [type = "", flags = "", rights = "", , , trustee = ""] = match[1].split(";");
      return { type, flags, rights, trustee };
    });
    return { daclProtected: /^D:([A-Z]*)/.exec(line ?? "")?.[1]?.includes("P") === true, aces };
  } finally {
    await rm(saved, { force: true }).catch(() => {});
  }
}

/** Plants the reviewer's scenario on the directory: an inheritable Guests ACE on Windows,
 *  world access on POSIX — whatever a fresh store inside it must not end up with. */
async function widenForReview(directory: string): Promise<void> {
  if (process.platform === "win32") {
    const planted = await icacls([directory, "/grant", "*S-1-5-32-546:(OI)(CI)R"]);
    if (planted.code !== 0) throw new Error(`could not plant the Guests ACE: ${planted.stdout.trim()}`);
    return;
  }
  await chmod(directory, 0o777);
}

const deployDir = await setupDeployment("store");

try {
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

  // The apply-side stub: like the one above it states only what its cases need, but the
  // hint under test is decided by the instance state, so this one carries a runtime whose
  // isRunning() the cases control. The live config exists and declares provider zai, so
  // ZAI_API_KEY is genuinely required both by --apply's prospective list and by the
  // status listing.
  const targetEnv = "/srv/clawforge/data/config/.env";
  let targetEnvContent = "";
  // What the private staging write is holding until the rename publishes it.
  let staged: string | undefined;
  let running = false;
  const applyCtx = {
    settings: { dataDir: "/srv/clawforge/data", env: {} },
    applicationSecrets: async () => [{
      name: "REPO_SECRET",
      location: "repo-env" as const,
      usedBy: "local-store check",
      required: false,
    }],
    runtime: {
      async isRunning(): Promise<boolean> {
        return running;
      },
    },
    transport: {
      description: "stub",
      async exists(_path: string): Promise<boolean> {
        // The live config exists: the status listing needs a requirement it can name as
        // missing, and --apply's prospective list merges this same config.
        return true;
      },
      async readFile(path: string): Promise<string> {
        if (path.endsWith("openclaw.json")) return '{"models":{"providers":{"zai":{}}}}';
        if (path === targetEnv) return targetEnvContent;
        return "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        if (path === targetEnv) targetEnvContent = content;
      },
      async exec(
        command: string,
        args: string[],
        options?: { input?: string | Uint8Array },
      ): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "mkdir" && args[0] !== "-p") return { code: 0, stdout: "", stderr: "" };
        if (command === "test" && args[0] === "-d") return { code: 1, stdout: "", stderr: "" };
        // loadSecrets stages the keys privately and publishes them with one rename, so the
        // target's config/.env is reached by mv, never by a direct write.
        if (command === "sh" && args[0] === "-c" && args[1]?.includes("umask 077") === true) {
          const input = options?.input ?? "";
          staged = typeof input === "string" ? input : new TextDecoder().decode(input);
        }
        if (command === "mv" && args[args.length - 1] === targetEnv && staged !== undefined) {
          targetEnvContent = staged;
          staged = undefined;
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;

  // --- P2-01: after applying, the operator must be told the action that actually applies
  // the change — restart for a running instance, up only for a stopped one — and that the
  // file is already written while the running instance has NOT read it. `up` runs compose
  // up --detach, which leaves an already-running gateway alone, so the old wording
  // promised a restart it never performed. ----------------------------------------------
  await writeFile(
    resolve(deployDir, "config", "desired-state.json"),
    JSON.stringify([{ path: "models.providers.zai", value: {} }]),
    "utf8",
  );

  await withOutputSink(
    () => {},
    () => secrets(applyCtx, ["--init-store", "--store", "hint"]),
  );
  const hintStore = resolve(deployDir, "secrets", "hint.env");
  const hintTemplate = await readFile(hintStore, "utf8");
  check("a central store template includes repository requirements", hintTemplate.includes("REPO_SECRET="), true);
  await writeFile(hintStore, "ZAI_API_KEY=zai-value\n", "utf8");

  running = true;
  let runningOutput = "";
  await withOutputSink(
    (chunk) => {
      runningOutput += chunk;
    },
    () => secrets(applyCtx, ["--apply", "--store", "hint"]),
  );
  check("a running instance is told to restart, not to run up", runningOutput.includes("./clawforge restart"), true);
  check("the running hint does not name ./clawforge up", runningOutput.includes("./clawforge up"), false);
  check("the running hint says the file is written but has not been read", runningOutput.includes("has not read"), true);
  check("the values were installed before the hint is given", targetEnvContent, "ZAI_API_KEY=zai-value\n");

  running = false;
  let stoppedOutput = "";
  await withOutputSink(
    (chunk) => {
      stoppedOutput += chunk;
    },
    () => secrets(applyCtx, ["--apply", "--store", "hint"]),
  );
  check("a stopped instance is told to start, not to restart", stoppedOutput.includes("./clawforge up"), true);
  check("the stopped hint does not name ./clawforge restart", stoppedOutput.includes("./clawforge restart"), false);

  // The same contract on the status listing's own hint (the missing-secrets branch):
  // which command applies the change depends on whether an instance is running at all.
  targetEnvContent = "";
  running = true;
  let statusRunningOutput = "";
  try {
    await withOutputSink(
      (chunk) => {
        statusRunningOutput += chunk;
      },
      () => secrets(applyCtx, []),
    );
  } catch {
    // The missing-secrets listing ends in a deliberate throw; the hint is what matters.
  }
  check("the status hint names restart for a running instance", statusRunningOutput.includes("then ./clawforge restart"), true);
  check("the status hint for a running instance does not name up", statusRunningOutput.includes("./clawforge up"), false);

  running = false;
  let statusStoppedOutput = "";
  try {
    await withOutputSink(
      (chunk) => {
        statusStoppedOutput += chunk;
      },
      () => secrets(applyCtx, []),
    );
  } catch {
    // Deliberate throw, as above.
  }
  check("the status hint names up for a stopped instance", statusStoppedOutput.includes("then ./clawforge up"), true);
  check("the status hint for a stopped instance does not name restart", statusStoppedOutput.includes("./clawforge restart"), false);

  // --- P1-02: the store follows the deployment .env's safe-creation contract — owner-only
  // from the first byte, on Windows a closed DACL rather than the POSIX mode argument
  // Windows ignores — secrets/ itself is sealed so an editor's atomic replacement does not
  // hand the file back wide inherited permissions, and --apply reports a store whose
  // protection has slipped. The honest proof on Windows is the real DACL; the POSIX mode
  // assertions skip there because chmod bits mean nothing on Windows filesystems. -------
  const secretsDirectory = resolve(deployDir, "secrets");

  {
    await widenForReview(secretsDirectory);
    await withOutputSink(
      () => {},
      () => secrets(applyCtx, ["--init-store", "--store", "sealed"]),
    );
    const sealedStore = resolve(secretsDirectory, "sealed.env");
    const sealedContent = await readFile(sealedStore, "utf8");
    check("the review store is created with an empty template", /=\S/.test(sealedContent), false);
    if (process.platform === "win32") {
      skip("POSIX mode assertions on Windows (ACLs are authoritative)");
      const owner = await windowsOwnerSid();
      const allowed = [owner, "S-1-5-18", "S-1-5-32-544", "BA", "SY"];
      const storeDacl = await savedAces(sealedStore);
      check("the fresh store's DACL is sealed against inheritance", storeDacl.daclProtected && storeDacl.aces.every((ace) => !ace.flags.includes("ID")), true);
      check("the fresh store names only owner, SYSTEM and Administrators", storeDacl.aces.every((ace) => allowed.includes(ace.trustee)), true);
      check("the fresh store gives the owner full access", storeDacl.aces.some((ace) => ace.trustee === owner && /^FA$/i.test(ace.rights)), true);
      const dirDacl = await savedAces(secretsDirectory);
      check("secrets/ itself is sealed against inheritance", dirDacl.daclProtected && dirDacl.aces.every((ace) => !ace.flags.includes("ID")), true);
      check("secrets/ no longer grants the planted Guests access", dirDacl.aces.every((ace) => !["S-1-5-32-546", "BG"].includes(ace.trustee)), true);
    } else {
      skip("Windows DACL assertions on POSIX (no DACL to read)");
      check("secrets/ itself is owner-only (700, execute included)", (await stat(secretsDirectory)).mode & 0o777, 0o700);
      check("the fresh store file is owner-only", (await stat(sealedStore)).mode & 0o777, 0o600);
    }
  }

  {
    const sealedStore = resolve(secretsDirectory, "sealed.env");
    await writeFile(sealedStore, "SOME_KEY=leftover-value\n", "utf8");
    await widenForReview(secretsDirectory);
    await withOutputSink(
      () => {},
      () => secrets(applyCtx, ["--init-store", "--store", "sealed", "--force"]),
    );
    const afterForce = await readFile(sealedStore, "utf8");
    check("--force replaces a filled store with the empty template", afterForce.includes("leftover-value"), false);
    if (process.platform === "win32") {
      skip("POSIX mode assertions on Windows (ACLs are authoritative)");
      const owner = await windowsOwnerSid();
      const allowed = [owner, "S-1-5-18", "S-1-5-32-544", "BA", "SY"];
      const storeDacl = await savedAces(sealedStore);
      check("--force's replacement keeps the DACL sealed against inheritance", storeDacl.daclProtected && storeDacl.aces.every((ace) => !ace.flags.includes("ID")), true);
      check("--force's replacement names only owner, SYSTEM and Administrators", storeDacl.aces.every((ace) => allowed.includes(ace.trustee)), true);
      const dirDacl = await savedAces(secretsDirectory);
      check("--force seals secrets/ again despite the planted Guests ACE", dirDacl.daclProtected && dirDacl.aces.every((ace) => !["S-1-5-32-546", "BG"].includes(ace.trustee)), true);
    } else {
      skip("Windows DACL assertions on POSIX (no DACL to read)");
      check("--force keeps secrets/ owner-only", (await stat(secretsDirectory)).mode & 0o777, 0o700);
      check("--force keeps the replacement owner-only", (await stat(sealedStore)).mode & 0o777, 0o600);
    }
  }

  {
    // Using a store whose protection has slipped must be said out loud. The slipped
    // protection itself is planted the way it would really arrive: an explicit Guests
    // grant on Windows, world-read on POSIX.
    const sealedStore = resolve(secretsDirectory, "sealed.env");
    await writeFile(sealedStore, "ZAI_API_KEY=zai-value\n", "utf8");
    if (process.platform === "win32") {
      const planted = await icacls([sealedStore, "/grant", "*S-1-5-32-546:R"]);
      if (planted.code !== 0) throw new Error(`could not plant the Guests ACE: ${planted.stdout.trim()}`);
    } else {
      await chmod(sealedStore, 0o644);
    }
    targetEnvContent = "";
    let exposedOutput = "";
    await withOutputSink(
      (chunk) => {
        exposedOutput += chunk;
      },
      () => secrets(applyCtx, ["--apply", "--store", "sealed"]),
    );
    check("applying a store that is not owner-only says so, naming the file", exposedOutput.includes(sealedStore) && exposedOutput.includes("not owner-only"), true);
    check("the exposure report never carries the value", exposedOutput.includes("zai-value"), false);
    check("the report is a warning, not a refusal — the values are still installed", targetEnvContent, "ZAI_API_KEY=zai-value\n");
  }
  {
    // One local store can feed both runtime locations while preserving unrelated settings.
    const repositoryEnv = resolve(deployDir, ".env");
    const repositoryStore = resolve(secretsDirectory, "repo.env");
    await writeFile(repositoryEnv, "KEEP_SETTING=keep\n", "utf8");
    await writeFile(repositoryStore, "ZAI_API_KEY=zai-value\nREPO_SECRET=repo-value\n", "utf8");
    targetEnvContent = "";

    let repositoryOutput = "";
    await withOutputSink(
      (chunk) => {
        repositoryOutput += chunk;
      },
      () => secrets(applyCtx, ["--apply", "--store", "repo"]),
    );
    const deliveredRepositoryEnv = await readFile(repositoryEnv, "utf8");
    check("one store delivers target values", targetEnvContent, "ZAI_API_KEY=zai-value\n");
    check("one store delivers repository values", deliveredRepositoryEnv.includes("REPO_SECRET=repo-value"), true);
    check("repository settings survive delivery", deliveredRepositoryEnv.includes("KEEP_SETTING=keep"), true);
    check("delivery output never carries repository secret values", repositoryOutput.includes("repo-value"), false);
  }
} finally {
  await teardownDeployment(deployDir);
}

process.stderr.write(failed === 0 ? "all local-store checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
