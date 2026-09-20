// `./clawforge recover-env`, against a real temp deployment: stale connection facts are
// merged back into .env in place, the gateway token sharing the file passes through
// byte-identical and is never printed, `--dry-run` and a full match write nothing, and
// facts Docker's answer does not carry are named, never guessed. The refusals are pinned
// too: a runtime that cannot introspect, a container that is not running, and a wholly
// absent .env — which recovery cannot create, because reaching the target already
// requires it (bootstrap does).

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverEnv } from "#framework/commands/recover-env/index.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { useDeployment, deploymentDir, envFile } from "#framework/runtime/deployment.ts";
import type { Context } from "#framework/core/context.ts";

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

interface Facts {
  dataDir?: string;
  port?: string;
  composeProject?: string;
  image?: string;
}

const TOKEN = "not-a-real-token-check-only-value";
const SEED = [
  "OC_DATA_DIR=/old/data",
  "OPENCLAW_GATEWAY_PORT=9999",
  "OC_COMPOSE_PROJECT=old-project",
  "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:old-tag",
  `OPENCLAW_GATEWAY_TOKEN=${TOKEN}`,
  "KEEP_ME=keep",
  "",
].join("\n");

const previous = (() => { try { return deploymentDir(); } catch { return undefined; } })();
const deployDir = await mkdtemp(join(tmpdir(), "clawforge-recover-env-check-"));
useDeployment(deployDir);

// Every case's captured output lands here too, so the secret sharing the file can be proven
// absent from ALL of it at once.
let allOutput = "";

let facts: Facts | undefined;
const ctx = {
  runtime: {
    description: "stub",
    runningConnectionFacts: async (): Promise<Facts | undefined> => facts,
  },
} as unknown as Context;

async function resetEnv(): Promise<void> {
  await writeFile(envFile(), SEED, "utf8");
}

/** Runs `body` with the output captured per case — and accumulated for the cross-cutting
 *  token check. A thrown UserError comes back as its message, not as a crash. */
