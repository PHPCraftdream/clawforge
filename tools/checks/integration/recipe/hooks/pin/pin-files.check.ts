import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { preparePin, executePin, PinError } from "#framework/commands/management/recipe/run/pin/plan.ts";
import { pinReportLines } from "#framework/commands/management/recipe/run/pin/invocation.ts";
import { resolveRecipePinEffectOf } from "#framework/commands/management/recipe/run/pin/effect.ts";
const root = await mkdtemp(join(tmpdir(), "recipe-pin-check-"));
const digest = "a".repeat(64);
const fetcher = async (input: string | URL | Request) => new Response(`${digest} ${new URL(String(input)).pathname.split("/").at(-1)?.replace(".sha256", "")}\n`, { status: 200 });
const source = "FROM alpine\nARG VERSION=1\nARG SHA256=" + "0".repeat(64) + "\nADD --checksum=sha256:$SHA256 https://github.com/acme/releases/download/v1/tool-${VERSION}.tgz /tool\n";
const mixedSource = source.replace(`ARG SHA256=${"0".repeat(64)}\n`, `ARG SHA256=${"0".repeat(64)}\r\n`);
const makeDir = () => join(root, `r${Math.random().toString(36).slice(2)}`);
const makeRecipe = async (content: string) => { const dir = makeDir(); await mkdir(dir); await writeFile(join(dir, "Dockerfile"), content); return dir; };
const cases = [
  ["LF longer", source, "release-long", source.replace("VERSION=1", "VERSION=release-long").replace("SHA256=" + "0".repeat(64), `SHA256=${digest}`)],
  ["CRLF shorter", source.replaceAll("\n", "\r\n").replace("VERSION=1", "VERSION=verylong"), "2", source.replaceAll("\n", "\r\n").replace("VERSION=1", "VERSION=verylong").replace("VERSION=verylong", "VERSION=2").replace("SHA256=" + "0".repeat(64), `SHA256=${digest}`)],
  ["BOM unicode CRLF", "\uFEFFFROM alpine\r\n# café\r\n" + source.replaceAll("\n", "\r\n").replace("FROM alpine\r\n", "").replace("VERSION=1", "VERSION=longer"), "v2", "\uFEFFFROM alpine\r\n# café\r\n" + source.replaceAll("\n", "\r\n").replace("FROM alpine\r\n", "").replace("VERSION=1", "VERSION=longer").replace("VERSION=longer", "VERSION=v2").replace("SHA256=" + "0".repeat(64), `SHA256=${digest}`)],
  ["mixed line endings", mixedSource, "mixedv", mixedSource.replace("VERSION=1", "VERSION=mixedv").replace("SHA256=" + "0".repeat(64), `SHA256=${digest}`)],
] as const;
try {
  for (const [label, original, version, expected] of cases) {
    const dir = await makeRecipe(original), path = join(dir, "Dockerfile"), before = await readFile(path), plan = await preparePin(dir, version);
    const preview = await executePin(plan, { fetcher });
    check(`${label}: preview leaves file unchanged`, (await readFile(path)).equals(before), true);
    check(`${label}: checksum source returned`, preview.sourceURL.endsWith(".sha256"), true);
    check(`${label}: asset URL named`, preview.assetURL, new URL(String(plan.assetURL)).href);
    await executePin(plan, { fetcher, apply: true });
    check(`${label}: full output exact`, await readFile(path, "utf8"), expected);
  }
  // The ordinary CLI report must carry the checksum provenance: the published checksum URL and the asset it belongs to.
  {
    const dir = await makeRecipe(cases[0]![1]);
    const result = await executePin(await preparePin(dir, "release-long"), { fetcher });
    const urls = pinReportLines("subject", result).details.flatMap((line) => line.split(" ")).filter((token) => token.startsWith("https://"));
    check("the CLI report names the checksum source and its asset", urls, ["https://github.com/acme/releases/download/v1/tool-release-long.tgz.sha256", "https://github.com/acme/releases/download/v1/tool-release-long.tgz"]);
  }
  const plainDir = await makeRecipe("FROM alpine\nRUN echo hi\n");
  try { await preparePin(plainDir, "2"); checkTrue("no pinned artifact reports not-found", false); }
  catch (error) { check("no pinned artifact reports not-found", error instanceof PinError ? error.code : "unknown", "not-found"); }
  const staleDir = makeDir(); await mkdir(staleDir);
  const stalePath = join(staleDir, "Dockerfile");
  await writeFile(stalePath, source);
  const stalePlan = await preparePin(staleDir, "2");
  await writeFile(stalePath, source + "# intervening edit\n");
  try { await executePin(stalePlan, { fetcher, apply: true }); checkTrue("stale input rejected", false); }
  catch (error) { check("stale input rejected", error instanceof PinError ? error.code === "stale" : false, true); }
  const bwDir = makeDir(); await mkdir(bwDir);
  const bwPath = join(bwDir, "Dockerfile");
  await writeFile(bwPath, source);
  const bwPlan = await preparePin(bwDir, "2");
  try {
    await executePin(bwPlan, { fetcher, apply: true, beforeWrite: async () => { await appendFile(bwPath, "# late edit\n"); } });
    checkTrue("stale via beforeWrite rejected", false);
  } catch (error) { check("stale via beforeWrite rejected", error instanceof PinError ? error.code === "stale" : false, true); }
  check("apply effect", (await resolveRecipePinEffectOf({ apply: true }, []))?.effect, "change");
  check("preview effect", (await resolveRecipePinEffectOf({ apply: false }, []))?.effect, "read");
  check("apply confirms MCP change", await resolveRecipePinEffectOf({ apply: true }, ["mcp"]), { effect: "change", confirm: true });
  check("preview stays MCP read", (await resolveRecipePinEffectOf({ apply: false }, ["mcp"]))?.effect, "read");

  const multi = await makeRecipe(`FROM alpine\nARG VERSION=1\nARG SHA256=${"0".repeat(64)}\nADD --checksum=sha256:$SHA256 https://github.com/acme/releases/download/v1/a-${"${VERSION}"}.tgz /a\nFROM alpine\nARG OTHER=1\nARG OTHER_SHA=${"0".repeat(64)}\nADD --checksum=sha256:$OTHER_SHA https://github.com/acme/releases/download/v1/b-${"${OTHER}"}.tgz /b\n`);
  const shared = await makeRecipe(`FROM alpine\nARG VERSION=1\nARG SHA256=${"0".repeat(64)}\nADD --checksum=sha256:$SHA256 https://github.com/acme/releases/download/v1/a-${"${VERSION}"}.tgz /a\nADD --checksum=sha256:$SHA256 https://github.com/acme/releases/download/v1/b-${"${VERSION}"}.tgz /b\n`);
  // One version ARG, two separate checksum ARGs: advancing one URL would silently break the other.
  const sharedVersion = await makeRecipe(`FROM alpine
ARG VERSION=1
ARG SHA_A=${"0".repeat(64)}
ARG SHA_B=${"1".repeat(64)}
ADD --checksum=sha256:$SHA_A https://github.com/acme/releases/download/v1/a-${"${VERSION}"}.tgz /a
ADD --checksum=sha256:$SHA_B https://github.com/acme/releases/download/v1/b-${"${VERSION}"}.tgz /b
`);
  const failure = async (label: string, directory: string, version: string, artifact?: string, expected = "ambiguous") => {
    try { await preparePin(directory, version, artifact); checkTrue(label, false); }
    catch (error) { check(label, error instanceof PinError ? error.code : "unknown", expected); }
  };
  await failure("multiple artifacts without selector is ambiguous", multi, "2");
  check("basename selector chooses exact artifact", (await preparePin(multi, "2", "a-1.tgz")).artifact, "a-2.tgz");
  await failure("shared ARG across artifacts is refused", shared, "2", "a-1.tgz", "shared");
  await failure("a shared version ARG with separate checksums is refused", sharedVersion, "2", "a-1.tgz", "shared");
  await failure("unknown selector reports not found", multi, "2", "missing.tgz", "not-found");
  await failure("no artifact reports not found", multi, "2", "none", "not-found");
  await failure("same version rejected", multi, "1", "a-1.tgz", "already-current");
  for (const [label, invalid] of [["path traversal", "../x"], ["URL-shaped version", "https://evil"], ["whitespace", "2 x"], ["injection", "2;touch"]] as const) await failure(`invalid ${label}`, multi, invalid, "a-2.tgz", "version");
} finally { await rm(root, { recursive: true, force: true }); }
finish("recipe pin files");
