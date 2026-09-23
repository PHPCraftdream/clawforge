// P1-03 (audit 2026-09-22): the privateFiles declaration is a policy over EVERY carrier of
// recipe content, not just `recipe import` — one declaration, four verbs, all reading the
// same walker in security/recipe-portable-content.ts. These checks prove it against real
// temp file trees:
//
//   - set build must EXCLUDE declared privates and sensitive-named files from the manifest
//     (the value scan alone must not be the only barrier — an undeclared-but-.env-named
//     file is held back by the name policy), while ordinary content of BOTH a declaring
//     and a non-declaring recipe ships untouched (no de facto "recipes can't ship files"
//     regression);
//   - the provision-agent workspace mirror must exclude the same set, warn loudly about
//     what it held back, and CONVERGE — a leak sitting in an older mirror is removed by the
//     next sync, not merely stopped from growing;
//   - deploy must REFUSE while a declared private file currently exists in the recipes
//     tree, before any remote mutation — and must NOT refuse once it is absent, the normal
//     state after `recipe import` (declared-but-absent is inert);
//   - and round 3's P1-03 (2026-09-22): that refusal reads the same shared walker as the
//     other three carriers, so an UNDECLARED but sensitive-named file gets one verdict per
//     name from deploy too, over recipes/ and the synced config/ alike;
//   - and the symlink containment rule: a link verified to stay inside the recipe tree is
//     followed (its bytes travel under the link's own name), one resolving outside is
//     refused by both carriers;
//   - and round 3's P1-01 (2026-09-22): staying INSIDE was never the whole rule for a link.
//     An internal alias whose own name is public but whose target is the recipe's own
//     declared private file or directory used to read through the alias as if the
//     declaration had never existed — by checksums, by the set manifest, by the mirror.
//     Now the target's own privacy holds the content back, and under a directory link the
//     declarations follow the canonical path rather than the alias name.
//
// Windows/privilege caveat: creating symlinks can fail without developer mode or elevated
// privileges. The symlink probe degrades exactly the way the WSL probe does in
// security/credentials/recipe-private-snapshot/snapshot.check.ts: the four symlink
// assertions print `skip` and never fail, and the rest of the file still runs.

import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSet } from "#framework/commands/sets/set.ts";
import { deploy } from "#framework/commands/management/deploy.ts";
import { recipeMirrorTargetDir, syncRecipeFiles } from "#framework/commands/management/provision-agent/index.ts";
import { collectPortableRecipeFiles, declaredPortablePrivateFiles, excludesPortablePath } from "#framework/security/recipe-portable-content.ts";
import { agentBundleChecksums, checksumOf, recipeFileChecksums } from "#framework/service/checksums.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { deploymentDir, useDeployment } from "#framework/runtime/deployment.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { LocalTransport } from "#framework/runtime/transport.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

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
 *  (or privileges) refuses, and the symlink group must skip, not fail, there. A directory
 *  link needs its own type on Windows, where a plain `symlink` call defaults to a file. */
async function trySymlink(target: string, path: string, type: "file" | "dir" | "junction" = "file"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
}

function refuse(what: string): () => never {
  return () => {
    throw new Error(`the set build used the ${what} — a set must build with no instance and no reachable target`);
  };
}

/** A stub context whose transport and runtime THROW on any use: a set must build with no
 *  target, and a stub that politely answers would let that rule erode silently. */
function buildOnlyCtx(image: string): Context {
  return {
    settings: { image },
    transport: new Proxy({}, { get: (_target, property) => refuse(`transport.${String(property)}`) }),
    runtime: new Proxy({}, { get: (_target, property) => refuse(`runtime.${String(property)}`) }),
  } as unknown as Context;
}

/** A deploy context like deploy.check.ts's: the transport records every command and always
 *  succeeds, so the assertions can see exactly what would have left this machine. */
