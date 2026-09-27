// `./clawforge bootstrap` pins OPENCLAW_IMAGE the moment a fresh pull proves what a shared tag
// actually holds — the fresh-deployment half of task #32 (a pull in one deployment silently
// moving a shared tag for its neighbours on the same Docker daemon). `upgrade` already resolves
// by digest and pins on success (upgrade.check.ts, this same directory); this is bootstrap's
// own version of that, on the FIRST pull rather than on an explicit, later upgrade — reusing
// upgrade's own pinImageReference() (lifecycle.ts) for the write.
//
// Lives here rather than under lifecycle/: that directory's checks are already at the 7-entry
// layout cap (see upgrade.check.ts's own header for the identical reasoning), and this
// command's central fact — OPENCLAW_IMAGE — is one of the four connection facts this
// directory otherwise already covers.

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrap } from "#framework/commands/lifecycle/bootstrap.ts";
import { useDeployment, envFile } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";
import type { ExecResult } from "#framework/runtime/transport.ts";

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

const DATA_DIR = "/srv/openclaw/data";
const CONFIG_PATH = `${DATA_DIR}/config/openclaw.json`;
const SHARED_TAG = "ghcr.io/openclaw/openclaw:extended-stable";
const PULLED_DIGEST = `${SHARED_TAG.split(":")[0]}@sha256:pulled0000000000000000000000000000000000000000000000000000000`;
const ALREADY_PINNED = `${SHARED_TAG.split(":")[0]}@sha256:already000000000000000000000000000000000000000000000000000000`;

/** A bootstrap-shaped stub — the same proven shape bootstrap-provider-order.check.ts's own
 *  makeCtx() uses — plus the one extra runtime primitive this pinning asks of a fresh pull:
 *  imageReference(), read straight after pullImage() to learn what the tag now holds locally. */
function makeCtx(options: { image: string; pulledDigest: string | undefined; registryDigest?: string }): { ctx: Context; calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    settings: {
      dataDir: DATA_DIR,
      env: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
      image: options.image,
      bindAddress: "127.0.0.1",
      gatewayPort: "18789",
      serviceUrl: "http://127.0.0.1:18789",
    },
    transport: {
      description: "stub",
      async exists(): Promise<boolean> { return true; },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) return JSON.stringify({ models: { providers: { zai: { apiKey: "k" } } } });
        return "";
      },
      async writeFile(): Promise<void> {},
      async remove(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async exec(command: string, args: string[]): Promise<ExecResult> {
        // Same permissive shape as bootstrap-provider-order.check.ts: not a symlink, no
        // ancestor rewrites, and an already-correctly-owned tree — nothing here is about
        // ensureDataDirs' own provenance gate.
        if (command === "test" && args[0] === "-L") return { code: 1, stdout: "", stderr: "" };
        if (command === "readlink" && args[0] === "-f") return { code: 0, stdout: `${args[1] ?? ""}\n`, stderr: "" };
        if (command === "stat" && args[0] === "-c" && args[1] === "%u:%g") return { code: 0, stdout: "1000:1000\n", stderr: "" };
        if (command === "stat" && args[0] === "-c" && args[1] === "%a") return { code: 0, stdout: "700\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    paths: { toContainer: (path: string) => path },
    runtime: {
      async portConflict(): Promise<string | undefined> { return undefined; },
      async isRunning(): Promise<boolean> { return false; },
      async pullImage(): Promise<void> { calls.push("pull"); },
      async runOneOff(): Promise<ExecResult> { return { code: 0, stdout: "", stderr: "" }; },
      async start(): Promise<void> { calls.push("start"); },
      async waitForHealth(): Promise<void> {},
      async imageReference(): Promise<string | undefined> {
        calls.push("imageReference");
        return options.pulledDigest;
      },
      ...(options.registryDigest === undefined ? {} : {
        async resolveImageDigest(): Promise<string | undefined> {
          calls.push("resolve");
          return options.registryDigest;
        },
      }),
    },
  } as unknown as Context;
  return { ctx, calls };
}

async function withTempDeployment(envBody: string, body: () => Promise<void>): Promise<void> {
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-bootstrap-image-pin-check-"));
  useDeployment(deployment);
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), "[]");
    await writeFile(envFile(), envBody, "utf8");
    await body();
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
}

// --- a fresh pull of a shared tag is pinned to the digest it just proved ---------------------

