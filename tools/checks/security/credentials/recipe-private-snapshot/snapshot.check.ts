// P1-01: a recipe's private target files used to travel inside every snapshot profile.
//
// The fixture recipe (fixture-recipe/fixture-sidecar) declares sidecar-private as its
// privatePaths and writes into it through the real helpers, its prepare.ts driven the way
// `recipe install` drives it. createArchive and verifySnapshot then run for real against a
// stub transport that models the target filesystem: tar -czf is simulated by applying the
// built command's own --exclude patterns to the model, so the assertions are about what the
// real exclusion code lets into an archive, and verify's refusals run over real listings.
// `full` is credential-complete by design: the sidecar's credentials must be IN a full
// archive (restoring one restores the sidecar's working state) and in no other profile.

import { verifySnapshot } from "#framework/commands/lifecycle/verify.ts";
import { createArchive } from "#framework/service/archive.ts";
import { installedRecipePrivatePaths, loadRecipe, recipesDirectory, useRecipesDir, clearRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import { fileURLToPath } from "node:url";

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

const fixtureDir = fileURLToPath(new URL("./fixture-recipe", import.meta.url));
const previousRecipes = (() => {
  try { return recipesDirectory(); } catch { return undefined; }
})();

const PARENT = "/srv/fixture";
const DATA_NAME = "data";
const DATA = `${PARENT}/${DATA_NAME}`;
const PRIVATE_PATH = "sidecar-private";
const PRIVATE_FILE = `${PRIVATE_PATH}/credentials.env`;

// --- the stub target ------------------------------------------------------------------------
//
// Models just enough of a POSIX target for createArchive and verifySnapshot: a file tree,
// archives as their simulated listings, and the commands both touch — tar, mv, chmod and
// grep. The tar simulation applies GNU tar's semantics for these patterns: a matched
// directory is not descended into, and `*`/`?` are wildcards.

function fakeTarget(): { ctx: Context; files: Map<string, string>; archives: Map<string, string[]> } {
  const files = new Map<string, string>();
  const archives = new Map<string, string[]>();

  const matches = (part: string, pattern: string): boolean =>
    new RegExp(
      `^${pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll("*", ".*").replaceAll("?", ".")}$`,
    ).test(part);

  const excluded = (entry: string, patterns: string[]): boolean => {
    const parts = entry.replace(/\/+$/, "").split("/");
    return patterns.some((pattern) => {
      const wanted = pattern.split("/");
      const itself = wanted.length <= parts.length
        && wanted.every((part, index) => matches(parts[parts.length - wanted.length + index]!, part));
      if (itself) return true;
      // An excluded directory is not descended into, so nothing under it is listed either.
      return wanted.length < parts.length && wanted.every((part, index) => matches(parts[index]!, part));
    });
  };

  const ctx = {
    settings: { dataDir: DATA, env: {} },
    transport: {
      description: "fixture-target",
      async mkdirp(): Promise<void> {},
      async writePrivateFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
      async readFile(path: string): Promise<string> {
        return files.get(path) ?? "";
      },
      async exists(path: string): Promise<boolean> {
        return files.has(path) || archives.has(path);
      },
      async remove(path: string): Promise<void> {
        files.delete(path);
      },
      async mkdirPrivate(path: string): Promise<void> {
        if (files.has(path) || path.endsWith("/tree") && [...files.keys()].some((key) => key.startsWith(`${path}/`))) {
          throw new Error(`mkdir: ${path}: File exists`);
        }
      },
      async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        if (command === "chmod") return { code: 0, stdout: "", stderr: "" };
        if (command === "mv") {
          const source = args[args.indexOf("--") + 1] ?? args[args.length - 2]!;
          const destination = args[args.length - 1]!;
          const content = files.get(source);
          if (content !== undefined) {
            files.set(destination, content);
            files.delete(source);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-czf")) {
          const archive = args[args.indexOf("-czf") + 1]!;
          const parent = args[args.indexOf("-C") + 1]!;
          const name = args[args.length - 1]!;
          const root = `${parent}/${name}`;
          const excludes = args.filter((arg) => arg.startsWith("--exclude=")).map((arg) => arg.slice("--exclude=".length));
          const entries = new Set<string>();
          for (const path of files.keys()) {
            if (!path.startsWith(`${root}/`)) continue;
            const relative = `${name}/${path.slice(root.length + 1)}`;
            const segments = relative.split("/");
            for (let depth = 1; depth < segments.length; depth += 1) entries.add(`${segments.slice(0, depth).join("/")}/`);
            entries.add(relative);
          }
          archives.set(archive, [...entries].filter((entry) => !excluded(entry, excludes)).sort());
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "tar" && args.includes("-tzf")) {
          const archive = args[args.length - 1]!;
          return { code: 0, stdout: `${(archives.get(archive) ?? []).join("\n")}\n`, stderr: "" };
        }
        if (command === "tar" && args.includes("-tvzf")) {
          const archive = args[args.length - 1]!;
          const verbose = (archives.get(archive) ?? []).map((entry) =>
            entry.endsWith("/")
              ? `drwxr-xr-x user/group 0 2026-01-01 00:00 ${entry}`
              : `-rw-r--r-- user/group ${Buffer.byteLength(files.get(`${PARENT}/${entry}`) ?? "")} 2026-01-01 00:00 ${entry}`,
          );
          return { code: 0, stdout: `${verbose.join("\n")}\n`, stderr: "" };
        }
        if (command === "tar" && args.includes("-xzf")) {
          const archive = args[args.indexOf("-xzf") + 1]!;
          const workdir = args[args.indexOf("-C") + 1]!;
          for (const entry of archives.get(archive) ?? []) {
            if (!entry.endsWith("/")) files.set(`${workdir}/${entry}`, files.get(`${PARENT}/${entry}`) ?? "");
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "grep") {
          const patterns = (files.get(args[args.indexOf("-f") + 1]!) ?? "").split("\n").filter((line) => line !== "");
          const directory = args[args.length - 1]!;
          const hits = [...files.keys()].filter((path) =>
            path.startsWith(`${directory}/`) && patterns.some((pattern) => (files.get(path) ?? "").includes(pattern)),
          );
          return hits.length === 0
            ? { code: 1, stdout: "", stderr: "" }
            : { code: 0, stdout: `${hits.join("\n")}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
  return { ctx, files, archives };
}

try {
  useRecipesDir(fixtureDir);

  // --- the declaration -----------------------------------------------------------------------

  const fixture = await loadRecipe("fixture-sidecar");
  check("loadRecipe carries the declared privatePaths", JSON.stringify(fixture.privatePaths), JSON.stringify(["sidecar-private"]));
  check("installedRecipePrivatePaths collects the declarations", JSON.stringify(await installedRecipePrivatePaths()), JSON.stringify(["sidecar-private"]));

  // --- the fixture's own hook drives the real private-write helpers ---------------------------

  const { ctx, files, archives } = fakeTarget();
  // Ordinary instance content the share profile is allowed to carry.
  files.set(`${DATA}/config/openclaw.json`, JSON.stringify({ models: { providers: {} } }));
  files.set(`${DATA}/workspace/SOUL.md`, "# fixture\n");

  const hooks = (await import(new URL("./fixture-recipe/fixture-sidecar/prepare.ts", import.meta.url).href)) as {
    prepare: (ctx: Context, recipe: typeof fixture) => Promise<void>;
  };
  await hooks.prepare(ctx, fixture);
  check("the fixture's private file is written under the declared path", files.has(`${DATA}/${PRIVATE_FILE}`), true);

  // --- what each profile's archive contains ----------------------------------------------------

  for (const profile of ["full", "migrate", "share"] as const) {
    const archive = `${PARENT}/archives/${profile}.tar.gz`;
    await createArchive(ctx, { archive, profile });
    check(
      `a ${profile} archive ${profile === "full" ? "keeps" : "does not contain"} the recipe's private file`,
      archives.get(archive)?.includes(`data/${PRIVATE_FILE}`),
      profile === "full",
    );
  }

  // --- share stays usable: excluded, so the positive allow-list still passes --------------------

  check(
    "a share archive with the recipe's private path excluded passes verify",
    await withOutputSink(() => {}, () => verifySnapshot(ctx, `${PARENT}/archives/share.tar.gz`, "share")),
    true,
  );
  check(
    "the migrate archive passes verify",
    await withOutputSink(() => {}, () => verifySnapshot(ctx, `${PARENT}/archives/migrate.tar.gz`, "migrate")),
    true,
  );
  check(
    "the full archive passes verify",
    await withOutputSink(() => {}, () => verifySnapshot(ctx, `${PARENT}/archives/full.tar.gz`, "full")),
    true,
  );

  // --- defense in depth: an archive taken before the exclusion existed -------------------------
  //
  // Built directly with no --exclude patterns, the way createArchive built every archive
  // before the fix. verify alone must refuse it: exclusion lists are a promise, the check
  // is the enforcement.

  const preFix = `${PARENT}/archives/pre-fix.tar.gz`;
  await ctx.transport.exec("tar", ["--numeric-owner", "-czf", preFix, "-C", PARENT, DATA_NAME]);
  for (const profile of ["migrate", "share"] as const) {
    const output: string[] = [];
    const passed = await withOutputSink((chunk) => output.push(chunk), () => verifySnapshot(ctx, preFix, profile));
    check(`verify refuses an already-taken ${profile} archive containing the recipe's private path`, passed, false);
    check(`the ${profile} refusal names the offending path`, output.join("").includes(PRIVATE_PATH), true);
  }
  check(
    "a full archive containing the recipe's private path still passes verify",
    await withOutputSink(() => {}, () => verifySnapshot(ctx, preFix, "full")),
    true,
  );
} finally {
  if (previousRecipes === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipes);
}

process.stderr.write(failed === 0 ? "all recipe-private-snapshot checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