function recordingDeployCtx(calls: { command: string; args: string[] }[]): Context {
  return {
    settings: { gatewayPort: "18789" },
    transport: {
      description: "stub",
      async exec(command: string, args: string[]): Promise<ExecResult> {
        calls.push({ command, args });
        // deploy() probes the remote root before its first --delete (round 6, P1-06) —
        // this stub answers it as an already-empty, unmarked, canonical root, so deploy
        // proceeds exactly as it did before that probe existed. Not this file's scope
        // (root adoption has its own dedicated coverage); this only keeps the P1-03
        // private-declaration scenario below reachable.
        // deploy() probes the remote root before its first --delete (round 6, P1-06) —
        // this stub answers it as an already-empty, unmarked, canonical root, so deploy
        // proceeds exactly as it did before that probe existed. Not this file's scope
        // (root adoption has its own dedicated coverage); this only keeps the P1-03
        // private-declaration scenario below reachable.
        if (command === "ssh" && args.includes("sh") && args.includes("-c")) {
          const script = args.at(-1) ?? "";
          // deploy() never receives --path in this file's scenarios, so the remote root is
          // always its fixed default.
          if (script.includes("# clawforge-root-probe")) {
            return { code: 0, stdout: "canonical=/opt/openclaw\nmarker=absent\nempty=yes\n", stderr: "" };
          }
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    paths: {
      async toTarget(path: string): Promise<string> {
        return path;
      },
    },
    runtime: { requiredTools: [] },
  } as unknown as Context;
}

const MARKER = "FIXTURE-CREDENTIAL-p1-03";
// A digest-pinned image needs no lock file: requiredImage pins a @sha256 reference as given.
const IMAGE = `fixture@sha256:${"a".repeat(64)}`;
const BINARY_ASSET = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]);
const EXCLUDED = ["proxy-credentials.env", "vault[1].env", "nested/keys/store.env", ".env"];

// The vaulty recipe declares its privates — including the LITERAL bracket name — and the
// undeclared .env sibling that only the sensitive-NAME policy may catch.
async function writeVaultyRecipe(recipes: string): Promise<string> {
  const vaulty = resolve(recipes, "vaulty");
  await mkdir(resolve(vaulty, "data"), { recursive: true });
  await mkdir(resolve(vaulty, "nested", "keys"), { recursive: true });
  await writeFile(
    resolve(vaulty, "recipe.json"),
    JSON.stringify({ description: "declares privates", privateFiles: ["proxy-credentials.env", "vault[1].env", "nested/keys"] }),
  );
  await writeFile(resolve(vaulty, "server.ts"), "// served\n");
  await writeFile(resolve(vaulty, "compose.yml"), "services: {}\n");
  await writeFile(resolve(vaulty, "data", "page.md"), "# page\n");
  for (const name of EXCLUDED.slice(0, 3)) {
    await writeFile(resolve(vaulty, ...name.split("/")), `${MARKER}=held-back-by-the-declaration\n`);
  }
  // NOT declared: excluded only by the sensitive-name shape policy. If the value scan were
  // the only barrier, these bytes would sail into every carrier.
  await writeFile(resolve(vaulty, ".env"), `UNDECLARED_ENV_SECRET=${MARKER}\n`);
  return vaulty;
}

// The plain recipe declares nothing: the fix must not become a regression that stops a
// recipe with no private declarations from shipping its ordinary content.
async function writePlainRecipe(recipes: string): Promise<string> {
  const plain = resolve(recipes, "plain");
  await mkdir(resolve(plain, "assets"), { recursive: true });
  await writeFile(resolve(plain, "recipe.json"), JSON.stringify({ description: "no declarations" }));
  await writeFile(resolve(plain, "server.ts"), "// plain served\n");
  await writeFile(resolve(plain, "assets", "logo.bin"), BINARY_ASSET);
  return plain;
}

const tempRoot = await mkdtemp(join(tmpdir(), "clawforge-p1-03-"));
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
  const vaulty = await writeVaultyRecipe(resolve(tempRoot, "recipes"));
  const plain = await writePlainRecipe(resolve(tempRoot, "recipes"));
  const dataDir = resolve(tempRoot, "mirror-data");
  const mirrorCtx = { settings: { dataDir }, transport: new LocalTransport() } as unknown as Context;

  useDeployment(tempRoot);
  const ctx = buildOnlyCtx(IMAGE);

  // --- Group A: the matcher itself (pure, no fs) ---------------------------------------------

  check("a literal bracket declaration matches its own file name", excludesPortablePath("vault[1].env", ["vault[1].env"]), true);
  check("a declaration is never a glob — the undeclared sibling vault1 stays portable", excludesPortablePath("vault1.env", ["vault[1].env"]), false);
  check("a directory declaration covers everything under it", excludesPortablePath("nested/keys/store.env", ["nested/keys"]), true);
  check("a directory declaration does not catch a prefix-by-accident sibling", excludesPortablePath("nested/keys2/store.env", ["nested/keys"]), false);

  check("a manifest without privateFiles declares nothing", await declaredPortablePrivateFiles(plain), []);
  const bare = resolve(tempRoot, "group-a", "bare");
  await mkdir(bare, { recursive: true });
  check("a directory with no recipe.json honestly declares nothing", await declaredPortablePrivateFiles(bare), []);

  const broken = resolve(tempRoot, "group-a", "broken");
  await mkdir(broken, { recursive: true });
  await writeFile(resolve(broken, "recipe.json"), "{ broken");
  check("a manifest that cannot be parsed stops the policy readers", /could not parse/.test((await rejectionOf(() => declaredPortablePrivateFiles(broken))) ?? ""), true);

  const escaping = resolve(tempRoot, "group-a", "escaping");
  await mkdir(escaping, { recursive: true });
  await writeFile(resolve(escaping, "recipe.json"), JSON.stringify({ description: "escapes", privateFiles: ["../outside"] }));
  check(
    "a declaration reaching outside the recipe directory is refused",
    /must stay inside the recipe directory/.test((await rejectionOf(() => declaredPortablePrivateFiles(escaping))) ?? ""),
    true,
  );

  // --- Group B: set build excludes and reports, ordinary content through ---------------------

  const chunks: string[] = [];
  const built = await withOutputSink((chunk) => chunks.push(chunk), () => buildSet(ctx, "p1-03"));
  const carried = built.manifest.files;
  const ordinary = [
    "recipes/vaulty/server.ts",
    "recipes/vaulty/compose.yml",
    "recipes/vaulty/data/page.md",
    "recipes/plain/server.ts",
    "recipes/plain/assets/logo.bin",
  ];
  check("ordinary content of both recipes ships", ordinary.every((rel) => rel in carried), true);
  check("no declared private and no sensitive-named file is carried", EXCLUDED.some((rel) => `recipes/vaulty/${rel}` in carried), false);
  check("the private bytes never entered the manifest", JSON.stringify(built.manifest).includes(MARKER), false);
  check("the vaulty recipe entry lacks every held-back name", EXCLUDED.some((rel) => rel in (built.manifest.recipes.vaulty?.files ?? {})), false);
  check(
    "the plain recipe entry carries both of its ordinary files",
    ["server.ts", "assets/logo.bin"].every((rel) => rel in (built.manifest.recipes.plain?.files ?? {})),
    true,
  );
  check("the walker warned loudly about what it held back", chunks.join("").includes("proxy-credentials.env"), true);
  check("the warning carries no value either", chunks.join("").includes(MARKER), false);

  // --- Group C: the provision-agent mirror excludes, converges, preserves bytes --------------

  await withOutputSink(() => {}, () => syncRecipeFiles(mirrorCtx, "vaulty", vaulty));
  const mirror = recipeMirrorTargetDir(dataDir, "vaulty");
  let mirrored = (await mirrorCtx.transport.listFiles(mirror)).sort();
  check("the mirror carries the recipe's ordinary content", ["data/page.md", "server.ts"].every((rel) => mirrored.includes(rel)), true);
  check("the mirror holds back the same four names", EXCLUDED.some((rel) => mirrored.includes(rel)), false);

  // Convergence: a leak from an older, pre-policy sync must be REMOVED by the next sync,
  // not merely stopped from being re-added.
  await writeFile(resolve(mirror, "proxy-credentials.env"), `${MARKER}=left-by-an-older-sync\n`);
  await withOutputSink(() => {}, () => syncRecipeFiles(mirrorCtx, "vaulty", vaulty));
  mirrored = (await mirrorCtx.transport.listFiles(mirror)).sort();
  check("a re-sync removes a leak an older mirror left behind", mirrored.includes("proxy-credentials.env"), false);

  await withOutputSink(() => {}, () => syncRecipeFiles(mirrorCtx, "plain", plain));
  const plainMirror = recipeMirrorTargetDir(dataDir, "plain");
  const mirroredBytes = await readFile(resolve(plainMirror, "assets", "logo.bin"));
  check("the plain recipe's binary asset mirrors byte-identical", checksumOf(mirroredBytes), checksumOf(BINARY_ASSET));

  // --- Group C2: agentBundleChecksums walks from agent/ but the policy stays recipe-relative -

  // agentBundleChecksums roots its walk at <recipe>/agent, yet privateFiles declarations are
  // written recipe-relative: if the walker ever matched the WALK-relative path instead, a
  // declaration like agent/foo.secret would go quiet and the secret would ship in the bundle
  // map with every existing check still green. This fixture stands alone — agentBundleChecksums
  // takes an explicit directory, so no set build and no useDeployment are involved.
  const bundleRoot = await mkdtemp(join(tmpdir(), "clawforge-p1-03-bundle-"));
  try {
    const bundleRecipe = resolve(bundleRoot, "bundle");
    await mkdir(resolve(bundleRecipe, "agent"), { recursive: true });
    await writeFile(
      resolve(bundleRecipe, "recipe.json"),
      JSON.stringify({ description: "agent bundle with a declared secret", privateFiles: ["agent/foo.secret"] }),
    );
    await writeFile(resolve(bundleRecipe, "agent", "foo.secret"), `${MARKER}=declared-inside-agent\n`);
    await writeFile(resolve(bundleRecipe, "agent", "AGENTS.md"), "# ordinary agent instructions\n");

    const bundle = await withOutputSink(() => {}, () => agentBundleChecksums(bundleRecipe));
    check("a privateFiles entry rooted inside agent/ is held out of the agent-bundle checksum map", "foo.secret" in bundle, false);
    check("an ordinary agent/ sibling still ships in the agent-bundle checksum map", "AGENTS.md" in bundle, true);
    check("the held-back agent secret's bytes never enter the agent bundle map", JSON.stringify(bundle).includes(MARKER), false);

    // The seam itself, pinned directly: the walker's FILES are walk-relative, but the policy
    // is applied to — and the exclusion is REPORTED at — the recipe-relative path.
    const walked = await withOutputSink(() => {}, () => collectPortableRecipeFiles(bundleRecipe, { walkRoot: resolve(bundleRecipe, "agent") }));
    check("the walker returns walk-relative files with recipe-relative policy applied", walked.files, ["AGENTS.md"]);
    check(
      "the walker reports the held-back path recipe-relative with its reason",
      walked.excluded.map((entry) => [entry.path, entry.reason]),
      [["agent/foo.secret", "declared privateFiles"]],
    );
  } finally {
    await rm(bundleRoot, { recursive: true, force: true });
  }

  // --- Group D: deploy refuses while the declared file exists, inert once it is absent -------

  const deployRoot = await mkdtemp(join(tmpdir(), "clawforge-p1-03-deploy-"));
  try {
    await mkdir(resolve(deployRoot, "recipes", "guarded"), { recursive: true });
    await writeFile(
      resolve(deployRoot, "recipes", "guarded", "recipe.json"),
      JSON.stringify({ description: "declares one", privateFiles: ["proxy-credentials.env"] }),
    );
    await writeFile(resolve(deployRoot, "recipes", "guarded", "proxy-credentials.env"), `${MARKER}=present-on-this-machine\n`);
    useDeployment(deployRoot);
    const refusingCalls: { command: string; args: string[] }[] = [];
    const refusingCtx = recordingDeployCtx(refusingCalls);
    const refusal = await rejectionOf(() => withOutputSink(() => {}, () => deploy(refusingCtx, ["deployer@server", "--no-bootstrap"])));
    check(
      "deploy refuses while the declared private file is present",
      refusal !== undefined && refusal.includes("recipes/guarded") && refusal.includes("proxy-credentials.env"),
      true,
    );
    check("the refusal happens before any remote mutation — no ssh, no rsync", refusingCalls, []);

    // Declared-but-absent is the normal state after `recipe import`: the declaration
    // travels, the bytes do not exist, and deploying must not over-refuse.
    await rm(resolve(deployRoot, "recipes", "guarded", "proxy-credentials.env"));
    const inertCalls: { command: string; args: string[] }[] = [];
    await withOutputSink(() => {}, () => deploy(recordingDeployCtx(inertCalls), ["deployer@server", "--no-bootstrap"]));
    const recipesSync = inertCalls.find(
      (call) => call.command === "rsync" && call.args.some((arg) => arg.startsWith(resolve(deployRoot, "recipes"))),
    );
    check("with the declared file absent deploy completes and the recipes rsync still happens", recipesSync !== undefined, true);

    // Round 3, P1-03 — one verdict per name: deploy's answer is the policy's answer. The
    // scan used to read only privateFiles, so an UNDECLARED but sensitive-named file
    // (.env.local, service.secrets.env, api.token, nested/.env.production) deployed while
    // import, set build and the mirror held the same bytes back — they all walk this same
    // inventory (Groups B and C pin that), so the table below is the whole regression: the
    // walker says sensitive, deploy refuses; the walker carries the file, deploy sails.
    const parityRecipe = resolve(deployRoot, "recipes", "parity");
    await mkdir(resolve(parityRecipe, "nested"), { recursive: true });
    await writeFile(resolve(parityRecipe, "recipe.json"), JSON.stringify({ description: "declares nothing" }));
    await writeFile(resolve(parityRecipe, "server.ts"), "// parity served\n");
    for (const [name, sensitive] of [
      [".env", true],
      [".env.local", true],
      ["service.secrets.env", true],
      ["api.token", true],
      ["nested/.env.production", true],
      ["notes.txt", false],
    ] as const) {
      await writeFile(resolve(parityRecipe, ...name.split("/")), `${MARKER}=parity-${name}\n`);
      const parityWalked = await withOutputSink(() => {}, () => collectPortableRecipeFiles(parityRecipe));
      const held = parityWalked.excluded.length > 0;
      check(`the walker holds ${name} back exactly when the name policy does`, held, sensitive);
      const parityCalls: { command: string; args: string[] }[] = [];
      const parityRefusal = await rejectionOf(() =>
        withOutputSink(() => {}, () => deploy(recordingDeployCtx(parityCalls), ["deployer@server", "--no-bootstrap"])),
      );
      check(`deploy agrees with the walker about ${name}`, parityRefusal !== undefined, held);
      if (sensitive) {
        check(`deploy's refusal names ${name}`, parityRefusal?.includes(`recipes/parity/${name}`), true);
        check(`deploy's refusal states the reason for ${name}`, parityRefusal?.includes("sensitive-name policy"), true);
        check(`deploy's refusal never carries ${name}'s bytes`, parityRefusal?.includes(MARKER), false);
        check(`refusing ${name} happens before any remote mutation`, parityCalls, []);
      }
      await rm(resolve(parityRecipe, ...name.split("/")));
    }

    // The declared input goes through the same single inventory: privateFiles names the
    // file, the walker reports it as declared, and deploy refuses on that one path too.
    await writeFile(
      resolve(parityRecipe, "recipe.json"),
      JSON.stringify({ description: "declares one", privateFiles: ["declared.env"] }),
    );
    await writeFile(resolve(parityRecipe, "declared.env"), `${MARKER}=declared-and-present\n`);
    const declaredWalked = await withOutputSink(() => {}, () => collectPortableRecipeFiles(parityRecipe));
    check(
      "the walker reports the declared file under its declared reason",
      declaredWalked.excluded.map((entry) => [entry.path, entry.reason]),
      [["declared.env", "declared privateFiles"]],
    );
    const declaredCalls: { command: string; args: string[] }[] = [];
    const declaredRefusal = await rejectionOf(() =>
      withOutputSink(() => {}, () => deploy(recordingDeployCtx(declaredCalls), ["deployer@server", "--no-bootstrap"])),
    );
    check("deploy refuses for a declared file present in the tree", declaredRefusal?.includes("recipes/parity/declared.env"), true);
    check("the declared refusal happens before any remote mutation", declaredCalls, []);
  } finally {
    await rm(deployRoot, { recursive: true, force: true });
    useDeployment(tempRoot);
  }

  // --- Group E: symlink containment (set build + mirror; skippable) --------------------------

  const linksWork = await trySymlink(join(tempRoot, "probe-target"), join(tempRoot, "probe-link"));
  await rm(join(tempRoot, "probe-target"), { force: true });
  await rm(join(tempRoot, "probe-link"), { force: true });
  if (!linksWork) {
    skip("set build follows an inside-pointing symlink (symlinks unavailable on this machine)");
    skip("the mirror follows an inside-pointing symlink too (symlinks unavailable on this machine)");
    skip("set build refuses a symlink escaping the recipe directory (symlinks unavailable on this machine)");
    skip("the mirror refuses a symlink escaping the recipe directory (symlinks unavailable on this machine)");
  } else {
    // Inside-pointing link: followed once verified to stay in the recipe, under its own name.
    const linked = await trySymlink(resolve(vaulty, "data", "page.md"), resolve(vaulty, "linked-page.md"));
    if (!linked) {
      skip("set build follows an inside-pointing symlink (link creation failed)");
      skip("the mirror follows an inside-pointing symlink too (link creation failed)");
    } else {
      const linkedBuilt = await withOutputSink(() => {}, () => buildSet(ctx, "p1-03"));
      check(
        "set build follows an inside-pointing symlink, checksumming the bytes it resolves to",
        linkedBuilt.manifest.files["recipes/vaulty/linked-page.md"],
        checksumOf("# page\n"),
      );
      await withOutputSink(() => {}, () => syncRecipeFiles(mirrorCtx, "vaulty", vaulty));
      mirrored = (await mirrorCtx.transport.listFiles(mirror)).sort();
      const mirroredPage = await readFile(resolve(mirror, "linked-page.md"));
      check(
        "the mirror follows an inside-pointing symlink too, byte-identical",
        mirrored.includes("linked-page.md") && checksumOf(mirroredPage) === checksumOf("# page\n"),
        true,
      );
    }

    // Escaping link, on its OWN copy of the recipe so earlier groups are not disturbed.
    const escapeRoot = await mkdtemp(join(tmpdir(), "clawforge-p1-03-escape-"));
    try {
      await mkdir(resolve(escapeRoot, "config"), { recursive: true });
      await writeFile(resolve(escapeRoot, "config", "desired-state.json"), "[]");
      const escapeRecipe = resolve(escapeRoot, "recipes", "vaulty");
      await mkdir(resolve(escapeRoot, "recipes"), { recursive: true });
      await cp(vaulty, escapeRecipe, { recursive: true });
      // The copy may carry the inside-pointing link from above; only the escape is on trial.
      await rm(resolve(escapeRecipe, "linked-page.md"), { force: true });
      await mkdir(resolve(escapeRoot, "holding"), { recursive: true });
      await writeFile(resolve(escapeRoot, "holding", "outsider.env"), `${MARKER}=outside-the-recipe\n`);
      const escaped = await trySymlink(resolve(escapeRoot, "holding", "outsider.env"), resolve(escapeRecipe, "escape-link"));
      if (!escaped) {
        skip("set build refuses a symlink escaping the recipe directory (link creation failed)");
        skip("the mirror refuses a symlink escaping the recipe directory (link creation failed)");
      } else {
        useDeployment(escapeRoot);
        const escapeBuild = await rejectionOf(() => withOutputSink(() => {}, () => buildSet(buildOnlyCtx(IMAGE), "p1-03")));
        check("set build refuses a symlink resolving outside the recipe directory", /outside the recipe directory/.test(escapeBuild ?? ""), true);
        const escapeMirror = await rejectionOf(() => withOutputSink(() => {}, () => syncRecipeFiles(mirrorCtx, "vaulty", escapeRecipe)));
        check("the mirror refuses a symlink resolving outside the recipe directory", /outside the recipe directory/.test(escapeMirror ?? ""), true);
      }
    } finally {
      await rm(escapeRoot, { recursive: true, force: true });
      useDeployment(tempRoot);
    }
  }

  // --- Group F: an internal alias to a private target (round 3, P1-01) -------------------
  //
  // Group E proved a link is followed once it stays inside and refused when it escapes. The
  // gap between those two facts is this case: a link that stays inside and lands on the
  // recipe's OWN declared private file or directory read through the alias as if the
  // declaration had never existed, by every carrier. The fixture is one recipe with a
  // private file, a private directory, a public directory holding a declared-private file,
  // a sensitive-named-but-undeclared .env, and an alias of each kind — plus the loop link,
  // planted LAST and on purpose: while it exists every walk of this fixture refuses, so no
  // other assertion could run against the tree that carries it.
  if (!linksWork) {
    skip("the walker carries public content and holds back every alias to a private target (symlinks unavailable on this machine)");
    skip("under a directory link the declaration follows the canonical path (symlinks unavailable on this machine)");
    skip("an alias to a private or sensitive target is reported under the target's own reason (symlinks unavailable on this machine)");
    skip("no walker result carries the private bytes (symlinks unavailable on this machine)");
    skip("the checksum map holds back every alias to a private target (symlinks unavailable on this machine)");
    skip("the checksum map carries no private bytes (symlinks unavailable on this machine)");
    skip("the set manifest holds back every alias to a private target (symlinks unavailable on this machine)");
    skip("the set artifact carries no private bytes (symlinks unavailable on this machine)");
    skip("the mirror carries the public file and its alias alike (symlinks unavailable on this machine)");
    skip("the mirror holds back every alias to a private or sensitive target (symlinks unavailable on this machine)");
    skip("no mirrored file carries the private bytes (symlinks unavailable on this machine)");
    skip("a symlink pointing at its own ancestor is refused instead of looping (symlinks unavailable on this machine)");
  } else {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "clawforge-p1-01-"));
    try {
      await mkdir(resolve(fixtureRoot, "config"), { recursive: true });
      await writeFile(resolve(fixtureRoot, "config", "desired-state.json"), "[]");
      const leaky = resolve(fixtureRoot, "recipes", "leaky");
      await mkdir(resolve(leaky, "public"), { recursive: true });
      await mkdir(resolve(leaky, "private"), { recursive: true });
      await writeFile(
        resolve(leaky, "recipe.json"),
        JSON.stringify({
          description: "aliases pointing at its own privates",
          privateFiles: ["secret.env", "private", "public/declared.env"],
        }),
      );
      await writeFile(resolve(leaky, "secret.env"), `${MARKER}=declared-private-file\n`);
      await writeFile(resolve(leaky, "private", "inner.env"), `${MARKER}=declared-private-directory\n`);
      await writeFile(resolve(leaky, "public", "ok.md"), "# public and portable\n");
      await writeFile(resolve(leaky, "public", "declared.env"), `${MARKER}=declared-inside-public\n`);
      // NOT declared: held back only by the sensitive-name shape policy, so the alias to it
      // exercises the second target check rather than the first.
      await writeFile(resolve(leaky, ".env"), `${MARKER}=sensitive-name-only\n`);

      const aliasFile = await trySymlink(resolve(leaky, "secret.env"), resolve(leaky, "alias-file.md"));
      const aliasSensitive = await trySymlink(resolve(leaky, ".env"), resolve(leaky, "alias-sensitive.md"));
      const aliasDir = await trySymlink(resolve(leaky, "private"), resolve(leaky, "alias-dir"), "dir");
      const aliasPub = await trySymlink(resolve(leaky, "public"), resolve(leaky, "alias-pub"), "dir");
      if (!aliasFile || !aliasSensitive || !aliasDir || !aliasPub) {
        skip("the walker carries public content and holds back every alias to a private target (alias creation failed)");
        skip("under a directory link the declaration follows the canonical path (alias creation failed)");
        skip("an alias to a private or sensitive target is reported under the target's own reason (alias creation failed)");
        skip("no walker result carries the private bytes (alias creation failed)");
        skip("the checksum map holds back every alias to a private target (alias creation failed)");
        skip("the checksum map carries no private bytes (alias creation failed)");
        skip("the set manifest holds back every alias to a private target (alias creation failed)");
        skip("the set artifact carries no private bytes (alias creation failed)");
        skip("the mirror carries the public file and its alias alike (alias creation failed)");
        skip("the mirror holds back every alias to a private or sensitive target (alias creation failed)");
        skip("no mirrored file carries the private bytes (alias creation failed)");
        skip("a symlink pointing at its own ancestor is refused instead of looping (alias creation failed)");
      } else {
        const walked = await withOutputSink(() => {}, () => collectPortableRecipeFiles(leaky));
        check(
          "the walker carries public content and holds back every alias to a private target",
          walked.files.includes("public/ok.md") &&
            !walked.files.includes("alias-file.md") &&
            !walked.files.includes("alias-sensitive.md") &&
            !walked.files.some((rel) => rel.startsWith("alias-dir/")),
          true,
        );
        check(
          "under a directory link the declaration follows the canonical path, not the alias",
          !walked.files.some((rel) => rel.startsWith("alias-pub/") && rel.endsWith("declared.env")) &&
            walked.files.includes("alias-pub/ok.md"),
          true,
        );
        check(
          "an alias to a private or sensitive target is reported under the target's own reason",
          walked.excluded
            .filter((entry) => entry.path.startsWith("alias-"))
            .map((entry) => [entry.path, entry.reason])
            .sort((left, right) => left[0].localeCompare(right[0])),
          [
            ["alias-dir", "declared privateFiles (symlink target)"],
            ["alias-file.md", "declared privateFiles (symlink target)"],
            ["alias-pub/declared.env", "declared privateFiles (symlink target)"],
            ["alias-sensitive.md", "sensitive-name policy (symlink target)"],
          ],
        );
        check("no walker result carries the private bytes", JSON.stringify(walked).includes(MARKER), false);

        const leakyChecksums = await withOutputSink(() => {}, () => recipeFileChecksums(leaky));
        check(
          "the checksum map holds back every alias to a private or sensitive target",
          ["alias-file.md", "alias-sensitive.md", "alias-dir", "secret.env", ".env"].some((rel) => rel in leakyChecksums),
          false,
        );
        check("the checksum map carries no private bytes", JSON.stringify(leakyChecksums).includes(MARKER), false);

        useDeployment(fixtureRoot);
        const leakyBuilt = await withOutputSink(() => {}, () => buildSet(buildOnlyCtx(IMAGE), "p1-01"));
        check(
          "the set manifest holds back every alias to a private or sensitive target",
          ["alias-file.md", "alias-sensitive.md", "alias-dir", "alias-pub/declared.env"].some(
            (rel) => `recipes/leaky/${rel}` in leakyBuilt.manifest.files,
          ),
          false,
        );
        check("the set artifact carries no private bytes", JSON.stringify(leakyBuilt.manifest).includes(MARKER), false);
        useDeployment(tempRoot);

        await withOutputSink(() => {}, () => syncRecipeFiles(mirrorCtx, "leaky", leaky));
        const leakyMirror = recipeMirrorTargetDir(dataDir, "leaky");
        const leakyMirrored = (await mirrorCtx.transport.listFiles(leakyMirror)).sort();
        check(
          "the mirror carries the public file and its alias alike",
          ["public/ok.md", "alias-pub/ok.md"].every((rel) => leakyMirrored.includes(rel)),
          true,
        );
        check(
          "the mirror holds back every alias to a private or sensitive target",
          ["alias-file.md", "alias-sensitive.md", "alias-dir", "secret.env", "private", ".env", "private/inner.env", "public/declared.env"].some((rel) => leakyMirrored.includes(rel)) ||
            leakyMirrored.some((rel) => rel.startsWith("alias-pub/") && rel.endsWith("declared.env")),
          false,
        );
        const mirroredBytes = await Promise.all(
          leakyMirrored.map((rel) => readFile(resolve(leakyMirror, ...rel.split("/")))),
        );
        check("no mirrored file carries the private bytes", mirroredBytes.some((bytes) => bytes.includes(MARKER)), false);

        // The loop link goes in last, so every assertion above ran against the tree without
        // it — with the link present, this walk refuses instead of recursing forever.
        const loop = await trySymlink(".", resolve(leaky, "loop"), "dir");
        if (!loop) {
          skip("a symlink pointing at its own ancestor is refused instead of looping (link creation failed)");
        } else {
          const loopRefusal = await rejectionOf(() => collectPortableRecipeFiles(leaky));
          check(
            "a symlink pointing at its own ancestor is refused instead of looping",
            /loop/.test(loopRefusal ?? ""),
            true,
          );
        }
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      // Group F swapped in its own deployment for the set build; leave it where it was.
      useDeployment(tempRoot);
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
  // The active deployment is process-wide and the checks share one process: leave it where
  // it was found, or at the directory the other check files expect.
  if (previousDeployment === undefined) useDeployment(resolve(monorepoRoot, "apps", "example app"));
  else useDeployment(previousDeployment);
}

process.stderr.write(failed === 0 ? "all recipe portable-content checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
