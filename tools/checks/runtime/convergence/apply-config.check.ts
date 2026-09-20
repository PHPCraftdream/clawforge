// Where `apply-config` stages its payload, and why the two runs must not share a name.
//
// The real run writes a shared file inside the data directory and holds the instance lock
// while it does. A dry run deliberately takes no lock — locking would make inspecting a busy
// instance fail for no reason — so it must not write that shared file: a dry run concurrent
// with a real apply would replace the payload the real one is about to hand to the CLI.

import { applyConfig, stagedFileName } from "#framework/commands/orchestration/config.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withOutputSink } from "#framework/core/output.ts";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "#framework/core/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

check("a real run stages under the shared name the container reads", stagedFileName(false), "clawforge-desired.json");
check("a dry run does not", stagedFileName(true) === stagedFileName(false), false);

// Two dry runs at once are as ordinary as one dry run beside a real one — neither takes a
// lock, so neither can rely on being alone.
check("two dry runs do not collide with each other", stagedFileName(true) === stagedFileName(true), false);

// Still recognisable in a directory listing, and still JSON to anything that reads by
// extension.
const dry = stagedFileName(true);
check("the dry-run name says what it is", dry.startsWith("clawforge-desired.dry-"), true);
check("and stays a .json file", dry.endsWith(".json"), true);

// --- the run that leaves a file behind is the one that failed ---------------------------------
//
// Cleaning up only after a successful run meant every rejected payload left an
// clawforge-desired.dry-<hex>.json in the config directory. Those accumulate, travel into an
// archive, and get the snapshot refused by the share allow-list — the same failure the
// operation journal caused, arriving by a different route.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-apply-config-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    await writeFile(resolve(deployment, "config", "desired-state.json"), JSON.stringify([{ path: "gateway.mode", value: "local" }]));
    useDeployment(deployment);

    const written = new Set<string>();
    const ctx = {
      settings: { dataDir: "/srv/clawforge" },
      transport: {
        async writeFile(path: string): Promise<void> {
          written.add(path);
        },
        async remove(path: string): Promise<void> {
          written.delete(path);
        },
      },
      paths: { toContainer: (path: string) => path },
      runtime: {
        async runOneOff(): Promise<never> {
          // What a payload the CLI rejects looks like from here.
          throw new Error("config set --dry-run failed: invalid path");
        },
      },
    } as unknown as Context;

    let threw = false;
    await withOutputSink(
      () => {},
      async () => {
        try {
          await applyConfig(ctx, ["--dry-run"]);
        } catch {
          threw = true;
        }
      },
    );

    check("a rejected payload still fails the command", threw, true);
    check("and leaves no staged file behind", [...written], []);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
}

// --- --dump: the reverse run, rebuilding the declaration from the instance's own config -------
//
// When the operator's copy of desired-state.json is lost, the live openclaw.json is the only
// place the values still exist. Only the target's config file is read and only the local
// declaration is written, so the stub context answers for the transport alone.

{
  const deployment = await mkdtemp(join(tmpdir(), "clawforge-apply-config-dump-check-"));
  try {
    await mkdir(resolve(deployment, "config"), { recursive: true });
    useDeployment(deployment);

    // Mutable so each case can bend what the target answers with — that is the whole point of
    // stubbing the transport rather than building a real one.
    let liveConfig = `{
  // The live config is OpenClaw's own JSON5 format — a comment or trailing comma is
  // legitimate there (readLiveConfigOrThrow parses it as JSON5 for exactly this reason),
  // so the fixture is one: parsing it as plain JSON would throw.
  "gateway": { "mode": "local", "bind": "0.0.0.0", "extra": "not ours to declare" },
  "agents": { "defaults": { "model": { "primary": "openai/gpt-5" } } },
}`;
    let targetHasConfig = true;
    const ctx = {
      settings: { dataDir: "/srv/clawforge" },
      transport: {
        async exists(path: string): Promise<boolean> {
          return targetHasConfig && path.endsWith("openclaw.json");
        },
        async readFile(): Promise<string> {
          return liveConfig;
        },
      },
    } as unknown as Context;

    const desiredState = resolve(deployment, "config", "desired-state.json");
    const dump = async (...args: string[]): Promise<string> => {
      let output = "";
      await withOutputSink(
        (chunk: string) => {
          output += chunk;
        },
        async () => {
          await applyConfig(ctx, args);
        },
      );
      return output;
    };

    await dump("--dump");
    const recovered = await readFile(desiredState, "utf8");
    check("a dump recovers exactly the curated paths from the live config", JSON.parse(recovered) as unknown[], [
      { path: "gateway.mode", value: "local" },
      { path: "gateway.bind", value: "0.0.0.0" },
      { path: "agents.defaults.model.primary", value: "openai/gpt-5" },
    ]);
    check("and a live key outside the curated set does not leak in", recovered.includes("not ours to declare"), false);

    let refusal = "";
    try {
      await dump("--dump");
    } catch (error) {
      refusal = (error as Error).message;
    }
    check("a dump onto an existing declaration is refused", refusal.includes("already exists"), true);
    check("and the refusal names the way past it", refusal.includes("--force"), true);
    check("and the refused attempt leaves the file byte-identical", await readFile(desiredState, "utf8"), recovered);

    liveConfig = liveConfig.replace(`"mode": "local"`, `"mode": "remote"`);
    await dump("--dump", "--force");
    const overwritten = JSON.parse(await readFile(desiredState, "utf8")) as { path: string; value: unknown }[];
    check("--force overwrites, so a changed live value is recovered", overwritten.find((entry) => entry.path === "gateway.mode")?.value, "remote");

    // A target that only ever set one of the curated paths must yield exactly that one — the
    // other two have no value to recover, and guessing one would fabricate a declaration.
    liveConfig = `{ "gateway": { "mode": "local" } }`;
    const partial = await dump("--dump", "--force");
    const partialContent = await readFile(desiredState, "utf8");
    check("a live config missing two of the paths yields only what exists", JSON.parse(partialContent) as unknown[], [
      { path: "gateway.mode", value: "local" },
    ]);
    check("and the omitted ones are not emitted as null", partialContent.includes("null"), false);
    check("nor as undefined", partialContent.includes("undefined"), false);
    check("each omission is named in the output", partial.includes("gateway.bind"), true);
    check("beside the note that recovered values are not the original declaration", partial.includes("not the original declaration"), true);
    check("and that recipes are not part of the file", partial.includes("recipes"), true);

    targetHasConfig = false;
    const beforeMissing = await readFile(desiredState, "utf8");
    let missing = "";
    try {
      await dump("--dump", "--force");
    } catch (error) {
      missing = (error as Error).message;
    }
    check("a target with no live config is refused even under --force", missing.includes("not found"), true);
    check("and the declaration survives the refused dump", await readFile(desiredState, "utf8"), beforeMissing);
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
}

process.stderr.write(failed === 0 ? "all apply-config checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
