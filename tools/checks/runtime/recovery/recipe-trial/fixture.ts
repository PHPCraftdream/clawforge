// Shared fixture for the `recipe trial` checks: a stub Context whose transport answers the
// trial's docker, du and copy calls with recorded fakes, a recipes directory written into
// the OS temp dir, and a deployment selected the way the neighbouring checks do. No real
// Docker, no real target — every assertion reads recorded argv, written files and captured
// output. Modeled on integration/agent/recipe.check.ts's stubContext and
// runtime/recovery/recipes/fixture.ts's reaction model.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport/transport.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import type { RecipeRef } from "#framework/core/values/plan.ts";

export const DEPLOYMENT_NAME = "example-deployment";
/** Synthetic POSIX data dir — never a real path on this machine. */
export const DATA_DIR = "/srv/clawforge-recipe-trial-check";
/** What the stub PathBridge answers for any definition: a canonical POSIX target path. */
export const TARGET_DEFINITION = "/srv/recipes/trial-target/compose.yml";
export const SECRET_ENV: Record<string, string> = { OC_PASSWORD: "trial-secret-env", ECRET: "fixture-distinct-value" };
export interface RecordedCall {
  readonly command: string;
  readonly args: string[];
}

/** Mints the reader grammar's brand over a checked-out recipe name (checks read names from
 *  literals they wrote themselves — the same mint the command parser performs). */
export function ref(name: string): RecipeRef {
  return name as RecipeRef;
}

export interface TrialFixture {
  ctx: Context;
  /** Every transport.exec call, in order. */
  readonly calls: RecordedCall[];
  readonly output: string[];
  readonly loadedComposeEnvironments: Array<{ readonly operation: string; readonly services: Record<string, Record<string, unknown>> }>;
  readonly absentPathReports: string[];

  /** docker argv (post recipe-docker unwrap): compose build/up/down, logs, images. */
  readonly docker: string[][];
  /** The `sh -c <copy script> recipe-trial-copy ...` argv, whole, one entry per call. */
  readonly copyArgv: string[][];
  readonly files: Map<string, string>;
  readonly privateFiles: Map<string, string>;
  readonly privateWrites: string[];
  readonly mkdirPrivateCalls: string[];
  readonly dirs: Set<string>;
  readonly removed: string[];
  readonly stackCalls: { project: string; definitionPath: string; options: unknown }[];
  /** Documents answered for `compose ... config --format json`: one --file (base) vs two
   *  (merged). null answers the DEFAULT document for the current composeVersion. */
  baseConfigJson: string | null;
  mergedConfigJson: string | null;
  composeVersion: string;
  logs: string;
  failBuild: boolean;
  failEvidenceTransport: boolean;
  failPsSecret: boolean;


