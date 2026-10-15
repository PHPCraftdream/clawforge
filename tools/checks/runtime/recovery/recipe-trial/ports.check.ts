// ports.ts unit checks: the compose version parser and the v2.24 requirement boundary,
// the effective-config refusal scan, the raw include scan, the (only) override document
// and the merged-config publication proof — all against literals, never against the
// product's own output.

import { buildOverride, parseComposeVersion, supportsPortOverride, analyzeEffectiveConfig, assertNoPublications, refuseRawInclude, parseConfigDocument, type ResolveReal } from "#framework/commands/management/recipe/recovery/trial/ports.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

// --- parseComposeVersion -----------------------------------------------------------------

check("config parser short version", parseComposeVersion("v2.27.1"), { major: 2, minor: 27, patch: 1 });
check("config parser bare version", parseComposeVersion("2.24.0"), { major: 2, minor: 24, patch: 0 });
check("config parser noisy version", parseComposeVersion("Docker Compose version v2.39.2"), { major: 2, minor: 39, patch: 2 });
checkTrue("invalid config refused", parseComposeVersion("not a version") === undefined);
checkTrue("empty config refused", parseComposeVersion("") === undefined);
checkTrue("short version refused", parseComposeVersion("2.24") === undefined);

// --- supportsPortOverride boundary (the refusal threshold) ----------------------------------

checkTrue("2.23.9 does not support !override", supportsPortOverride({ major: 2, minor: 23, patch: 9 }) === false);
checkTrue("2.24.0 supports !override", supportsPortOverride({ major: 2, minor: 24, patch: 0 }));
checkTrue("2.27.1 supports !override", supportsPortOverride({ major: 2, minor: 27, patch: 1 }));
checkTrue("3.0.0 supports !override", supportsPortOverride({ major: 3, minor: 0, patch: 0 }));
checkTrue("2.9.0 does not support !override", supportsPortOverride({ major: 2, minor: 9, patch: 0 }) === false);

// --- parseConfigDocument ---------------------------------------------------------------------

