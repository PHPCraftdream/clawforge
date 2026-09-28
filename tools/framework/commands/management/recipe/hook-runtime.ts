// Loading and caching app-owned recipe hook modules (prepare.ts, verify.ts, onboard.ts, …)
// against the checksum of each hook's own local import graph.

import { register } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { dependencyGraphChecksum } from "./hook-graph.ts";

/** App-owned hook modules, cached against the checksum of the hook's whole local import
 *  graph.
 *
 *  `import()` answers from the process-wide module map keyed by URL, so in a long-lived
 *  process — every MCP session — re-importing the same hook file returned the first load
 *  forever: a hook edited on disk kept running its previous code on the next tool call,
 *  while a freshly started CLI process picked the new one up. A relative import graph made
 *  that worse — editing a helper without touching prepare.ts/verify.ts left a session
 *  running the helper's old code —
 *  so the gate that decides whether a reload is due hashes the whole local import graph,
 *  not just the entry file: dependencyGraphChecksum below.
 *
 *  The graph checksum decides *whether* a reload is due; a versioned URL decides *what
 *  gets re-executed*. importHookModule imports the hook's real file URL with that
 *  checksum as a `?g=` query parameter (`file://…/prepare.ts?g=<checksum>`), and the
 *  resolve hook in ./hook-loader.ts re-stamps the same version onto every
 *  specifier the graph reaches through relative resolution. Because the checksum is
 *  computed before the import, the version is known up front — every module in the
 *  graph, cycles included, carries it, so a change anywhere changes every versioned URL
 *  at once and Node re-executes the whole graph, while an unchanged graph answers from
 *  this map without importing at all.
 *
 *  Hooks execute from their real location, so bare imports (`@clawforge/framework/private-config`,
 *  the recipe app's own dependencies) resolve against the recipe's package scope. Local
 *  `#imports` resolve through the recipe's own package.json `imports` map — a string or
 *  node/import/default target that stays inside the recipe directory (hook-graph.ts folds
 *  both the package.json and the resolved target into the checksum); anything the graph
 *  cannot safely track (a bare package target, an absolute path, an escape via `..` or a
 *  symlink, an unsupported condition) is refused before the hook ever executes.
 *  `import.meta.url` points at the real file, and sibling assets sit where relative
 *  reads expect them. Nothing is copied to temp storage, so there is no shared cache
 *  directory to win a race against, no pre-existing file to silently adopt, and no
 *  bytes of framework-controlled temp state at all (the copy machinery this replaces also
 *  deadlocked on genuine A→B→A cycles, which ESM now handles natively). */
const hookModules = new Map<string, { checksum: string; loaded: Record<string, unknown> }>();

/** Query parameter carrying the hook graph's checksum on every versioned hook URL. */
const HOOK_GRAPH_VERSION_PARAM = "g";

/** Query parameter carrying the recipe directory alongside the checksum — hook-loader.ts
 *  reads it back to resolve (and re-validate) a `#specifier` at any depth in the graph
 *  without needing the recipe directory threaded through every resolve() call. */
const HOOK_GRAPH_RECIPE_PARAM = "r";

const HOOK_IMPORT_TIMEOUT_MS_DEFAULT = 30_000;

/** The deadline is a backstop against evaluation that never settles — the loader's own
 *  promise graph cannot deadlock anymore (there is none), but a hook's top-level await
 *  still could, and a hung import means a hung MCP call holding the instance lock. The
 *  environment override exists so a check can exercise the timeout path in seconds
 *  instead of half a minute. */
function hookImportTimeoutMs(): number {
  const override = Number(process.env.CLAWFORGE_HOOK_IMPORT_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : HOOK_IMPORT_TIMEOUT_MS_DEFAULT;
}

let hookResolveHooksRegistered = false;

export async function importHookModule(path: string): Promise<Record<string, unknown>> {
  const checksum = await dependencyGraphChecksum(path);
  const cached = hookModules.get(path);
  if (cached?.checksum === checksum) return cached.loaded;
  if (!hookResolveHooksRegistered) {
    register(new URL("./hook-loader.ts", import.meta.url).href, import.meta.url);
    hookResolveHooksRegistered = true;
  }
  const versioned = new URL(pathToFileURL(path).href);
  versioned.searchParams.set(HOOK_GRAPH_VERSION_PARAM, checksum);
  versioned.searchParams.set(HOOK_GRAPH_RECIPE_PARAM, dirname(path));
  const versionedURL = versioned.href;
  const evaluation = import(versionedURL) as Promise<Record<string, unknown>>;
  // If the deadline ever wins the race the evaluation is still pending in the background;
  // a rejection from it must not surface as an unhandled rejection and crash the process.
  evaluation.catch(() => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `recipe hook ${path}: module evaluation did not settle within ${hookImportTimeoutMs()}ms — ` +
                "the hook's top-level code (a top-level await across its relative imports, typically) never resolves",
            ),
          );
        }, hookImportTimeoutMs());
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