  failDown: boolean;
  leftoverImages: string;
  hangServiceStates: boolean;
  serviceStates: Record<string, { running: boolean; health?: string }>;
  duSizes: Map<string, number>;
  /** When true the merged-config request is answered with the ORIGINAL base document —
   *  modeling a compose merge that silently ignored the trial's override (published ports
   *  survive). assertNoPublications must refuse the run.
   *  ROUND 4: when the trial HAS written an override, the merged answer is COMPUTED with
   *  mergeCompose instead; `overrideBreaksProof` models the break inside the merge (the
   *  `!override` tag is stripped from the written override before merging, so the merge
   *  model refuses the un-tagged ports block) and the config call answers like compose
   *  would: exit 1, the merge error on stderr — the product's proof path dies on it. */
  overrideBreaksProof: boolean;
  /** When true the scratch bind source must exist before `realpath` succeeds. */
  failMissingScratchBind: boolean;
  /** Model a symlinked bind mount: `recipe-trial-mount-realpath` answers each requested
   *  path with the mapped value instead of itself (e.g. a copied-data source resolving to
   *  /etc). Unmapped paths resolve to themselves. */
  mountRealpathMap: Map<string, string>;
  /** When true the COMPUTED merged document gains a live bind mount (source /etc/data,
   *  outside every allowed prefix) on every service — modeling a merge whose extra input
   *  introduced a mount the base never had; the merged-document analysis must refuse it.
   *  mergeCompose itself cannot produce this honestly from the generated override, so the
   *  knob swaps the merged services' volume entry after the computed merge. */
  mergedHasBadMount: boolean;
  /** Service → image applied onto the COMPUTED merged document — modeling a compose that
   *  merged the ports override but kept the service's base image, so a build service
   *  survives with a tag outside the trial's build-tag namespace. */
  mergedImageFor: Map<string, string>;
  /** When true every compose build/up/down/config call answers exit 1 "compose file not
   *  found" unless each `--file` path is present in files/privateFiles (the recipe's own
   *  staged definition excepted) — models "down needs its files" so a teardown order that
   *  removes the scratch home before down fails loudly. */
  strictFiles: boolean;
  /** Paths the presence probe must report absent (default: everything exists). */
  absentPaths: string[];
  /** When true the presence probe answers exit 1 with EMPTY stderr — the ambiguous shape
   *  that must fail closed. */
  ambiguousProbe: boolean;
  /** When true the FIRST `image rm --force` answers exit 1 (the removal itself failed). */
  failFirstImageRm: boolean;
  /** Tags whose `image inspect` answers exit 1 with a daemon-unreachable stderr — the
   *  UNKNOWN leftover shape, not the "No such image" absence proof. */
  failInspectTags: string[];
  /** Tag whose `image inspect` NEVER resolves — a hung cleanup step the teardown must
   *  abandon and report instead of blocking the exit. */
  hangInspectTag: string | null;
}

/** The live project name recipeProjectName() would derive, recomputed here from the
 *  documented inputs so the expectation is independent of the product function. */
export function liveProjectFor(name: string): string {
  return `clawforge-recipe-${createHash("sha256").update(JSON.stringify([DEPLOYMENT_NAME, name])).digest("hex")}`;
}

/** The trial hash prefix for a recipe, recomputed the same independent way. */
export function trialHashFor(name: string): string {
  return createHash("sha256").update(JSON.stringify([DEPLOYMENT_NAME, name])).digest("hex").slice(0, 12);
}

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

/** compose-config JSON is snake_case: the same shape side-stack/recovery.ts parses. */
const portEntry = (target: number, published: string, protocol: string): Record<string, unknown> =>
  ({ mode: "ingress", host_ip: published === "" ? "127.0.0.1" : "", target, published, protocol });

const DEFAULT_BASE_CONFIG_JSON = JSON.stringify({
  services: {
    web: { image: "nginx", ports: [portEntry(80, "8080", "tcp"), portEntry(53, "9053", "udp"), portEntry(5432, "5432", "tcp")] },
    db: { image: "postgres" },
  },
});

/** Canned merged answer ONLY for calls made before the trial wrote an override (the
 *  dry-run): every service listed by the generated override with its ports stripped. */
function defaultMergedConfigJson(): string {
  return JSON.stringify({ services: { web: { image: "nginx" }, db: { image: "postgres" } } });
}

