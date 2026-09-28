// `./clawforge bootstrap` — brings an instance up from nothing.
//
// Idempotent: re-running it on a live instance refreshes
// the image and restarts, leaving data untouched.
//
// The order below is not arbitrary — it was paid for in debugging:
//   1. .env and the gateway token, because compose interpolates them
//   2. data directories owned by uid 1000, or the gateway cannot write
//   3. the image, before anything tries to run it
//   4. baseline config, or the gateway crash-loops on "Missing config"
//   5. declarative settings from the repository — a new custom provider's baseUrl and
//      models live here, and OpenClaw's schema requires them before it accepts an apiKey
//      for a provider id it does not already know
//   6. the provider, from the key in config/.env
//   7. only then start and wait for /healthz

import JSON5 from "json5";
import { log, info, warn } from "#src/core/io/log.ts";
import type { Context } from "#src/core/context.ts";
import { refreshContext } from "#src/core/context.ts";
import { ensureDataDirs, ensureSecretsFile, ensureLockHome } from "#src/runtime/datadir.ts";
import { ensureBaselineConfig, configureProvider } from "../management/credentials/provider.ts";
import { applyConfig } from "../orchestration/config.ts";
import { preflightSecrets } from "../management/secrets.ts";
import { preflightPort, pinImageReference } from "./lifecycle.ts";
import { guarded } from "#src/runtime/instance-lock.ts";
import { collectConfiguredProviders } from "#src/service/secrets.ts";
import { imageChannel } from "#src/runtime/docker/image-digest.ts";
import type { CommandArgument } from "#src/core/app.ts";
import { parseDeclaredArgs } from "#src/core/arguments.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

