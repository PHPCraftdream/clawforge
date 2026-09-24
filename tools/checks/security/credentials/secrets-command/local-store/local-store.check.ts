// Exercises local-store lifecycle, secret requirements, and apply/recovery behavior.
// Uses real ACL checks where available and modeled remote transports for target operations.

import { readFile, writeFile, stat, chmod, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { secrets } from "#framework/commands/management/secrets.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { spawnLocal } from "#framework/runtime/transport.ts";
import type { Context } from "#framework/core/context.ts";
import { setupDeployment, teardownDeployment } from "../fixture.ts";

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

function ownerAlias(trustee: string, owner: string): string {
  return trustee === "LA" && owner.endsWith("-500") ? owner : trustee;
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
  // The apply-side stub: like the one above it states only what its cases need, but the
  // hint under test is decided by the instance state, so this one carries a runtime whose
  // isRunning() the cases control. The live config exists and declares provider zai, so
  // ZAI_API_KEY is genuinely required both by --apply's prospective list and by the
  // status listing.
  const targetEnv = "/srv/clawforge/data/config/.env";
  let targetEnvContent = "";
  // The live gateway config the transport answers with. The repo-env delivery block swaps a
  // provider-free config in: a declared provider makes ZAI_API_KEY a required store value,
  // and a store supplying that target-env value would drag the target-env branch — whose
  // running-instance hint is the restart suggestion that block exists to forbid — into an
  // apply that must exercise the repository delivery alone.
  let liveConfig = '{"models":{"providers":{"zai":{}}}}';
  // What the private staging write is holding until the rename publishes it.
  let staged: string | undefined;
  let running = false;
  const lockFiles = new Map<string, string>();
  const lockDirs = new Set<string>();
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
      // --dump's repo-env recovery: absent by default (simulates a runtime that cannot
      // introspect its container at all); the dump test block below replaces this per case.
      runningEnvironment: undefined as (() => Promise<Record<string, string> | undefined>) | undefined,
    },
    transport: {
      description: "stub",
      async exists(_path: string): Promise<boolean> {
        // The live config exists: the status listing needs a requirement it can name as
        // missing, and --apply's prospective list merges this same config.
        return true;
      },
      async readFile(path: string): Promise<string> {
        if (lockFiles.has(path)) return lockFiles.get(path)!;
        if (path.endsWith("openclaw.json")) return liveConfig;
        if (path === targetEnv) return targetEnvContent;
        return "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        if (path.includes("/operation.mutation/")) lockFiles.set(path, content);
        if (path === targetEnv) targetEnvContent = content;
      },
      async remove(path: string): Promise<void> {
        lockFiles.delete(path);
      },
      async listFiles(path: string): Promise<string[]> {
        const prefix = `${path}/`;
        return [...lockFiles.keys()].filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
      },
      async exec(
        command: string,
        args: string[],
        options?: { input?: string | Uint8Array },
      ): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "mkdir" && args[0] !== "-p") {
          const target = args[args.length - 1] ?? "";
          if (lockDirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
          lockDirs.add(target);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "ln") {
          const [source, destination] = args;
          if (source === undefined || destination === undefined || !lockFiles.has(source) || lockFiles.has(destination)) {
            return { code: 1, stdout: "", stderr: "File exists" };
          }
          lockFiles.set(destination, lockFiles.get(source)!);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "rmdir") {
          lockDirs.delete(args[args.length - 1] ?? "");
          return { code: 0, stdout: "", stderr: "" };
        }
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
  check("the repo-env section tells the operator to copy the existing value", hintTemplate.includes("already exists in the repository's own .env"), true);
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

  // --- P3-03: the status listing mixes optional requirements in with required ones, and an
  // optional secret that is simply not set yet is not missing anything the gateway needs —
  // printing it as MISSING under a "required secrets" heading left the summary line ("all
  // required secrets are present") and the listing contradicting each other. The mark is
  // display only: missing() still gates the throw. --------------------------------------
  targetEnvContent = "";
  running = false;
  let optionalAbsentOutput = "";
  let optionalAbsentError = "";
  try {
    await withOutputSink(
      (chunk) => {
        optionalAbsentOutput += chunk;
      },
      () => secrets(applyCtx, []),
    );
  } catch (error) {
    optionalAbsentError = error instanceof Error ? error.message : String(error);
  }
  check("the required-absent entry is still reported missing", optionalAbsentOutput.includes("MISSING ZAI_API_KEY"), true);
  check("the optional-absent entry is not reported as missing", optionalAbsentOutput.includes("MISSING REPO_SECRET"), false);
  check("the optional-absent entry is marked as optional", optionalAbsentOutput.includes("optional REPO_SECRET"), true);
  check("the missing-required throw still happened", optionalAbsentError !== "", true);

  // The success path: with the required value in place the run completes, and no MISSING
  // mark may appear anywhere — the optional entry is merely not set yet.
  targetEnvContent = "ZAI_API_KEY=zai-value\n";
  let successOutput = "";
  await withOutputSink(
    (chunk) => {
      successOutput += chunk;
    },
    () => secrets(applyCtx, []),
  );
  check("the success run reaches the all-present summary", successOutput.includes("all required secrets are present"), true);
  check("no MISSING mark appears when only an optional entry is absent", successOutput.includes("MISSING"), false);
  check("the optional entry is marked optional on the success path too", successOutput.includes("optional REPO_SECRET"), true);

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
      check("the fresh store names only owner, SYSTEM and Administrators", storeDacl.aces.every((ace) => allowed.includes(ownerAlias(ace.trustee, owner))), true);
      check("the fresh store gives the owner full access", storeDacl.aces.some((ace) => ownerAlias(ace.trustee, owner) === owner && /^FA$/i.test(ace.rights)), true);
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
      check("--force's replacement names only owner, SYSTEM and Administrators", storeDacl.aces.every((ace) => allowed.includes(ownerAlias(ace.trustee, owner))), true);
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
  {
    // The delivery contract for repository values: restart cannot apply them (a container's
    // environment is fixed at creation), so the command either performs the recreate or says
    // exactly that — and then confirms what the container actually holds, by name, never by
    // value.
    const repositoryEnv = resolve(deployDir, ".env");
    const repositoryStore = resolve(secretsDirectory, "repo-delivery.env");
    await writeFile(repositoryEnv, "KEEP_SETTING=keep\n", "utf8");
    await writeFile(repositoryStore, "REPO_SECRET=repo-value-two\n", "utf8");
    targetEnvContent = "ZAI_API_KEY=zai-value\n";
    // A repo-env apply and nothing else: applyStore refuses a store missing a required
    // prospective value, but a store supplying ZAI_API_KEY would also run the target-env
    // branch, whose running-instance hint names ./clawforge restart — the very suggestion
    // this block pins as absent. With neither the live config nor the desired-state
    // declaration naming a provider, REPO_SECRET (optional, repo-env) is the only
    // requirement, and the store's single value satisfies it.
    liveConfig = "{}";
    await writeFile(resolve(deployDir, "config", "desired-state.json"), "[]", "utf8");

    const delivered: { reconciled: boolean; waited: boolean } = { reconciled: false, waited: false };
    applyCtx.runtime.reconcile = async (): Promise<void> => { delivered.reconciled = true; };
    applyCtx.runtime.waitForHealth = async (): Promise<void> => { delivered.waited = true; };
    applyCtx.runtime.runningEnvironment = async () => ({ REPO_SECRET: "repo-value-two" });

    running = true;
    let deliveryOutput = "";
    await withOutputSink(
      (chunk) => {
        deliveryOutput += chunk;
      },
      () => secrets(applyCtx, ["--apply", "--store", "repo-delivery"]),
    );
    check("a running instance gets the recreate performed, not suggested", delivered.reconciled, true);
    check("the command waits for health after recreating", delivered.waited, true);
    check("the recreate is announced as replacing the container", deliveryOutput.includes("replaced, not merely signalled"), true);
    check("the confirmation names the variable in force", deliveryOutput.includes("confirmed") && deliveryOutput.includes("REPO_SECRET"), true);
    check("the confirmation never carries the value", deliveryOutput.includes("repo-value-two"), false);
    check("nothing suggests restart for repository values", deliveryOutput.includes("./clawforge restart"), false);

    // A container that still answers with the previous value is named, by variable only.
    await writeFile(repositoryStore, "REPO_SECRET=repo-value-three\n", "utf8");
    applyCtx.runtime.runningEnvironment = async () => ({ REPO_SECRET: "previous-value" });
    let staleOutput = "";
    await withOutputSink(
      (chunk) => {
        staleOutput += chunk;
      },
      () => secrets(applyCtx, ["--apply", "--store", "repo-delivery"]),
    );
    check("a container still holding the old value is reported by name", staleOutput.includes("REPO_SECRET") && staleOutput.includes("does not hold"), true);
    check("the mismatch report never carries either value", staleOutput.includes("repo-value-three") || staleOutput.includes("previous-value"), false);
    check("the mismatch repair names the recreate", staleOutput.includes("./clawforge up"), true);

    // Without the capability the command says so and hands over the honest verb.
    delete applyCtx.runtime.reconcile;
    applyCtx.runtime.runningEnvironment = async () => ({ REPO_SECRET: "repo-value-three" });
    let incapableOutput = "";
    await withOutputSink(
      (chunk) => {
        incapableOutput += chunk;
      },
      () => secrets(applyCtx, ["--apply", "--store", "repo-delivery"]),
    );
    check("a runtime that cannot recreate is told to run up", incapableOutput.includes("recreate the container") && incapableOutput.includes("./clawforge up"), true);
    check("the incapable runtime still gets no restart suggestion", incapableOutput.includes("./clawforge restart"), false);

    // Stopped: the next start creates the container with the new values.
    running = false;
    applyCtx.runtime.reconcile = async (): Promise<void> => { delivered.reconciled = true; };
    let stoppedDeliveryOutput = "";
    const reconciledBefore = delivered.reconciled;
    await withOutputSink(
      (chunk) => {
        stoppedDeliveryOutput += chunk;
      },
      () => secrets(applyCtx, ["--apply", "--store", "repo-delivery"]),
    );
    check("a stopped instance is told the next start carries the values", stoppedDeliveryOutput.includes("the instance is stopped") && stoppedDeliveryOutput.includes("./clawforge up"), true);
    check("a stopped instance is not recreated by --apply", delivered.reconciled, reconciledBefore);

    // The dump block below proves target-env recovery with a ZAI_API_KEY value, which only
    // exists in a store that requirements name — put the provider requirement back.
    liveConfig = '{"models":{"providers":{"zai":{}}}}';
    await writeFile(
      resolve(deployDir, "config", "desired-state.json"),
      JSON.stringify([{ path: "models.providers.zai", value: {} }]),
      "utf8",
    );
  }
  {
    // --dump: the reverse of --apply. target-env is read straight from the target's own
    // config/.env (the exact file --apply writes and status/dumpSecrets already read);
    // repo-env (REPO_SECRET here) is read from the running container's own environment,
    // since it was never written to the target's filesystem at all.
    const recoveredStore = resolve(secretsDirectory, "recovered.env");
    targetEnvContent = "ZAI_API_KEY=live-zai-value\n";
    applyCtx.runtime.runningEnvironment = async () => ({ REPO_SECRET: "live-repo-value" });

    let dumpOutput = "";
    await withOutputSink(
      (chunk) => {
        dumpOutput += chunk;
      },
      () => secrets(applyCtx, ["--dump", "--store", "recovered"]),
    );
    const recoveredContent = await readFile(recoveredStore, "utf8");
    check("a target-env value is recovered from the target's own config/.env", recoveredContent.includes("ZAI_API_KEY=live-zai-value"), true);
    check("a repo-env value is recovered from the running container's own environment", recoveredContent.includes("REPO_SECRET=live-repo-value"), true);
    check("the dump report never carries a recovered value", dumpOutput.includes("live-zai-value") || dumpOutput.includes("live-repo-value"), false);

    // Re-running without --force must refuse and leave the recovered store untouched — the
    // same contract --init-store already has, reused rather than invented a second time.
    let dumpRefusal = "";
    try {
      await withOutputSink(
        () => {},
        () => secrets(applyCtx, ["--dump", "--store", "recovered"]),
      );
    } catch (error) {
      dumpRefusal = error instanceof Error ? error.message : String(error);
    }
    check("re-running --dump without --force throws", dumpRefusal !== "", true);
    check("the refusal mentions --force", dumpRefusal.includes("--force"), true);

    // A name recovery cannot reach is left blank and named, never guessed or silently
    // dropped — the runtime here answers, but does not know REPO_SECRET this time.
    applyCtx.runtime.runningEnvironment = async () => ({});
    let partialOutput = "";
    await withOutputSink(
      (chunk) => {
        partialOutput += chunk;
      },
      () => secrets(applyCtx, ["--dump", "--store", "recovered", "--force"]),
    );
    const partialContent = await readFile(recoveredStore, "utf8");
    check("an unrecovered repo-env name is left blank", /^REPO_SECRET=$/m.test(partialContent), true);
    check("an unrecovered name is reported by name", partialOutput.includes("REPO_SECRET"), true);
    check("a running instance that answers empty is not reported as not running", partialOutput.includes("not running"), false);

    // The runtime cannot introspect its container at all (the default stub above).
    applyCtx.runtime.runningEnvironment = undefined;
    let noCapabilityOutput = "";
    await withOutputSink(
      (chunk) => {
        noCapabilityOutput += chunk;
      },
      () => secrets(applyCtx, ["--dump", "--store", "recovered", "--force"]),
    );
    check("a runtime without the capability says so", noCapabilityOutput.includes("cannot read a running container's own environment"), true);

    // The runtime has the capability but reports the instance unreachable/not running.
    applyCtx.runtime.runningEnvironment = async () => undefined;
    let notRunningOutput = "";
    await withOutputSink(
      (chunk) => {
        notRunningOutput += chunk;
      },
      () => secrets(applyCtx, ["--dump", "--store", "recovered", "--force"]),
    );
    check("an unreachable running instance is reported as such", notRunningOutput.includes("the instance is not running"), true);
  }
} finally {
  await teardownDeployment(deployDir);
}

process.stderr.write(failed === 0 ? "all local-store checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
