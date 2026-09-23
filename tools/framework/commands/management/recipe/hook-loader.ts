// Resolve hook for app-owned recipe hooks (imported by register() from
// ./recipe.ts's importHookModule): hooks load from their real path under a
// `?g=<graph checksum>` URL so Node's module map — keyed by URL, never invalidated —
// re-executes a hook graph whose files changed on disk (see the hookModules comment in
// recipe.ts). Relative resolution from a versioned referrer drops the query —
// `new URL("./x.ts", "file:///p/a.ts?g=1")` is `file:///p/x.ts` — so without this hook
// every helper past the entry would load once and keep serving its first content
// forever, which is exactly the staleness the graph checksum exists to fix. The hook
// re-stamps the version onto what a relative specifier resolves to, and only that:
// bare and `#` imports are installed package content that does not change mid-session,
// so they resolve untouched against the recipe app's own package scope.
const VERSION_PARAM = "g";

interface ResolveContext {
  readonly parentURL?: string;
}

interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
  format?: string | null;
}

type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

export async function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): Promise<ResolveResult> {
  const parentURL = context.parentURL;
  if (parentURL === undefined || !parentURL.includes(`?${VERSION_PARAM}=`)) return nextResolve(specifier, context);
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return nextResolve(specifier, context);
  const resolved = await nextResolve(specifier, context);
  if (!resolved.url.startsWith("file:")) return resolved;
  const version = new URL(parentURL).searchParams.get(VERSION_PARAM);
  if (version === null) return resolved;
  const versioned = new URL(resolved.url);
  versioned.searchParams.set(VERSION_PARAM, version);
  return { ...resolved, url: versioned.href };
}