await withTempDeployment(`OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\nOPENCLAW_GATEWAY_TOKEN=test-token\n`, async () => {
  const { ctx, calls } = makeCtx({ image: SHARED_TAG, pulledDigest: PULLED_DIGEST });
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => bootstrap(ctx, []));
  const envNow = await readFile(envFile(), "utf8");
  check("the pull ran before the digest was read", calls.indexOf("pull") < calls.indexOf("imageReference"), true);
  check(".env is rewritten to the digest the tag just proved", envNow.includes(`OPENCLAW_IMAGE=${PULLED_DIGEST}`), true);
  check("the moving tag itself no longer appears", envNow.includes(`OPENCLAW_IMAGE=${SHARED_TAG}`), false);
  check("bootstrap says so", output.includes(PULLED_DIGEST) && output.includes("pinned"), true);
  check("and names ./clawforge upgrade as how to move it from here", output.includes("./clawforge upgrade"), true);
  // Bootstrap's own final summary also reads imageReference() (to report "running image: …"),
  // unconditionally and unrelated to this pin — so the pin is what pushed the count to two,
  // not merely "asked at all", which the summary alone would already satisfy.
  check("the digest was actually asked for — once to pin, once for the final summary", calls.filter((call) => call === "imageReference").length, 2);
});

// --- --no-pull skips the pin along with the pull — nothing was proven, nothing to pin --------

await withTempDeployment(`OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\nOPENCLAW_GATEWAY_TOKEN=test-token\n`, async () => {
  const { ctx, calls } = makeCtx({ image: SHARED_TAG, pulledDigest: PULLED_DIGEST });
  const envBefore = await readFile(envFile(), "utf8");
  await withOutputSink(() => {}, () => bootstrap(ctx, ["--no-pull"]));
  const envAfter = await readFile(envFile(), "utf8");
  // Only the final summary's own read remains — the pin itself never asks, because there was
  // no pull for it to ask about.
  check("--no-pull asks for the digest only for the final summary, never to pin", calls.filter((call) => call === "imageReference").length, 1);
  check("--no-pull leaves .env byte-identical", envAfter, envBefore);
});

// --- a deployment already pinned to a digest never changes on bootstrap: upgrade moves it ----

await withTempDeployment(`OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${ALREADY_PINNED}\nOPENCLAW_GATEWAY_TOKEN=test-token\n`, async () => {
  const { ctx, calls } = makeCtx({ image: ALREADY_PINNED, pulledDigest: PULLED_DIGEST });
  const envBefore = await readFile(envFile(), "utf8");
  await withOutputSink(() => {}, () => bootstrap(ctx, []));
  const envAfter = await readFile(envFile(), "utf8");
  check("an already-pinned deployment is never asked to re-resolve — only the final summary reads it", calls.filter((call) => call === "imageReference").length, 1);
  check("its .env is untouched — ./clawforge upgrade is how to move it, never a bootstrap re-run", envAfter, envBefore);
});

// --- a digest the runtime cannot resolve locally leaves the tag alone, rather than guessing ---

await withTempDeployment(`OC_DATA_DIR=${DATA_DIR}\nOPENCLAW_IMAGE=${SHARED_TAG}\nOPENCLAW_GATEWAY_TOKEN=test-token\n`, async () => {
  const { ctx } = makeCtx({ image: SHARED_TAG, pulledDigest: undefined });
  const envBefore = await readFile(envFile(), "utf8");
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => bootstrap(ctx, []));
  const envAfter = await readFile(envFile(), "utf8");
  check("an unresolvable pull leaves .env exactly as it was — never guessed", envAfter, envBefore);
  check("bootstrap says the tag stays a moving one", output.includes("stays a moving tag"), true);
});

// --- with a registry answer the digest is pinned BEFORE the pull: the pull is by digest and
// never moves the shared local tag (the incident this task exists for) ---------------------

await withTempDeployment(`OC_DATA_DIR=${DATA_DIR}
OPENCLAW_IMAGE=${SHARED_TAG}
OPENCLAW_GATEWAY_TOKEN=test-token
`, async () => {
  const { ctx, calls } = makeCtx({ image: SHARED_TAG, pulledDigest: PULLED_DIGEST, registryDigest: PULLED_DIGEST });
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => bootstrap(ctx, []));
  check("the digest is resolved at the registry before any pull", calls.indexOf("resolve") < calls.indexOf("pull"), true);
  check("no local tag read is needed to pin", calls.indexOf("imageReference") > calls.indexOf("pull"), true);
  check(".env holds the registry digest", (await readFile(envFile(), "utf8")).includes(`OPENCLAW_IMAGE=${PULLED_DIGEST}`), true);
  check("bootstrap says the pull was by digest", output.includes("pulled by digest"), true);
});

process.stderr.write(failed === 0 ? "all bootstrap image-pin checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