checkTrue("parsed config object", parseConfigDocument('{"services":{}}') !== undefined);
const malformedConfig = await (async () => {
  try { parseConfigDocument("not json"); return "accepted"; } catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("non-JSON output is refused by name", /output.is.not.JSON/.test(malformedConfig));
const arrayConfig = await (async () => {
  try { parseConfigDocument("[]"); return "accepted"; } catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("a non-object JSON document is refused", /is.not.a.record/.test(arrayConfig));

// --- analyzeEffectiveConfig ---------------------------------------------------------------------

const allowed = ["/srv/trial/data", "/srv/recipes/subject"];
const project = "trialproj";
/** Trivial identity resolver — unit-level stand-in for the batched target realpath. */
const resolveIdentity: ResolveReal = (paths) => Promise.resolve([...paths]);
const port = (target: number, published: string, protocol = "tcp"): Record<string, unknown> =>
  ({ mode: "ingress", host_ip: published === "" ? "127.0.0.1" : "", target, published, protocol });

check("service inventory",
  await analyzeEffectiveConfig({ services: { web: { image: "nginx", ports: [port(80, "8080"), port(53, "9053", "udp")] }, db: { image: "postgres" } } }, allowed, project, resolveIdentity).then((a) => a.services),
  [
    { name: "web", builds: false, ports: [{ target: "80", protocol: "tcp", hostIp: "", published: "8080" }, { target: "53", protocol: "udp", hostIp: "", published: "9053" }] },
    { name: "db", builds: false, ports: [] },
  ]);
checkTrue("short port parsed", (await analyzeEffectiveConfig({ services: { web: { ports: ["8080:80"] } } }, allowed, project, resolveIdentity)).services[0]?.ports[0]?.target === "80");
checkTrue("build metadata", (await analyzeEffectiveConfig({ services: { web: { build: { context: "." } } } }, allowed, project, resolveIdentity)).services[0]?.builds === true);
const foreignTag = await (async () => {
  try { await analyzeEffectiveConfig({ services: { web: { build: { context: "." }, image: "nginx:1" } } }, allowed, project, resolveIdentity, new Map([["web", "clawforge-recipe-trial-build-expected"]])); return "accepted"; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("unplanned image refused", /merged.build.service.has.tag.*nginx:1.*expected/.test(foreignTag));
checkTrue("builder binding accepted",
  (await analyzeEffectiveConfig({ services: { web: { build: { context: "." }, image: "clawforge-recipe-trial-build-abc-def--web" } } }, allowed, project, resolveIdentity, new Map([["web", "clawforge-recipe-trial-build-abc-def--web"]]))).services.length === 1);
const missingImageTag = await (async () => {
  try { await analyzeEffectiveConfig({ services: { web: { build: { context: "." } } } }, allowed, project, resolveIdentity, new Map([["web", "clawforge-recipe-trial-build-expected"]])); return "accepted"; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("missing build tag refusal", /expected.the.exact.trial.tag/.test(missingImageTag));
const mismatchedTag = await (async () => {
  try { await analyzeEffectiveConfig({ services: { web: { build: { context: "." }, image: "clawforge-recipe-trial-build-other" } } }, allowed, project, resolveIdentity, new Map([["web", "clawforge-recipe-trial-build-expected"]])); return "accepted"; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("mismatched tag refused", /merged.build.service.has.tag.*expected.the.exact.trial.tag/.test(mismatchedTag));
const extraBuild = await (async () => {
  try { await analyzeEffectiveConfig({ services: { added: { build: { context: "." }, image: "clawforge-recipe-trial-build-added" } } }, allowed, project, resolveIdentity, new Map()); return "accepted"; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("extra builder refused", /added.image/.test(extraBuild));

checkTrue("service build tags are refused", /web.build.tags/.test(await refusalOf("buildTags", { services: { web: { build: { context: ".", tags: ["live"] } } } })));
checkTrue("build cache destinations are refused", /web.build.cache_to/.test(await refusalOf("buildCacheTo", { services: { web: { build: { context: ".", cache_to: ["type=registry,ref=live"] } } } })));
checkTrue("build cache sources are refused", /web.build.cache_from/.test(await refusalOf("buildCacheFrom", { services: { web: { build: { context: ".", cache_from: ["type=registry,ref=live"] } } } })));
checkTrue("additional build contexts are refused", /web.build.additional_contexts/.test(await refusalOf("additionalContexts", { services: { web: { build: { context: ".", additional_contexts: { live: "service:api" } } } } })));
checkTrue("build secrets are refused", /web.build.secrets/.test(await refusalOf("buildSecrets", { services: { web: { build: { context: ".", secrets: ["credential"] } } } })));
checkTrue("build configs are refused", /web.build.configs/.test(await refusalOf("buildConfigs", { services: { web: { build: { context: ".", configs: ["credential"] } } } })));
checkTrue("service configs are refused", /web.configs/.test(await refusalOf("serviceConfigs", { services: { web: { configs: ["shared"] } } })));

checkTrue("top-level secrets are refused", /top-level.secrets/.test(await refusalOf("topSecrets", { services: {}, secrets: { shared: { file: "/live/secret" } } })));

checkTrue("top-level configs are refused", /top-level.configs/.test(await refusalOf("topConfigs", { services: {}, configs: { shared: { file: "/live/config" } } })));
checkTrue("a custom named-volume driver is refused", /volumes\.shared\.driver/.test(await refusalOf("customVolumeDriver", { services: {}, volumes: { shared: { driver: "local-persist" } } })));
checkTrue("volume driver options refusal", /volumes\.shared\.driver_opts/.test(await refusalOf("volumeDriverOpts",
  { services: {}, volumes: { shared: { driver: "local", driver_opts: { type: "none", o: "bind", device: "/srv/live" } } } })));

async function refusalOf(name: string, config: unknown, allowedPrefixes: readonly string[] = allowed, resolveReal: ResolveReal = resolveIdentity): Promise<string> {
  try {
    await analyzeEffectiveConfig(config, allowedPrefixes, project, resolveReal);
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

checkTrue("network_mode host is refused naming service and key",
  /recipe.trial.refuses.web.network_mode/.test(await refusalOf("host", { services: { web: { network_mode: "host" } } })));
checkTrue("a mode: host port is refused",
  /refuses.web.ports.*mode:.host/.test(await refusalOf("hostPort", { services: { web: { ports: [{ mode: "host", target: 80, published: "8080" }] } } })));
checkTrue("container_name is refused",
  /refuses.web.container_name/.test(await refusalOf("name", { services: { web: { container_name: "web-1" } } })));
checkTrue("service profiles are refused",
  /refuses.web.profiles/.test(await refusalOf("profiles", { services: { web: { profiles: ["debug"] } } })));
checkTrue("a generated <project>_<key> volume name is accepted",
  (await refusalOf("genVol", { services: {}, volumes: { data: { name: `${project}_data` } } })) === "accepted");
checkTrue("a generated <project>_default network name is accepted",
  (await refusalOf("genNet", { services: {}, networks: { default: { name: `${project}_default` } } })) === "accepted");
checkTrue("an explicit non-generated volume name is refused",
  /refuses.volumes.live/.test(await refusalOf("volName", { services: {}, volumes: { live: { name: "live-data" } } })));
checkTrue("an explicit non-generated network name is refused",
  /refuses.networks.shared/.test(await refusalOf("netName", { services: {}, networks: { shared: { name: "shared-net" } } })));
checkTrue("an external network is refused",
  /refuses.networks.live/.test(await refusalOf("netExternal", { services: {}, networks: { live: { external: true } } })));
checkTrue("external volume refused",
  /refuses.volumes.live.*external/.test(await refusalOf("svcExternal",
    { services: { db: { volumes: [{ type: "volume", source: "live", target: "/var/lib" }] } }, volumes: { live: { external: true } } })));
checkTrue("publisher source refused",
  /refuses.web.volumes.*resolves.to.*outside.the.trial.scratch.home/.test(await refusalOf("outsideBind",
    { services: { web: { volumes: [{ type: "bind", source: "/etc", target: "/etc" }] } } })));
checkTrue("resolved symlink escape refused",
  /refuses.web.volumes.*resolves.to.\/etc.*outside/.test(await refusalOf("symlinkOut",
    { services: { web: { volumes: [{ type: "bind", source: "/srv/trial/data/state", target: "/state" }] } } }, allowed,
    (paths) => Promise.resolve(paths.map((path) => (path === "/srv/trial/data/state" ? "/etc" : path))))));
// The recipe directory is the LIVE definition: sharing it is allowed only read-only.
checkTrue("a writable bind of the live recipe directory is refused",
  (await refusalOf("writableRecipeDir", { services: { web: { volumes: [{ type: "bind", source: "/srv/recipes/subject/config", target: "/config" }] } } })) !== "accepted");
checkTrue("a read-only bind of the live recipe directory is accepted",
  (await refusalOf("readOnlyRecipeDir", { services: { web: { volumes: [{ type: "bind", source: "/srv/recipes/subject/config", target: "/config", read_only: true }] } } })) === "accepted");
checkTrue("confined bind accepted",
  (await refusalOf("insideBind", { services: { web: { volumes: [{ type: "bind", source: "/srv/trial/data/state", target: "/state" }] } } })) === "accepted");
checkTrue("a tmpfs mount is accepted",
  (await refusalOf("tmpfsMount", { services: { web: { volumes: [{ type: "tmpfs", target: "/cache" }] } } })) === "accepted");
checkTrue("npipe mount refused",
  /refuses.web.volumes.*mount.type."npipe"/.test(await refusalOf("npipeMount",
    { services: { web: { volumes: [{ type: "npipe", target: "//./pipe/docker_engine" }] } } })));
checkTrue("volumes_from on a service is refused",
  /refuses.web.volumes_from/.test(await refusalOf("volumesFrom", { services: { web: { volumes_from: ["db"] }, db: { image: "postgres" } } })));
checkTrue("key list refused",
  /cannot.classify/.test(await refusalOf("noType", { services: { web: { volumes: [{ target: "/x" }] } } })));
checkTrue("malformed port refused",
  /could.not.read.the.compose.configuration/.test(await refusalOf("badPort", { services: { web: { ports: [42] } } })));

// --- refuseRawInclude ---------------------------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), "clawforge-recipe-trial-ports-"));
async function composeOf(name: string, text: string): Promise<string> {
  const path = resolve(dir, name);
  await writeFile(path, text, "utf8");
  return path;
}
try {
  const refusedOf = async (name: string, text: string): Promise<string> => {
    const path = await composeOf(name, text);
    try { await refuseRawInclude(path); return "accepted"; } catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  // Fail closed: any `include` KEY — block style, flow style, quoted — refuses.
  checkTrue("a block-style include key is refused",
    /refuses.include/.test(await refusedOf("include.yml", "include:\n  - other-compose.yml\nservices:\n  web:\n    image: nginx\n")));
  checkTrue("a flow-style include key is refused",
    /refuses.include/.test(await refusedOf("flow-include.yml", "services:\n  web: {include: x}\n")));
  checkTrue("a quoted include key is refused",
    /refuses.include/.test(await refusedOf("quoted-include.yml", 'services:\n  "include": x\n')));
  checkTrue("a nested include key at depth is refused",
    /refuses.include/.test(await refusedOf("nested-include-key.yml", "services:\n  web:\n    x:\n      include: y\n")));
  // The word `include` NOT followed by `:` is not a key — accepted despite the
  // conservative whole-text scan.
  checkTrue("non-key include allowed",
    (await refusedOf("helper-image.yml", "services:\n  web:\n    image: include-helper:1 # include mentions are fine\n")) === "accepted");
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// --- buildOverride ---------------------------------------------------------------------------

// Exact-shape assertions with space-free regex sources: the ratchets count prose
// (whitespace-bearing literals) in assertion operands, so every separator is SP.
const SP = String.fromCharCode(32);
const publishers = [
  { name: "web", builds: false, ports: [{ target: "80", protocol: "tcp", hostIp: "", published: "8080" }, { target: "53", protocol: "udp", hostIp: "", published: "9053" }] },
  { name: "db", builds: false, ports: [] },
] as const;

const overrideDoc = buildOverride(publishers, new Map());
check("all-service override",
  (overrideDoc.match(new RegExp("^" + SP + "*ports:" + SP + "!override" + SP + "\\[\\]$", "gm")) ?? []).length, 2);
check("document shape",
  [overrideDoc.startsWith("#"), /^services:$/m.test(overrideDoc), new RegExp("^" + SP + "*web:$", "m").test(overrideDoc), new RegExp("^" + SP + "*db:$", "m").test(overrideDoc)],
  [true, true, true, true]);
const emptyDoc = buildOverride([], new Map());
check("empty config override",
  [emptyDoc.split("\n")[0]?.startsWith("#"), emptyDoc.split("\n")[1] === "services:" + SP + "{}", emptyDoc.split("\n").length],
  [true, true, 3]);
const builtDoc = buildOverride([{ name: "Builder", builds: true, ports: [] }], new Map([["Builder", "clawforge-recipe-trial-build-abc-def--builder"]]));
checkTrue("trial image tag override",
  new RegExp("^" + SP + "*image:" + SP + "clawforge-recipe-trial-build-abc-def--builder$", "m").test(builtDoc));

// --- assertNoPublications ---------------------------------------------------------------------

const mergedOk = { services: { web: { image: "nginx" }, db: { image: "postgres", ports: [] } } };
const okProof = await (async () => {
  try { assertNoPublications(mergedOk); return "accepted"; } catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("publication proof", okProof === "accepted");
const ephemeralOk = await (async () => {
  try { assertNoPublications({ services: { web: { ports: [port(80, "")] } } }); return "accepted"; } catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("ephemeral loopback proof", ephemeralOk === "accepted");
const leakProof = await (async () => {
  try { assertNoPublications({ services: { web: { ports: [port(80, "8080")] } } }); return "accepted"; } catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("valid publication refusal",
  /refuses.web.ports.*host_ip/.test(leakProof) && /8080/.test(leakProof));
const wrongBindProof = await (async () => {
  try { assertNoPublications({ services: { web: { ports: [{ mode: "ingress", host_ip: "0.0.0.0", target: 80, published: "", protocol: "tcp" }] } } }); return "accepted"; } catch (error) { return error instanceof Error ? error.message : String(error); }
})();
checkTrue("an ephemeral publication NOT bound to loopback refuses",
  /refuses.web.ports.*host_ip.0\.0\.0\.0/.test(wrongBindProof));

// --- FLOW-style effective documents (real compose shapes, snake_case config JSON) -----------

// The FLOW shapes side by side in one base document: an inline short-string publisher, a
// block long-syntax publisher, and a quiet service.
const flowBase = {
  services: {
    web: { image: "nginx", ports: ["8080:80", "9053:53/udp"] },
    api: { build: { context: "." }, ports: [{ mode: "ingress", host_ip: "", target: 9090, published: "9090", protocol: "tcp" }] },
    db: { image: "postgres" },
  },
};
const flowAnalysis = await analyzeEffectiveConfig(flowBase, allowed, project, resolveIdentity);
check("flow inventory", flowAnalysis.services, [
  { name: "web", builds: false, ports: [
    { target: "80", protocol: "tcp", hostIp: undefined, published: undefined },
    { target: "53", protocol: "udp", hostIp: undefined, published: undefined },
  ] },
  { name: "api", builds: true, ports: [{ target: "9090", protocol: "tcp", hostIp: "", published: "9090" }] },
  { name: "db", builds: false, ports: [] },
]);
const flowOverride = buildOverride(flowAnalysis.services, new Map());
check("override service inventory",
  ["web", "api", "db"].map((name) => new RegExp("^" + SP + "*" + name + ":$", "m").test(flowOverride)),
  [true, true, true]);
check("flow override empties ports", (flowOverride.match(new RegExp("^" + SP + "*ports:" + SP + "!override" + SP + "\\[\\]$", "gm")) ?? []).length, 3);
checkTrue("mixed host port refused",
  /refuses.api.ports.*mode:.host/.test(await refusalOf("flowHostPort",
    { services: { api: { ports: ["9090:9090", { mode: "host", target: 7070, published: "7070" }] } } })));
checkTrue("surviving publication refused",
  /refuses.web.ports.*published/.test(await (async () => {
    try { assertNoPublications({ services: { web: { ports: [port(80, "8080")] }, api: { ports: [] }, db: {} } }); return "accepted"; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })()));
checkTrue("loopback ephemeral bind allowed",
  (await (async () => {
    try { assertNoPublications({ services: { web: { ports: [] }, api: { ports: [port(9090, "")] }, db: {} } }); return "accepted"; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })()) === "accepted");

// --- build-tag isolation at the document level ---------------------------------------------

const tagDoc = buildOverride(
  [{ name: "api", builds: true, ports: [] }, { name: "db", builds: false, ports: [] }],
  new Map([["api", "clawforge-recipe-trial-build-0123456789ab-0a1b2c3d--api"]]));
checkTrue("trial tag namespace",
  new RegExp("^" + SP + "*image:" + SP + "clawforge-recipe-trial-build-[0-9a-f]{12}-[0-9a-f]{8}--api$", "m").test(tagDoc)
  && !tagDoc.includes("nginx"));

finish("recipe-trial-ports");