/** Drives both bootstrap's own parser and its openclawCommands declaration. */
export const BOOTSTRAP_ARGUMENTS: CommandArgument[] = [
  { name: "no-pull", description: "Use the image already present locally", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
];

/** After a fresh pull, this deployment's OWN OPENCLAW_IMAGE is repointed from the moving tag
 *  to the exact digest that tag was just proven to hold — so a LATER pull of the same shared
 *  tag by some other deployment on this Docker daemon can no longer silently switch what THIS
 *  deployment recreates onto next (up, restart after compose changes, apply). An
 *  already-pinned deployment (`image` already carries "@sha256:") is left alone: only
 *  ./clawforge upgrade moves those, deliberately, never a bootstrap re-run.
 *
 *  Best effort: a runtime that cannot resolve the digest the tag now holds locally right after
 *  the pull (no RepoDigests to report) leaves it a tag rather than guessing — the same "never
 *  guess" rule image-digest.ts documents throughout. Returns the context later steps should
 *  keep using: refreshContext() re-derives one from the .env this just rewrote, the same way
 *  every other step that rewrites .env does (apply.ts's REDERIVES_CONTEXT); a context this
 *  process did not build through createContext() (a check's own stub, say) has nothing to
 *  refresh and is returned unchanged. RepoDigests carry no tag, so the pin rejoins `image`'s
 *  own channel with the digest, keeping the tag `upgrade` re-resolves later. */
async function pinFreshPull(ctx: Context, image: string): Promise<Context> {
  if (image.includes("@sha256:")) return ctx;
  const pulled = await ctx.runtime.imageReference();
  if (pulled === undefined) {
    warn(`pulled ${image} but could not resolve the digest it now holds locally — OPENCLAW_IMAGE stays a moving tag`);
    return ctx;
  }
  const pinned = `${imageChannel(image)}@${pulled.split("@").at(-1)}`;
  await pinImageReference(pinned);
  info(`pinned OPENCLAW_IMAGE to ${pinned} in .env — another deployment pulling ${image} on this Docker daemon can no longer move this one; ./clawforge upgrade is how to move it from here`);
  const refreshed = await refreshContext(ctx);
  return refreshed?.context ?? ctx;
}

export async function bootstrap(ctx: Context, args: string[]): Promise<void> {
  const noPull = parseDeclaredArgs(BOOTSTRAP_ARGUMENTS, args)["no-pull"] === true;

  // Structurally ahead of the lock, not inside it: the lock lives in a directory of its own
  // (instance-lock.ts's lockHome), and on a fresh host that directory's PARENT is root:root
  // — preparing it needs the same sudo escalation ensureDataDirs uses for everything else,
  // but that escalation cannot happen while this process is already trying to take a lock
  // that lives inside the very directory it is escalating to create. Without this, the
  // first bootstrap ever run on such a host failed inside guarded()'s own unprivileged mkdir,
  // reporting "the directory is not there... ./clawforge bootstrap prepares it" — the command
  // that was supposed to prepare it, refusing before it got the chance to.
  //
  // Idempotent and side-effect-free beyond permissions (no instance data touched), so running
  // it unlocked reintroduces none of the race the lock below exists to prevent: ensureDataDirs
  // (which calls this again, harmlessly, once already prepared) and ensureSecretsFile's actual
  // write still run only after the lock is held.
  await ensureLockHome(ctx);

  // One lock for the whole sequence, not one per sub-command: taking separate locks per
  // sub-command (ensureDataDirs/ensureSecretsFile with none at all, applyConfig/
  // configureProvider each their own) would let a run refused by another operation already
  // holding the lock still WRITE config/.env (ensureSecretsFile) before the refusal ever
  // surfaced, only failing later at applyConfig's own internal takeLock().
  // guarded() is nesting-safe (instance-lock.ts), so the inner applyConfig()/
  // configureProvider() calls below just run inside this one outer hold instead of each
  // acquiring their own.
  return guarded(ctx, "bootstrap", args, () => bootstrapLocked(ctx, noPull));
}

async function bootstrapLocked(ctx: Context, noPull: boolean): Promise<void> {
  // .env and the token exist before this runs: the CLI prepares them for commands that
  // declare preparesEnvironment, so ctx already carries the finished settings.
  const fresh = ctx.settings;
  let live = ctx;
  const token = fresh.env.OPENCLAW_GATEWAY_TOKEN ?? "";

  // Refuse a port already published by another deployment before preparing data or pulling
  // an image. The check and Docker's later bind are not atomic.
  await preflightPort(live);
  await ensureDataDirs(live);
  await ensureSecretsFile(live);

  if (noPull) {
    info("skipping pull (--no-pull)");
  } else {
    // A tag is resolved to its digest at the registry and pinned BEFORE the pull, so the
    // pull is by digest and never moves the shared local tag other deployments run on.
    const resolved = fresh.image.includes("@sha256:") ? undefined : await live.runtime.resolveImageDigest?.(fresh.image);
    if (resolved !== undefined) {
      await pinImageReference(resolved);
      info(`pinned OPENCLAW_IMAGE to ${resolved} in .env — pulled by digest, the shared ${fresh.image} tag stays where it is; ./clawforge upgrade moves it from here`);
      live = (await refreshContext(live))?.context ?? live;
      log(`pulling ${resolved}`);
      await live.runtime.pullImage();
    } else {
      log(`pulling ${fresh.image}`);
      await live.runtime.pullImage();
      // Fallback (digest unresolvable at the registry): the pull moved the local tag for every
      // deployment on it; at least this one is pinned to what it got.
      live = await pinFreshPull(live, fresh.image);
    }
  }

  await ensureBaselineConfig(live);
  // Declared settings before the provider key: a brand-new custom provider's baseUrl and
  // model catalog come from here (config/desired-state.json), and OpenClaw's own schema
  // requires baseUrl on any provider id it does not already know about. Writing just the
  // apiKey first leaves that provider's entry incomplete and OpenClaw refuses the write,
  // which stopped bootstrap before this step ever ran. Built-in providers (zai and the
  // rest) are exempt from that requirement, so this order costs them nothing.
  // restartAdvice: false — the gateway starts a few lines below, in this same run; the
  // default "restart to pick it up" line would contradict that.
  await applyConfig(live, [], { restartAdvice: false });
  await configureProvider(live, []);

  await preflightSecrets(live);

  log("starting the gateway");
  await live.runtime.start();
  await live.runtime.waitForHealth();
  log("gateway is healthy");

  const digest = await live.runtime.imageReference();
  if (digest !== undefined) info(`running image: ${digest}`);

  log("OpenClaw is up");
  info(`gateway: ${fresh.serviceUrl}`);
  // The token is named, not printed. This output is not always read by a person at a
  // terminal: control-mcp runs the same command for an agent and hands back everything it
  // wrote, so a token printed here is a token in a transcript. It is already in the
  // deployment's .env, and `./clawforge mcp-creds --token` prints it when it is actually
  // wanted — which is the moment the operator chose, not every bootstrap.
  info(`token:   ${token === "" ? "(not generated)" : "in .env — print it with ./clawforge mcp-creds --token"}`);
  info(`data:    ${fresh.dataDir}`);

  // "up" and "healthy" are not the job: answering a prompt is, and with no provider key
  // configureProvider() above had nothing to reference. Read the same way inspect does
  // (collectConfiguredProviders against the live config), not guessed from which env vars
  // happen to be set — doctor would otherwise say "nothing blocking" over an instance that
  // cannot actually do its one job. Best effort: an unreadable or unparseable config
  // here is doctor's finding to make, not a reason to fail a bootstrap that just succeeded.
  try {
    const liveConfig = JSON5.parse(await live.transport.readFile(`${fresh.dataDir}/config/openclaw.json`)) as unknown;
    if (collectConfiguredProviders(liveConfig).length === 0) {
      info("provider: none configured yet — an agent cannot answer until one is: ./clawforge configure-provider");
    }
  } catch {
    // Doctor's own read of the same file reports a broken config; this is only a bonus hint.
  }
}
