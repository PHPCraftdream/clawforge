// P1-03 (audit 2026-09-23, round 4): the agent bundle (recipes/<name>/agent/) used to have
// its own reader. checksums.ts (agentBundleChecksums, for the set manifest and the lock) and
// inspect (via that same function and via loadRecipeAgentBundle) walked the shared
// portable-content policy in security/recipe-portable-content.ts. Direct provisioning —
// loadRecipeAgentBundle in commands/management/provision-agent/declaration.ts, the function
// that actually copies bytes into the agent's workspace — did a raw readdir()+readFile() of
// every *.md and a raw readFile() of cron-message.txt instead, with no policy check at all.
// So `privateFiles: ["agent/private.md"]` kept the file out of the manifest/checksum map
// while the real, working-tree provision copied it into the agent's workspace regardless, and
// a public-named symlink was read straight through with no containment check.
//
// The fix (declaration.ts, checksums.ts, recipe-portable-content.ts) makes every reader of an
// agent bundle share ONE walk: collectPortableAgentBundleFiles, a thin wrapper over
// collectPortableRecipeFiles rooted at agent/ that answers "no agent/ at all" with undefined
// instead of a thrown ENOENT. loadRecipeAgentBundle now only reads files that walk returned,
// and refuses outright — before reading anything — when a file the bundle cannot function
// without (config.json, or cron-message.txt when the recipe declares a cron job) is itself
// excluded by policy, rather than silently reading it anyway (the original bug) or silently
// dropping the cron job the recipe declared.
//
// These checks prove:
//   - agentBundleChecksums (the build/manifest/lock reader) and loadRecipeAgentBundle (the
//     direct-provision/inspect reader) reach the IDENTICAL verdict for a declared-private
//     file, an undeclared sensitive-named file, and an internal alias to a declared-private
//     target — the exact three-way parity the audit asked for, since inspect itself calls
//     both of these functions and nothing else, so fixing them fixes inspect for free;
//   - `./clawforge set build` (set-manifest.ts) carries the same verdict into
//     manifest.recipes.<name>.agentFiles, the artifact `set apply` provisions from;
//   - a symlink escaping the recipe directory is refused by every one of those readers BEFORE
//     any file is read — proven by asserting the rejection carries none of the private bytes
//     an unguarded readFile would have picked up;
//   - an `agent/` that is ITSELF a symlink out of the recipe is refused by every reader
//     before anything is walked or read (round 6, P1-05) — the escape is the root, so no
//     child Dirent could report it — and so is a root or child link that does not resolve,
//     which used to ENOENT its way into an honestly-empty bundle;
//   - a recipe whose agent/ is a plain real directory still walks and provisions exactly
//     as before — the root-level vetting must not disturb the common case;
//   - a recipe that declares its own cron-message.txt private is refused by
//     loadRecipeAgentBundle rather than silently losing its cron job or reading the message
//     bytes anyway; the same for a recipe that declares its own config.json private, which
//     cannot be provisioned at all without it.
//
// Windows/privilege caveat: creating symlinks can fail without developer mode or elevated
// privileges (file links have no fallback; directory links fall back to a junction, which
// needs neither). Any group whose links cannot be created degrades exactly the way round
// 3's P1-01 check (runtime/lifecycle/recipe-portable-content.check.ts) already does: it
// prints `skip` and never fails, and the rest of the file still runs.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSet } from "#framework/commands/sets/set.ts";
import { loadRecipeAgentBundle } from "#framework/commands/management/provision-agent/index.ts";
import { collectPortableAgentBundleFiles } from "#framework/security/recipe-portable-content.ts";
import { agentBundleChecksums } from "#framework/service/checksums.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { deploymentDir, useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

function skip(name: string): void {
  process.stderr.write(`  skip ${name}\n`);
}

/** The message a rejected promise failed with, or undefined when it did not reject. */
async function rejectionOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

/** Creates a symlink, answering false instead of throwing — Windows without developer mode
 *  (or privileges) refuses, and the alias group must skip, not fail, there. A directory
 *  link falls back to an NTFS junction, which Windows creates without either: the policy
 *  under test decides on resolved REAL paths, so the link flavor is irrelevant to it. */
async function trySymlink(target: string, path: string, type: "file" | "dir" | "junction" = "file"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    if (type !== "dir") return false;
    try {
      await symlink(target, path, "junction");
      return true;
    } catch {
      return false;
    }
  }
}