export function trialFixture(): TrialFixture {
  const calls: RecordedCall[] = [];
  const output: string[] = [];
  const loadedComposeEnvironments: Array<{ readonly operation: string; readonly services: Record<string, Record<string, unknown>> }> = [];
  const absentPathReports: string[] = [];
  const docker: string[][] = [];
  const copyArgv: string[][] = [];
  const files = new Map<string, string>();
  const privateFiles = new Map<string, string>();
  const privateWrites: string[] = [];
  const mkdirPrivateCalls: string[] = [];
  const dirs = new Set<string>();
  const removed: string[] = [];
  const stackCalls: { project: string; definitionPath: string; options: unknown }[] = [];
  const duSizes = new Map<string, number>();
  const purgedPrivate = new Set<string>();
  const fixture: TrialFixture = {
    calls, output, loadedComposeEnvironments, absentPathReports, docker, copyArgv, files, privateFiles, privateWrites, mkdirPrivateCalls, dirs, removed, stackCalls,
    baseConfigJson: null,
    mergedConfigJson: null,
    composeVersion: "v2.27.1",
    logs: "upstream says password=trial-secret-env is set",
    failBuild: false,
    failEvidenceTransport: false,
    failPsSecret: false,
    failDown: false,
    leftoverImages: "",
    hangServiceStates: false,
    serviceStates: { app: { running: true, health: "healthy" } },
    duSizes,
    overrideBreaksProof: false,
    mountRealpathMap: new Map<string, string>(),
    mergedHasBadMount: false,
    failMissingScratchBind: false,
    mergedImageFor: new Map<string, string>(),
    strictFiles: false,
    absentPaths: [],
    ambiguousProbe: false,
    failFirstImageRm: false,
    failInspectTags: [],
    hangInspectTag: null,
    ctx: {} as Context,
  };

  let imageRmSeen = false;
  const dockerExec = async (argv: string[]): Promise<ExecResult> => {
    docker.push([...argv]);
    if (argv.includes("version")) return { code: 0, stdout: `${fixture.composeVersion}\n`, stderr: "" };
    if (fixture.strictFiles) {
      for (let index = 0; index < argv.length - 1; index += 1) {
        if (argv[index] === "--file") {
          const path = argv[index + 1]!;
          const purged = purgedPrivate.has(path) || [...purgedPrivate].some((entry) => path.startsWith(`${entry}/`));
          if (purged || (path !== TARGET_DEFINITION && !fixture.privateFiles.has(path) && !fixture.files.has(path))) {
            return { code: 1, stdout: "", stderr: `compose file not found: ${path}` };
          }
        }
      }
    }
  const launchArgs = argv[0] === "sh" && argv[2] === "recipe-docker" ? argv.slice(3) : argv;
  if (launchArgs[0] !== "compose") {
      if (launchArgs[0] === "logs") return { code: 0, stdout: fixture.logs, stderr: "" };
      if (launchArgs[0] === "images") return { code: 0, stdout: fixture.leftoverImages, stderr: "" };
      if (launchArgs[0] === "image" && launchArgs[1] === "rm" && launchArgs[2] === "--force") {
        const first = !imageRmSeen;
        imageRmSeen = true;
        if (fixture.failFirstImageRm && first) {
          return { code: 1, stdout: "", stderr: "fixture image rm failure" };
        }
        return ok;
      }
      if (launchArgs[0] === "image" && launchArgs[1] === "inspect") {
        const tag = launchArgs[2] ?? "";
        if (fixture.failInspectTags.includes(tag)) {
          return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
        }
        // Teardown's per-tag absence proof: the daemon's "No such image" shape at exit 1.
        return { code: 1, stdout: "", stderr: `Error response from daemon: No such image: ${tag}` };
      }
      return ok;
    }
    const relevant = argv[0] === "compose" || (argv[0] === "sh" && argv[2] === "recipe-docker");
    if (relevant && launchArgs.includes("config") && launchArgs.includes("--format")) {
      const files = launchArgs.flatMap((entry, index) => entry === "--file" ? [launchArgs[index + 1] ?? ""] : []);
      const overrideText = files.length > 1 ? fixture.privateFiles.get(files[1]!) : undefined;
      const expectedOverride = fixture.files.get(files[1]!) ?? "";
      if (files.length > 1 && overrideText === undefined) {
        const baseDoc = JSON.parse(fixture.baseConfigJson ?? DEFAULT_BASE_CONFIG_JSON) as { services: Record<string, Record<string, unknown>> };
        for (const [name, service] of Object.entries(baseDoc.services)) {
          const start = expectedOverride.indexOf(`  ${name}:`);
          const next = expectedOverride.indexOf(`\n  `, start + `  ${name}:`.length);
          const section = expectedOverride.slice(start, next < 0 ? undefined : next);
          const tag = /^    image: (.+)$/m.exec(section)?.[1];
          if (tag !== undefined) service["image"] = tag;
        }
        return { code: 0, stdout: JSON.stringify(baseDoc), stderr: "" };
      }
      if (overrideText !== undefined) {
        let text = expectedOverride;
        if (fixture.overrideBreaksProof) text = text.replace(/ports: !override \[\]/g, "ports: []");
        try {
          const mergedDoc = await mergeCompose(fixture.baseConfigJson ?? DEFAULT_BASE_CONFIG_JSON, text) as {
            services: Record<string, Record<string, unknown>>;
          };
          if (fixture.mergedHasBadMount) {
            for (const service of Object.values(mergedDoc.services))
              service["volumes"] = [{ type: "bind", source: "/etc/data", target: "/data" }];
          }
          const bindSources = Object.values(mergedDoc.services)
            .flatMap((service) => (service["volumes"] ?? []) as Record<string, unknown>[])
            .map((mount) => String(mount["source"] ?? "")).filter((source) => source.includes("/data/"));
          for (const source of bindSources) {
            if (!dirs.has(source)) return { code: 1, stdout: "", stderr: `bind source does not exist: ${source}` };
          }
          const mergedServices = mergedDoc.services;
          for (const [name, service] of Object.entries(mergedServices)) {
            if (service["build"] === undefined) continue;
            const marker = `  ${name}:`;
            const start = text.indexOf(marker);
            const next = text.indexOf(`\n  `, start + marker.length);
            const section = text.slice(start, next < 0 ? undefined : next);
            const tag = /^    image: (.+)$/m.exec(section)?.[1];
            if (tag !== undefined) service["image"] = tag;
          }
          for (const [name, image] of fixture.mergedImageFor) {
            if (mergedServices[name] !== undefined) mergedServices[name]!["image"] = image;
          }
          return { code: 0, stdout: JSON.stringify(mergedDoc), stderr: "" };
        } catch (error) {
          return { code: 1, stdout: "", stderr: `compose merge failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      const merged = files.length > 1;
      return { code: 0, stdout: (merged ? fixture.mergedConfigJson : fixture.baseConfigJson)
        ?? (merged ? defaultMergedConfigJson() : DEFAULT_BASE_CONFIG_JSON), stderr: "" };
    }
    if (argv.includes("logs")) return { code: 0, stdout: fixture.logs, stderr: "" };
    if (argv.includes("down")) {
      return fixture.failDown ? { code: 1, stdout: "", stderr: "fixture compose down failure" } : ok;
    }
    if (launchArgs.includes("build") || launchArgs.includes("up")) {
      const pinnedPath = launchArgs.flatMap((value, index) => value === "--file" ? [launchArgs[index + 1] ?? ""] : []).at(-1) ?? "";
      const pinned = fixture.privateFiles.get(pinnedPath);
      if (pinned !== undefined) {
        const parsed = JSON.parse(pinned) as { services: Record<string, Record<string, unknown>> };
        const envPath = launchArgs.flatMap((value, index) => value === "--env-file" ? [launchArgs[index + 1] ?? ""] : []).at(-1) ?? "";
        const envText = fixture.privateFiles.get(envPath) ?? fixture.files.get(envPath) ?? "";
        const env: Record<string, string> = {};
        for (const line of envText.split("\n")) {
          const idx = line.indexOf("=");
          if (idx >= 0) {
            let value = line.slice(idx + 1);
            try { value = JSON.parse(value) as string; } catch { /* Compose env fixture: unquoted literal */ }
            env[line.slice(0, idx)] = value;
          }
        }
        const interpolateOnce = (value: string): string => value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
          (token, braced: string | undefined, plain: string | undefined) => token === "$$" ? "$" : env[braced ?? plain ?? ""] ?? "");
        for (const service of Object.values(parsed.services)) {
          const environment = service["environment"];
          if (environment !== null && typeof environment === "object" && !Array.isArray(environment)) {
            for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
              if (typeof value === "string") (environment as Record<string, unknown>)[key] = interpolateOnce(value);
            }
          }
        }
        fixture.loadedComposeEnvironments.push({ operation: launchArgs.includes("build") ? "build" : "up", services: parsed.services });
      }
    }
    if (argv.includes("build")) return fixture.failBuild ? { code: 1, stdout: "", stderr: "fixture build failure" } : ok;
    return ok; // up, and anything else the trial asks compose for
  };

  const context: Context = {
    settings: { env: SECRET_ENV, dataDir: DATA_DIR },
    paths: {
      async toTarget(): Promise<string> {
        return TARGET_DEFINITION;
      },
    },
    transport: {
      description: "trial-stub",
      cancellation: "confirmed-local",
      async exec(command: string, args: string[], options?: { input?: string | Uint8Array; signal?: AbortSignal; timeoutMs?: number }): Promise<ExecResult> {
        calls.push({ command, args: [...args] });
        if (fixture.failEvidenceTransport && command === "docker" && args.some((arg) => arg === "--all"))
          throw new Error("fixture evidence transport secret=trial-secret-env");
        if (fixture.failPsSecret && command === "docker" && args.some((arg) => arg === "--all"))
          return { code: 0, stdout: `NAME\tIMAGE\tSTATUS\nfixture-ps-user\tapp\tsecret=fixture-ps-secret\n`, stderr: "" };
        if (options?.signal?.aborted) return { code: 143, stdout: "", stderr: "aborted" };
        if (command === "docker" && args[0] === "compose") return dockerExec(args);
        if (command === "sh" && args[0] === "-c") {
          if (args[2] === "recipe-docker") return dockerExec(args.slice(3));
          if (args[2] === "recipe-trial-size") {
            const paths = args.slice(3);
            return { code: 0, stdout: paths.map((p) => `${duSizes.get(p) ?? 1024}\t${p}`).join("\n"), stderr: "" };
          }
          if (args[2] === "recipe-trial-realpath") {
            // Each entry resolves to itself — no symlinked ancestors in the fixture.
            return { code: 0, stdout: `${args.slice(3).join("\n")}\n`, stderr: "" };
          }
          if (args[2] === "recipe-trial-mount-realpath") {
            const paths = args.slice(3);
            const scratchHome = paths.find((path) => path.includes(".clawforge-recipe-trial-"))?.split("/data")[0] ?? "";
            if (fixture.failMissingScratchBind && paths.some((path) => path.startsWith(`${scratchHome}/data/`))
              && ![...dirs].some((path) => path.startsWith(`${scratchHome}/data/`)))
              return { code: 1, stdout: "", stderr: "No such file or directory" };
            return { code: 0, stdout: `${paths.map((path) => fixture.mountRealpathMap.get(path) ?? path).join("\n")}\n`, stderr: "" };
          }
          if (args[2] === "recipe-trial-copy") {
            copyArgv.push([...args]);
            const home = args[3] ?? "";
            dirs.add(`${home}/data`);
            for (const entry of args.slice(5)) dirs.add(`${home}/data/${entry}`);
            return ok;
          }
        }
        if (command === "mkdir" && args[0] === "-m") {
          const target = args[args.length - 1]!;
          dirs.add(target);
          mkdirPrivateCalls.push(target);
          return ok;
        }
        if (command === "sh" && args[0] === "-c" && args[1]?.includes("ln -T")) {
          const commandText = args[1];
          const target = commandText.slice(commandText.indexOf("ln -T -- \"$temporary\" ") + "ln -T -- \"$temporary\" ".length).split("'")[1] ?? "";
          privateWrites.push(target);
          privateFiles.set(target, typeof options?.input === "string" ? options.input : Buffer.from(options?.input ?? []).toString("utf8"));
          files.set(target, typeof options?.input === "string" ? options.input : Buffer.from(options?.input ?? []).toString("utf8"));
          return ok;
        }
        if (command === "sh" && args[0] === "-s") {
          if (fixture.ambiguousProbe) return { code: 1, stdout: "", stderr: "" };
          if (options?.input && String(options.input).includes("while :; do")) {
            const probePath = args[2] ?? "";
            const absent = fixture.absentPaths.includes(probePath) && !fixture.duSizes.has(probePath);
            return { code: 0, stdout: absent ? "absent\n" : "exists\n", stderr: "" };
          }
          const path = args.find((entry, index) => index >= 2 && entry.startsWith("/")) ?? "";
          const absent = fixture.absentPaths.includes(path) && !fixture.duSizes.has(path);
          return { code: 0, stdout: absent ? `absent${String.fromCharCode(10)}` : `exists${String.fromCharCode(10)}`, stderr: "" };
        }
        if (command === "docker") {
          if (fixture.hangInspectTag !== null && args[0] === "image" && args[1] === "inspect" && args[2] === fixture.hangInspectTag) {
            docker.push([...args]);
            return new Promise<ExecResult>(() => {});
          }
          return dockerExec([...args]);
        }
        // Instance-lock primitives, modeled on the neighbouring checks' stubs.
        if (command === "mkdir" && args[0] !== "-p" && args[0] !== "-m") {
          const target = args[args.length - 1]!;
          if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
          dirs.add(target);
          return ok;
        }
        if (command === "mkdir") {
          dirs.add(args[args.length - 1]!);
          return ok;
        }
        if (command === "rmdir") {
          const target = args[args.length - 1]!;
          const busy = [...files.keys()].some((e) => e.startsWith(`${target}/`))
            || [...dirs].some((e) => e.startsWith(`${target}/`));
          if (busy) return { code: 1, stdout: "", stderr: "Directory not empty" };
          dirs.delete(target);
          return ok;
        }
        if (command === "test" && args[0] === "-d") return { code: dirs.has(args[1]!) ? 0 : 1, stdout: "", stderr: "" };
        if (command === "mv") {
          const [source, dest] = args as [string, string];
          if (!dirs.has(source)) return { code: 1, stdout: "", stderr: "No such file or directory" };
          for (const d of [...dirs].filter((e) => e === source || e.startsWith(`${source}/`))) { dirs.delete(d); dirs.add(dest + d.slice(source.length)); }
          for (const [k, v] of [...files].filter(([k]) => k === source || k.startsWith(`${source}/`))) { files.delete(k); files.set(dest + k.slice(source.length), v); }
          return ok;
        }
        if (command === "rm" && args[0] === "-rf") {
          const target = args[args.length - 1]!;
          removed.push(target);
          dirs.delete(target);
          const children = [...dirs].filter((key) => key.startsWith(`${target}/`));
          for (const key of children) dirs.delete(key);
          for (const key of privateFiles.keys()) if (key.startsWith(`${target}/`)) {
            purgedPrivate.add(key);
          }
          return ok;
        }
        if (command === "rm") {
          const target = args[args.length - 1]!;
          for (const d of [...dirs].filter((e) => e === target || e.startsWith(`${target}/`))) dirs.delete(d);
          for (const k of [...files.keys()].filter((e) => e === target || e.startsWith(`${target}/`))) files.delete(k);
          return ok;
        }
        return ok;
      },
      async readFile(path: string): Promise<string> {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        files.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
      },
      async remove(path: string): Promise<void> {
        removed.push(path);
        files.delete(path);
        dirs.delete(path);
        for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key);
        for (const key of dirs) if (key.startsWith(`${path}/`)) dirs.delete(key);
        // The removed path takes its private files with it: recorded, so strictFiles
        // compose calls answer "compose file not found" for them — and post-run reads of
        // privateFiles still see what was written.
        for (const key of privateFiles.keys()) if (key.startsWith(`${path}/`)) purgedPrivate.add(key);
      },
      async listFiles(path: string): Promise<string[]> {
        const prefix = `${path}/`;
        return [...files.keys()].filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
      },
      async mkdirPrivate(path: string): Promise<void> {
        mkdirPrivateCalls.push(path);
        dirs.add(path);
      },
      async writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
        privateWrites.push(path);
        privateFiles.set(path, typeof content === "string" ? content : Buffer.from(content).toString("utf8"));
      },
    },
    runtime: {
      stack(project: string, definitionPath: string, options: unknown) {
        stackCalls.push({ project, definitionPath, options });
        return {
          async serviceStates() {
            if (fixture.hangServiceStates) return new Promise<Record<string, never>>(() => {});
            return fixture.serviceStates;
          },
        };
      },
    },
  } as unknown as Context;
  return Object.assign(fixture, { ctx: context });
}

/** Selects the deployment and recipes root the way every neighbouring check does, writes
 *  recipes into a temp scratch dir, and hands back a cleanup handle. */
export interface RecipesRoot {
  readonly root: string;
  write(name: string, json: Record<string, unknown>, composeYml?: string | null): Promise<void>;
  dispose(): Promise<void>;
}

export async function useRecipesRoot(prefix: string): Promise<RecipesRoot> {
  const root = resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(root, { recursive: true });
  useRecipesDir(root);
  useDeployment(resolve(root, DEPLOYMENT_NAME));
  return {
    root,
    async write(name, json, composeYml = "services: {}\n"): Promise<void> {
      await mkdir(resolve(root, name), { recursive: true });
      await writeFile(resolve(root, name, "recipe.json"), JSON.stringify(json), "utf8");
      // `null` omits compose.yml entirely — the fixture-side way to model a recipe whose
      // compose file is absent, with no write-then-remove round trip at the call site.
      if (composeYml !== null) await writeFile(resolve(root, name, "compose.yml"), composeYml, "utf8");
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** Collects everything the run prints (emit/log/info/warn all land in the sink). */
export async function captured<T>(body: () => Promise<T>): Promise<{ chunks: string[]; result: T }> {
  const { withOutputSink } = await import("#framework/core/io/output.ts");
  const chunks: string[] = [];
  const result = await withOutputSink((chunk) => chunks.push(chunk), body);
  return { chunks, result };
}

/** The thrown message of `body`, or "" (recording a failed check) when it did not throw. */
export async function messageOf(name: string, body: () => Promise<unknown>): Promise<string> {
  const { check } = await import("#checks/kit/harness.ts");
  try {
    await body();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  check(name, "did not throw", "threw");
  return "";
}

// A TIGHT parser-plus-merger for exactly the override shape buildOverride generates (this
// IS the product's own output grammar, so the fixture models compose's documented merge on
// it — it is not a general YAML parser and refuses anything else):
//   - `#` comment lines are skipped;
//   - `services:` opens the map; `  <name>:` opens a service; `  <name>: {}` adds an empty one;
//   - per service: `    image: <tag>` REPLACES the base image, and `    ports: !override []`
//     REPLACES the base ports with none. ROUND 4: the remap branch is gone — the product
//     emits ONLY `!override []`, so ANY other ports entry (a plain `ports:` block or list,
//     tagged differently or not at all) is a line the model refuses as a grammar error;
//     compose's default-append semantics for non-ports keys are not modeled — the only
//     non-ports key the product ever writes is `image:`.
// Services in the override that the base lacks are added; any line outside this grammar
// throws — a merge the fixture cannot model is one it must not pretend to model.
export async function mergeCompose(baseJson: string | unknown, overrideYaml: string): Promise<Record<string, unknown>> {
  const base = (typeof baseJson === "string" ? JSON.parse(baseJson) : baseJson) as Record<string, unknown>;
  const services = { ...((base["services"] ?? {}) as Record<string, unknown>) };
  let current: string | undefined;
  const serviceBuilds = new Map<string, boolean>();
  for (const raw of overrideYaml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    if (/^services:$/.test(line.trim()) || /^services: \{\}$/.test(line.trim())) { current = undefined; continue; }
    const serviceMatch = /^ {2}([^:\s]+):(?: {})?$/.exec(line);
    if (serviceMatch !== null) {
      current = serviceMatch[1]!;
      if (services[current] === undefined) services[current] = { image: "fixture-added" };
      serviceBuilds.set(current, (services[current] as Record<string, unknown>)["build"] !== undefined);
      continue;
    }
    if (current === undefined) return Promise.reject(new Error("mergeCompose cannot understand the override line"));
    const service = { ...(services[current] as Record<string, unknown>) };
    const imageMatch = /^ {4}image: (.+)$/.exec(line);
    if (imageMatch !== null) {
      service["image"] = imageMatch[1];
      if (serviceBuilds.get(current) === true) service["build"] = (services[current] as Record<string, unknown>)["build"];
      else delete service["build"];
      services[current] = service;
      continue;
    }
    if (/^ {4}ports: !override \[\]$/.test(line)) { delete service["ports"]; services[current] = service; continue; }
    // Anything else under a service — including an un-tagged or remap-shaped ports entry —
    // is outside the generated grammar: the model refuses rather than half-understanding it.
    throw new Error(`mergeCompose cannot understand the override line: ${raw.trim()}`);
  }
  return { ...base, services };
}

export const MULTIPORT_COMPOSE = `services:
  web:
    image: nginx
    ports:
      - "8080:80"
      - "9053:53/udp"
      - {target: 5432, published: 5432, protocol: tcp}
  db:
    image: postgres
`;