async function capture(body: () => Promise<void>): Promise<{ output: string; error: string }> {
  let output = "";
  let error = "";
  try {
    await withOutputSink(
      (chunk) => {
        output += chunk;
        allOutput += chunk;
      },
      body,
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { output, error };
}

try {
  await resetEnv();

  // --- merge: stale facts rewritten in place, everything else untouched ------------------
  {
    facts = { dataDir: "/new/data", port: "18790", composeProject: "new-project", image: "ghcr.io/openclaw/openclaw:new-tag" };
    const { output } = await capture(() => recoverEnv(ctx, []));
    const merged = await readFile(envFile(), "utf8");
    check("a stale data dir is updated in place", merged.includes("OC_DATA_DIR=/new/data"), true);
    check("a stale port is updated in place", merged.includes("OPENCLAW_GATEWAY_PORT=18790"), true);
    check("a stale compose project is updated in place", merged.includes("OC_COMPOSE_PROJECT=new-project"), true);
    check("a stale image is updated in place", merged.includes("OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:new-tag"), true);
    check("the token line passes through byte-identical", merged.includes(`OPENCLAW_GATEWAY_TOKEN=${TOKEN}`), true);
    check("unrelated settings survive the merge", merged.includes("KEEP_ME=keep"), true);
    const order = [
      "OC_DATA_DIR=",
      "OPENCLAW_GATEWAY_PORT=",
      "OC_COMPOSE_PROJECT=",
      "OPENCLAW_IMAGE=",
      `OPENCLAW_GATEWAY_TOKEN=${TOKEN}`,
      "KEEP_ME=",
    ].map((name) => merged.indexOf(name));
    check("the merged lines keep the file's original order", order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), true);
    for (const line of [
      "OC_DATA_DIR=/new/data",
      "OPENCLAW_GATEWAY_PORT=18790",
      "OC_COMPOSE_PROJECT=new-project",
      "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:new-tag",
    ]) {
      check(`the report names ${line}`, output.includes(line), true);
    }
    check("the report tells the operator to restart", output.includes("restart"), true);
    check("the report never carries the token", output.includes(TOKEN), false);
  }

  // --- --dry-run: says what would change, writes nothing ---------------------------------
  {
    await resetEnv();
    facts = { dataDir: "/new/data", port: "18790", composeProject: "new-project", image: "ghcr.io/openclaw/openclaw:new-tag" };
    const { output } = await capture(() => recoverEnv(ctx, ["--dry-run"]));
    check("a dry run leaves the file byte-identical", await readFile(envFile(), "utf8"), SEED);
    check("the dry run says it is one", output.includes("dry run"), true);
    check(
      "the dry run names every value that would change",
      ["OC_DATA_DIR=/new/data", "OPENCLAW_GATEWAY_PORT=18790", "OC_COMPOSE_PROJECT=new-project", "OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:new-tag"]
        .every((line) => output.includes(line)),
      true,
    );
  }

  // --- nothing to recover: every fact already matches ------------------------------------
  {
    await resetEnv();
    facts = { dataDir: "/old/data", port: "9999", composeProject: "old-project", image: "ghcr.io/openclaw/openclaw:old-tag" };
    const { output } = await capture(() => recoverEnv(ctx, []));
    check("matching facts leave the file byte-identical", await readFile(envFile(), "utf8"), SEED);
    check("a full match is reported as nothing to recover", output.includes("nothing to recover"), true);
  }

  // --- an unrecoverable fact is left as it is, and named ---------------------------------
  {
    await resetEnv();
    facts = { port: "18790", composeProject: "new-project", image: "ghcr.io/openclaw/openclaw:new-tag" };
    const { output } = await capture(() => recoverEnv(ctx, []));
    const merged = await readFile(envFile(), "utf8");
    check("a missing data-dir fact leaves OC_DATA_DIR as it was", merged.includes("OC_DATA_DIR=/old/data"), true);
    check("the unrecoverable fact is named in a warning", output.includes("OC_DATA_DIR"), true);
    check(
      "the other three facts are still recovered",
      merged.includes("OPENCLAW_GATEWAY_PORT=18790") &&
        merged.includes("OC_COMPOSE_PROJECT=new-project") &&
        merged.includes("OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:new-tag"),
      true,
    );
  }

  // --- two unrecoverable facts, still a merge of the rest --------------------------------
  {
    await resetEnv();
    facts = { dataDir: "/newer/data", image: "ghcr.io/openclaw/openclaw:newer" };
    const { output } = await capture(() => recoverEnv(ctx, []));
    const merged = await readFile(envFile(), "utf8");
    check("a missing port fact leaves OPENCLAW_GATEWAY_PORT as it was", merged.includes("OPENCLAW_GATEWAY_PORT=9999"), true);
    check("a missing label leaves OC_COMPOSE_PROJECT as it was", merged.includes("OC_COMPOSE_PROJECT=old-project"), true);
    check("both unrecoverable facts are named", output.includes("OPENCLAW_GATEWAY_PORT") && output.includes("OC_COMPOSE_PROJECT"), true);
    check(
      "the present facts are still recovered",
      merged.includes("OC_DATA_DIR=/newer/data") && merged.includes("OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:newer"),
      true,
    );
    check("the token and unrelated settings survive", merged.includes(`OPENCLAW_GATEWAY_TOKEN=${TOKEN}`) && merged.includes("KEEP_ME=keep"), true);
  }

  // --- not running: nothing to read the facts from ---------------------------------------
  {
    await resetEnv();
    facts = undefined;
    const { error } = await capture(() => recoverEnv(ctx, []));
    check("a runtime with no running container throws", error !== "", true);
    check("the refusal says the container is not running", error.includes("not running"), true);
    check("a refused recovery leaves the file byte-identical", await readFile(envFile(), "utf8"), SEED);
  }

  // --- no capability: the runtime cannot introspect at all -------------------------------
  {
    await resetEnv();
    const noCapability = { runtime: { description: "stub" } } as unknown as Context;
    const { error } = await capture(() => recoverEnv(noCapability, []));
    check("a runtime that cannot introspect throws", error !== "", true);
    check("the refusal says it cannot introspect", error.includes("cannot introspect"), true);
    check("a refused recovery leaves the file unchanged", await readFile(envFile(), "utf8"), SEED);
  }

  // --- the inherent limit: no .env at all cannot be recovered against --------------------
  {
    const emptyDir = await mkdtemp(join(tmpdir(), "clawforge-recover-env-check-"));
    useDeployment(emptyDir);
    let error = "";
    try {
      await withOutputSink(
        (chunk) => {
          allOutput += chunk;
        },
        () => recoverEnv(ctx, []),
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      useDeployment(deployDir);
      await rm(emptyDir, { recursive: true, force: true });
    }
    check("a missing .env is refused", error !== "", true);
    check("the refusal says the file does not exist", error.includes("does not exist"), true);
    check("the refusal says recovery cannot create one", error.includes("cannot create"), true);
    check("the refusal points at bootstrap", error.includes("bootstrap"), true);
    check("no .env was created in the empty deployment", await access(join(emptyDir, ".env")).then(() => true, () => false), false);
  }

  // --- cross-cutting: the secret sharing the file never leaks into ANY case's output -----
  check("no case's output ever carries the token", allOutput.includes(TOKEN), false);
} finally {
  if (previous !== undefined) useDeployment(previous);
  await rm(deployDir, { recursive: true, force: true });
}

process.stderr.write(failed === 0 ? "all recover-env checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