const MARKER = "FIXTURE-CREDENTIAL-p1-03-r4";
// A digest-pinned image needs no lock file: requiredImage pins a @sha256 reference as given.
const IMAGE = `fixture@sha256:${"b".repeat(64)}`;

/** A stub context whose transport and runtime THROW on any use: a set must build with no
 *  target, and a stub that politely answers would let that rule erode silently. Same idiom as
 *  runtime/lifecycle/recipe-portable-content.check.ts's buildOnlyCtx. */
function buildOnlyCtx(image: string): Context {
  const refuse = (what: string) => () => {
    throw new Error(`the set build used the ${what} — a set must build with no instance and no reachable target`);
  };
  return {
    settings: { image },
    transport: new Proxy({}, { get: (_target, property) => refuse(`transport.${String(property)}`) }),
    runtime: new Proxy({}, { get: (_target, property) => refuse(`runtime.${String(property)}`) }),
  } as unknown as Context;
}

const tempRoot = await mkdtemp(join(tmpdir(), "clawforge-p1-03-r4-"));
const previousDeployment = (() => {
  try {
    return deploymentDir();
  } catch {
    return undefined;
  }
})();

try {
  await mkdir(resolve(tempRoot, "config"), { recursive: true });
  await writeFile(resolve(tempRoot, "config", "desired-state.json"), "[]");
  useDeployment(tempRoot);

  // --- Group A: private file, sensitive-name file, ordinary content — three-way parity ------

  const bundledDir = resolve(tempRoot, "recipes", "bundled");
  await mkdir(resolve(bundledDir, "agent"), { recursive: true });
  await writeFile(
    resolve(bundledDir, "recipe.json"),
    JSON.stringify({ description: "declares one agent prompt private", privateFiles: ["agent/private.md"] }),
  );
  await writeFile(
    resolve(bundledDir, "agent", "config.json"),
    JSON.stringify({ agentId: "demo-agent", mcpServerName: "demo-mcp", cronJobName: "demo-cron" }),
  );
  await writeFile(resolve(bundledDir, "agent", "AGENTS.md"), "# public instructions\n");
  await writeFile(resolve(bundledDir, "agent", "private.md"), `${MARKER}=declared-private-prompt\n`);
  // Undeclared: held back only by the sensitive-name shape policy, so this exercises the
  // second exclusion path a value scan alone would never catch.
  await writeFile(resolve(bundledDir, "agent", ".env"), `${MARKER}=undeclared-sensitive-name\n`);
  await writeFile(resolve(bundledDir, "agent", "cron-message.txt"), "ordinary scheduled message\n");

  const bundledWalked = await withOutputSink(() => {}, () => collectPortableAgentBundleFiles(bundledDir));
  check("the walker carries only the ordinary agent files", bundledWalked?.files.sort(), ["AGENTS.md", "config.json", "cron-message.txt"]);
  check(
    "the walker reports the declared-private and sensitive-name exclusions recipe-relative",
    bundledWalked?.excluded.map((entry) => [entry.path, entry.reason]).sort((a, b) => a[0].localeCompare(b[0])),
    [
      ["agent/.env", "sensitive-name policy"],
      ["agent/private.md", "declared privateFiles"],
    ],
  );

  const bundledChecksums = await withOutputSink(() => {}, () => agentBundleChecksums(bundledDir));
  check("the checksum map (build/lock) carries the same ordinary files", Object.keys(bundledChecksums).sort(), ["AGENTS.md", "config.json", "cron-message.txt"]);
  check("the checksum map holds back the same two names", ["private.md", ".env"].some((rel) => rel in bundledChecksums), false);
  check("the checksum map carries no private bytes", JSON.stringify(bundledChecksums).includes(MARKER), false);

  const bundledBundle = await withOutputSink(() => {}, () => loadRecipeAgentBundle("bundled"));
  check(
    "direct provisioning (loadRecipeAgentBundle) writes the SAME prompt file set the checksum map carries",
    Object.keys(bundledBundle.promptFiles),
    ["AGENTS.md"],
  );
  check("direct provisioning never reads the declared-private prompt into the workspace payload", "private.md" in bundledBundle.promptFiles, false);
  check("direct provisioning carries the ordinary cron message", bundledBundle.cronMessage, "ordinary scheduled message");
  check("direct provisioning's bundle carries no private bytes anywhere", JSON.stringify(bundledBundle).includes(MARKER), false);

  const bundledBuilt = await withOutputSink(() => {}, () => buildSet(buildOnlyCtx(IMAGE), "p1-03-r4"));
  const bundledManifestAgentFiles = bundledBuilt.manifest.recipes.bundled?.agentFiles ?? {};
  check("set build's manifest carries the SAME agent file set as the checksum map and direct provisioning", Object.keys(bundledManifestAgentFiles).sort(), ["AGENTS.md", "config.json", "cron-message.txt"]);
  check("set build holds back the same two names too", ["private.md", ".env"].some((rel) => rel in bundledManifestAgentFiles), false);
  check("the set artifact carries no private bytes", JSON.stringify(bundledBuilt.manifest).includes(MARKER), false);

  // --- Group B: an internal alias to the recipe's own declared-private prompt (round 3, P1-01
  //     pattern) — same three-way parity, now for a public-named symlink onto a private target.

  const aliasCreated = await trySymlink(resolve(bundledDir, "agent", "private.md"), resolve(bundledDir, "agent", "alias-private.md"));
  if (!aliasCreated) {
    skip("the walker holds back a public-named alias of a declared-private prompt (symlinks unavailable on this machine)");
    skip("the checksum map holds back the same alias (symlinks unavailable on this machine)");
    skip("direct provisioning never writes the alias into the workspace payload (symlinks unavailable on this machine)");
    skip("set build holds back the same alias too (symlinks unavailable on this machine)");
    skip("no reader anywhere carries the private bytes through the alias (symlinks unavailable on this machine)");
  } else {
    const aliasWalked = await withOutputSink(() => {}, () => collectPortableAgentBundleFiles(bundledDir));
    check(
      "the walker holds back a public-named alias of a declared-private prompt, under the target's own reason",
      aliasWalked?.excluded.some((entry) => entry.path === "agent/alias-private.md" && entry.reason === "declared privateFiles (symlink target)"),
      true,
    );
    check("the walker still carries the ordinary prompt through all of this", aliasWalked?.files.includes("AGENTS.md"), true);

    const aliasChecksums = await withOutputSink(() => {}, () => agentBundleChecksums(bundledDir));
    check("the checksum map holds back the alias exactly as it holds back the target", "alias-private.md" in aliasChecksums, false);

    const aliasBundle = await withOutputSink(() => {}, () => loadRecipeAgentBundle("bundled"));
    check("direct provisioning never writes the alias into the workspace payload", "alias-private.md" in aliasBundle.promptFiles, false);

    const aliasBuilt = await withOutputSink(() => {}, () => buildSet(buildOnlyCtx(IMAGE), "p1-03-r4"));
    check("set build holds back the alias in the manifest too", "alias-private.md" in (aliasBuilt.manifest.recipes.bundled?.agentFiles ?? {}), false);
    check(
      "no reader anywhere carries the private bytes through the alias",
      [aliasWalked, aliasChecksums, aliasBundle, aliasBuilt.manifest].some((value) => JSON.stringify(value).includes(MARKER)),
      false,
    );
    await rm(resolve(bundledDir, "agent", "alias-private.md"));
  }

  // --- Group C: a symlink escaping the recipe directory is refused before any file is read --

  const escapingDir = resolve(tempRoot, "recipes", "escaping");
  await mkdir(resolve(escapingDir, "agent"), { recursive: true });
  await mkdir(resolve(tempRoot, "holding"), { recursive: true });
  await writeFile(resolve(tempRoot, "holding", "outsider.env"), `${MARKER}=outside-the-recipe\n`);
  await writeFile(
    resolve(escapingDir, "agent", "config.json"),
    JSON.stringify({ agentId: "escape-agent", mcpServerName: "escape-mcp" }),
  );
  await writeFile(resolve(escapingDir, "agent", "AGENTS.md"), "# public instructions\n");
  const escapeLinked = await trySymlink(resolve(tempRoot, "holding", "outsider.env"), resolve(escapingDir, "agent", "escape.md"));
  if (!escapeLinked) {
    skip("the walker refuses a symlink escaping the recipe directory (symlinks unavailable on this machine)");
    skip("the checksum map refuses the same escaping symlink (symlinks unavailable on this machine)");
    skip("direct provisioning refuses the same escaping symlink before reading anything (symlinks unavailable on this machine)");
  } else {
    const walkRefusal = await rejectionOf(() => withOutputSink(() => {}, () => collectPortableAgentBundleFiles(escapingDir)));
    check("the walker refuses a symlink escaping the recipe directory", /outside the recipe directory/.test(walkRefusal ?? ""), true);
    check("the refusal carries none of the bytes on the other side of the link", walkRefusal?.includes(MARKER) ?? true, false);

    const checksumRefusal = await rejectionOf(() => withOutputSink(() => {}, () => agentBundleChecksums(escapingDir)));
    check("the checksum map refuses the same escaping symlink", /outside the recipe directory/.test(checksumRefusal ?? ""), true);

    const provisionRefusal = await rejectionOf(() => withOutputSink(() => {}, () => loadRecipeAgentBundle("escaping")));
    check("direct provisioning refuses the same escaping symlink before reading anything", /outside the recipe directory/.test(provisionRefusal ?? ""), true);
    check("its refusal carries none of the bytes on the other side of the link either", provisionRefusal?.includes(MARKER) ?? true, false);
  }

  // --- Group C2: the WALK ROOT itself is the escape — agent/ a symlink out of the recipe --
  //
  // Group C's escape rides inside an otherwise-real agent/, so a child Dirent reported
  // "symlink" and the walker refused. When agent/ ITSELF is the link, every entry arrives
  // as an ordinary child: the escape is the root, and no Dirent ever reports it (P1-05).
  // The walker must vet the root before the first readdir, and every carrier must stop.

  const rootLinkDir = resolve(tempRoot, "recipes", "rootlink");
  const outsideAgent = resolve(tempRoot, "holding", "agent-tree");
  await mkdir(outsideAgent, { recursive: true });
  await mkdir(rootLinkDir, { recursive: true });
  await writeFile(
    resolve(outsideAgent, "config.json"),
    JSON.stringify({ agentId: "outside-agent", mcpServerName: "outside-mcp", marker: MARKER }),
  );
  await writeFile(resolve(outsideAgent, "AGENTS.md"), `${MARKER}=outside-prompt\n`);
  const rootLinked = await trySymlink(outsideAgent, resolve(rootLinkDir, "agent"), "dir");
  if (!rootLinked) {
    skip("the walker refuses an agent/ that is itself a symlink out of the recipe (symlinks unavailable on this machine)");
    skip("the checksum map refuses the same root-level symlink instead of reading an empty bundle (symlinks unavailable on this machine)");
    skip("direct provisioning refuses the same root-level symlink before reading anything (symlinks unavailable on this machine)");
    skip("no reader carries any bytes from the tree a root-level link points at (symlinks unavailable on this machine)");
  } else {
    const rootWalkRefusal = await rejectionOf(() => withOutputSink(() => {}, () => collectPortableAgentBundleFiles(rootLinkDir)));
    check("the walker refuses an agent/ that is itself a symlink out of the recipe", /walk root .*agent resolves outside the recipe directory/.test(rootWalkRefusal ?? ""), true);
    check("the root-level refusal stops at the same boundary a child symlink is refused at", /outside the recipe directory/.test(rootWalkRefusal ?? ""), true);

    const rootChecksumRefusal = await rejectionOf(() => withOutputSink(() => {}, () => agentBundleChecksums(rootLinkDir)));
    check("the checksum map refuses the same root-level symlink instead of reading an empty bundle", /outside the recipe directory/.test(rootChecksumRefusal ?? ""), true);

    const rootProvisionRefusal = await rejectionOf(() => withOutputSink(() => {}, () => loadRecipeAgentBundle("rootlink")));
    check("direct provisioning refuses the same root-level symlink before reading anything", /outside the recipe directory/.test(rootProvisionRefusal ?? ""), true);
    check(
      "no reader carries any bytes from the tree a root-level link points at",
      [rootWalkRefusal, rootChecksumRefusal, rootProvisionRefusal].some((value) => value?.includes(MARKER)),
      false,
    );
    await rm(resolve(rootLinkDir, "agent"));
  }

  // --- Group C3: a root that exists but does not resolve is untrusted, not absent ---------
  //
  // "No agent bundle" is answered only by the root's own absence. An agent/ that IS a link
  // but resolves nowhere used to ENOENT straight into that answer: the checksum map quietly
  // returned {} and provisioning misreported a missing config.json (P1-05). Every carrier
  // now refuses loudly instead.

  const danglingDir = resolve(tempRoot, "recipes", "danglingroot");
  await mkdir(danglingDir, { recursive: true });
  const danglingLinked = await trySymlink(resolve(tempRoot, "holding", "nowhere"), resolve(danglingDir, "agent"), "dir");
  if (!danglingLinked) {
    skip("the walker refuses an agent/ link that does not resolve instead of calling the bundle absent (symlinks unavailable on this machine)");
    skip("the checksum map refuses a dangling agent/ link instead of returning an empty map (symlinks unavailable on this machine)");
    skip("direct provisioning refuses a dangling agent/ link the same way (symlinks unavailable on this machine)");
  } else {
    const danglingWalkRefusal = await rejectionOf(() => withOutputSink(() => {}, () => collectPortableAgentBundleFiles(danglingDir)));
    check("the walker refuses an agent/ link that does not resolve instead of calling the bundle absent", /does not resolve/.test(danglingWalkRefusal ?? ""), true);
    const danglingChecksumRefusal = await rejectionOf(() => withOutputSink(() => {}, () => agentBundleChecksums(danglingDir)));
    check("the checksum map refuses a dangling agent/ link instead of returning an empty map", /does not resolve/.test(danglingChecksumRefusal ?? ""), true);
    const danglingProvisionRefusal = await rejectionOf(() => withOutputSink(() => {}, () => loadRecipeAgentBundle("danglingroot")));
    check("direct provisioning refuses a dangling agent/ link the same way", /does not resolve/.test(danglingProvisionRefusal ?? ""), true);
    await rm(resolve(danglingDir, "agent"));
  }

  // --- Group C4: an ENOENT from INSIDE the walk is not an absent bundle either ------------
  //
  // A dangling CHILD link used to ENOENT through the bundle wrapper's catch-all and read as
  // "no bundle at all" — an empty checksum map, a provisioning refusal aimed at config.json
  // that missed the actual breakage (P1-05). The wrapper probes the root and nets nothing
  // around the walk, so the walk's own failures now stop the caller under their own name.

  const brokenChildDir = resolve(tempRoot, "recipes", "brokenchild");
  await mkdir(resolve(brokenChildDir, "agent"), { recursive: true });
  await writeFile(
    resolve(brokenChildDir, "agent", "config.json"),
    JSON.stringify({ agentId: "broken-child-agent", mcpServerName: "broken-child-mcp" }),
  );
  await writeFile(resolve(brokenChildDir, "agent", "AGENTS.md"), "# public instructions\n");
  const brokenChildLinked = await trySymlink(resolve(tempRoot, "holding", "nowhere-too"), resolve(brokenChildDir, "agent", "broken.md"));
  if (!brokenChildLinked) {
    skip("the walker refuses a dangling prompt link instead of calling the bundle absent (symlinks unavailable on this machine)");
    skip("the checksum map refuses the same dangling prompt link instead of returning an empty map (symlinks unavailable on this machine)");
    skip("direct provisioning refuses the same dangling prompt link (symlinks unavailable on this machine)");
  } else {
    const brokenWalkRefusal = await rejectionOf(() => withOutputSink(() => {}, () => collectPortableAgentBundleFiles(brokenChildDir)));
    check("the walker refuses a dangling prompt link instead of calling the bundle absent", /broken\.md is a symlink that does not resolve/.test(brokenWalkRefusal ?? ""), true);
    const brokenChecksumRefusal = await rejectionOf(() => withOutputSink(() => {}, () => agentBundleChecksums(brokenChildDir)));
    check("the checksum map refuses the same dangling prompt link instead of returning an empty map", /does not resolve/.test(brokenChecksumRefusal ?? ""), true);
    const brokenProvisionRefusal = await rejectionOf(() => withOutputSink(() => {}, () => loadRecipeAgentBundle("brokenchild")));
    check("direct provisioning refuses the same dangling prompt link", /does not resolve/.test(brokenProvisionRefusal ?? ""), true);
    await rm(resolve(brokenChildDir, "agent", "broken.md"));
  }

  // --- Group C5: the common case — a plain real agent/ directory — must be untouched ------

  const plainDir = resolve(tempRoot, "recipes", "plainroot");
  await mkdir(resolve(plainDir, "agent"), { recursive: true });
  await writeFile(
    resolve(plainDir, "agent", "config.json"),
    JSON.stringify({ agentId: "plain-agent", mcpServerName: "plain-mcp" }),
  );
  await writeFile(resolve(plainDir, "agent", "AGENTS.md"), "# ordinary instructions\n");
  const plainWalked = await withOutputSink(() => {}, () => collectPortableAgentBundleFiles(plainDir));
  check("a plain real agent/ directory still walks normally", plainWalked?.files.sort(), ["AGENTS.md", "config.json"]);
  const plainBundle = await withOutputSink(() => {}, () => loadRecipeAgentBundle("plainroot"));
  check(
    "the plain bundle provisions with exactly its own files",
    [plainBundle.config.agentId, Object.keys(plainBundle.promptFiles)],
    ["plain-agent", ["AGENTS.md"]],
  );

  // --- Group D: a recipe cannot declare its own cron-message.txt private and still get a
  //     cron job — refused outright, not silently read anyway and not silently dropped -------

  const cronSecretDir = resolve(tempRoot, "recipes", "cronsecret");
  await mkdir(resolve(cronSecretDir, "agent"), { recursive: true });
  await writeFile(
    resolve(cronSecretDir, "recipe.json"),
    JSON.stringify({ description: "declares its own cron message private", privateFiles: ["agent/cron-message.txt"] }),
  );
  await writeFile(
    resolve(cronSecretDir, "agent", "config.json"),
    JSON.stringify({ agentId: "cron-agent", mcpServerName: "cron-mcp", cronJobName: "cron-job" }),
  );
  await writeFile(resolve(cronSecretDir, "agent", "cron-message.txt"), `${MARKER}=declared-private-cron-message\n`);

  // The checksum map (an informational drift map, not a mutating action) tolerates the
  // exclusion exactly as it tolerates any other held-back file — only the ACTOR that would
  // otherwise silently drop or silently read the cron job must refuse.
  const cronSecretChecksums = await withOutputSink(() => {}, () => agentBundleChecksums(cronSecretDir));
  check("the checksum map simply omits a declared-private cron message, no error", "cron-message.txt" in cronSecretChecksums, false);

  const cronSecretRefusal = await rejectionOf(() => withOutputSink(() => {}, () => loadRecipeAgentBundle("cronsecret")));
  check(
    "direct provisioning refuses a recipe whose own cron message is declared private",
    cronSecretRefusal !== undefined && /cron-message\.txt is excluded by the portable-content policy/.test(cronSecretRefusal) && cronSecretRefusal.includes("declared privateFiles"),
    true,
  );
  check("the refusal carries none of the cron message's bytes", cronSecretRefusal?.includes(MARKER) ?? true, false);

  // --- Group E: a recipe cannot declare its own config.json private and still be provisioned

  const configSecretDir = resolve(tempRoot, "recipes", "configsecret");
  await mkdir(resolve(configSecretDir, "agent"), { recursive: true });
  await writeFile(
    resolve(configSecretDir, "recipe.json"),
    JSON.stringify({ description: "declares its own config private", privateFiles: ["agent/config.json"] }),
  );
  await writeFile(
    resolve(configSecretDir, "agent", "config.json"),
    JSON.stringify({ agentId: "config-agent", mcpServerName: "config-mcp", marker: MARKER }),
  );
  await writeFile(resolve(configSecretDir, "agent", "AGENTS.md"), "# public instructions\n");

  const configSecretChecksums = await withOutputSink(() => {}, () => agentBundleChecksums(configSecretDir));
  check(
    "the checksum map omits a declared-private config.json but still carries the ordinary prompt",
    configSecretChecksums,
    { "AGENTS.md": createHash("sha256").update("# public instructions\n").digest("hex") },
  );

  const configSecretRefusal = await rejectionOf(() => withOutputSink(() => {}, () => loadRecipeAgentBundle("configsecret")));
  check(
    "direct provisioning refuses a recipe whose own config.json is declared private — it cannot be provisioned at all",
    configSecretRefusal !== undefined && /config\.json is excluded by the portable-content policy/.test(configSecretRefusal),
    true,
  );
  check("the refusal never read the config bytes it is refusing to use", configSecretRefusal?.includes(MARKER) ?? true, false);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
  // The active deployment is process-wide and the checks share one process: leave it where
  // it was found, or at the directory the other check files expect.
  if (previousDeployment === undefined) useDeployment(resolve(monorepoRoot, "apps", "example app"));
  else useDeployment(previousDeployment);
}

process.stderr.write(failed === 0 ? "all agent-bundle portable-content checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
