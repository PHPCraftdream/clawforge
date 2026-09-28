// Pure command construction for check-linux.ts — every piece here is a plain function over
// strings/arrays, assertable without a Docker daemon (see
// tools/checks/foundation/hygiene/check-linux.check.ts). Nothing here touches fs, spawns a
// process, or reads an OS-specific path separator: the container side is always POSIX and the
// host side never appears in these argv, only in check-linux.ts's own docker cp call.

/** Where the clean snapshot lands inside the container and where checks run from. Never
 *  pre-created via a docker create `-w` flag: `docker cp` to a destination that does not yet
 *  exist creates it AS the copy (source contents become the destination directly), which
 *  sidesteps the trailing-`/.`-versus-trailing-`\.` split between POSIX and Windows Docker
 *  CLIs entirely — see check-linux.ts's own comment on buildCopyArgv's call site. */
export const CONTAINER_WORKDIR = "/repo";

const IMAGE = "node:24";

/** Single-quotes a POSIX shell word, escaping embedded single quotes the standard way
 *  ('\''). Every check filter crosses into the container through `sh -c`, so this is the one
 *  place a filter argument's quoting has to be exactly right. */
export function shellQuoteSingle(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The command run inside node:24: install, the (optionally filtered) check suite, then
 *  typecheck/lint — the same three steps ci.yml's ubuntu "checks" job runs ("Install
 *  development dependencies", "Run checks", "Typecheck and lint"). Build and pack:check are
 *  deliberately not mirrored: they exercise tools/framework/dist packaging, not the
 *  Linux-wording/wsl.exe-absence class of failure this tool exists to catch. */
export function buildInnerScript(filters: readonly string[]): string {
  const checkArgs = filters.length === 0 ? "" : ` -- ${filters.map(shellQuoteSingle).join(" ")}`;
  return `cd ${CONTAINER_WORKDIR} && npm ci && npm run check${checkArgs} && npm run format:check`;
}

/** `--rm` mirrors `docker run --rm`'s auto-cleanup; staging the snapshot with `docker cp`
 *  before start (see check-linux.ts) is why this is `create` rather than a single `run`. */
export function buildCreateArgv(containerName: string, filters: readonly string[]): string[] {
  return ["create", "--rm", "--name", containerName, "-e", "CI=true", IMAGE, "sh", "-c", buildInnerScript(filters)];
}

/** `hostDir`'s CONTENTS become CONTAINER_WORKDIR — true because CONTAINER_WORKDIR does not
 *  already exist in a container created without `-w` (see its own doc comment above), not
 *  because of any trailing-dot path convention. */
export function buildCopyArgv(hostDir: string, containerName: string): string[] {
  return ["cp", hostDir, `${containerName}:${CONTAINER_WORKDIR}`];
}

/** Attached start: streams the container's stdout/stderr live and, like `docker run`, exits
 *  with the container's own exit code. */
export function buildStartArgv(containerName: string): string[] {
  return ["start", "-a", containerName];
}

/** Best-effort cleanup fallback for when `--rm` never got the chance to fire (docker create
 *  or docker cp itself failed, before the container ever started) — see check-linux.ts's
 *  finally block, which ignores this failing when `--rm` already did its job. */
export function buildRemoveArgv(containerName: string): string[] {
  return ["rm", "-f", containerName];
}

/** node_modules and tools/framework/dist are the two host-built trees the container must
 *  build fresh itself, not inherit from whatever happens to be on the dev machine — mirrors
 *  .gitignore's own entries exactly, as a defense-in-depth filter on top of `git ls-files
 *  -co --exclude-standard`, which should already exclude both. */
export function isHostArtifactPath(relPath: string): boolean {
  return relPath.split("/").includes("node_modules") || relPath === "tools/framework/dist" || relPath.startsWith("tools/framework/dist/");
}

/** Cleans up `git ls-files -co --exclude-standard`'s raw stdout: drops blank lines (a
 *  trailing newline splits into one) and any host-artifact path that should never have
 *  reached here in the first place. */
export function filterCleanFileList(rawLines: readonly string[]): string[] {
  return rawLines.map((line) => line.trim()).filter((line) => line !== "" && !isHostArtifactPath(line));
}
