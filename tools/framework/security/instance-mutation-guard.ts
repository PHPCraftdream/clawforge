import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { locksDir } from "../core/env.ts";
import type { Context } from "../core/context.ts";

interface MutationOwner {
  readonly generation: string;
  readonly pid: number;
  readonly machine: string;
  readonly takenAt: string;
}

function guardPath(ctx: Context): string {
  return `${locksDir(ctx.settings.dataDir)}/operation.mutation`;
}

function ownerPath(ctx: Context): string {
  return `${guardPath(ctx)}/owner.json`;
}

function claimPath(ctx: Context, generation: string): string {
  return `${guardPath(ctx)}/.claim-${generation}`;
}

function machineName(): string {
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? hostname();
}

async function writeExclusive(ctx: Context, path: string, content: string): Promise<boolean> {
  const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await ctx.transport.writeFile(temporary, content);
    const linked = await ctx.transport.exec("ln", [temporary, path], { allowFailure: true });
    return linked.code === 0;
  } finally {
    await ctx.transport.remove(temporary).catch(() => {});
  }
}

async function claims(ctx: Context): Promise<string[]> {
  const files = await ctx.transport.listFiles(guardPath(ctx));
  return files
    .filter((file) => /^\.claim-[a-f0-9]+$/.test(file))
    .map((file) => `${guardPath(ctx)}/${file}`);
}

async function readOwner(ctx: Context, path: string): Promise<MutationOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await ctx.transport.readFile(path));
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Partial<MutationOwner>;
    if (typeof owner.generation !== "string" || !Number.isInteger(owner.pid) || owner.pid! <= 0 ||
        typeof owner.machine !== "string" || typeof owner.takenAt !== "string") return undefined;
    return owner as MutationOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(owner: MutationOwner): boolean | undefined {
  if (owner.machine !== machineName()) return undefined;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

function busy(path: string, owner?: MutationOwner): Error {
  const identity = owner === undefined ? "an unnamed operation" : `pid ${owner.pid} on ${owner.machine}`;
  const advice = owner === undefined
    ? "if no lock change is active, retry with --break-lock"
    : owner.machine === machineName()
      ? "wait for it to finish"
      : `check whether it is still running on ${owner.machine}`;
  return new Error(`another instance-lock change is in progress at ${path} (${identity}); ${advice}`);
}

async function removeEmptyDirectory(ctx: Context, path: string): Promise<void> {
  if (ctx.transport.removeEmptyDir !== undefined) {
    await ctx.transport.removeEmptyDir(path).catch(() => {});
    return;
  }
  await ctx.transport.exec("rmdir", [path], { allowFailure: true });
}

async function claim(ctx: Context, breakLock: boolean): Promise<MutationOwner | undefined> {
  const homePath = locksDir(ctx.settings.dataDir);
  const home = await ctx.transport.exec("mkdir", ["-p", homePath], { allowFailure: true });
  if (home.code !== 0) {
    const homeExists = await ctx.transport.exec("test", ["-d", homePath], { allowFailure: true });
    if (homeExists.code !== 0) return undefined;
  }

  const guard = guardPath(ctx);
  const generation = randomBytes(12).toString("hex");
  const candidate: MutationOwner = { generation, pid: process.pid, machine: machineName(), takenAt: new Date().toISOString() };
  const content = `${JSON.stringify(candidate)}\n`;
  const acquired = await ctx.transport.exec("mkdir", [guard], { allowFailure: true });

  if (acquired.code === 0) {
    const marker = claimPath(ctx, generation);
    try {
      if (await writeExclusive(ctx, marker, content) && await ctx.transport.exec("ln", [marker, ownerPath(ctx)], { allowFailure: true }).then((r) => r.code === 0)) {
        await ctx.transport.remove(marker).catch(() => {});
        return candidate;
      }
    } catch (error) {
      await removeEmptyDirectory(ctx, guard);
      throw error;
    }
    await ctx.transport.remove(marker).catch(() => {});
    await removeEmptyDirectory(ctx, guard);
    throw busy(guard, await readOwner(ctx, ownerPath(ctx)));
  }

  const exists = await ctx.transport.exec("test", ["-d", guard], { allowFailure: true });
  if (exists.code !== 0) throw new Error(`could not serialize instance-lock changes at ${guard}: ${(acquired.stderr || acquired.stdout).trim()}`);

  const ownerFile = ownerPath(ctx);
  const current = await readOwner(ctx, ownerFile);
  if (current !== undefined) {
    if (processIsAlive(current) !== false) throw busy(guard, current);
  } else if (!breakLock) {
    throw busy(guard);
  }

  const marker = claimPath(ctx, generation);
  if (!(await writeExclusive(ctx, marker, content))) throw busy(guard, current);

  let otherClaims: string[];
  try {
    otherClaims = (await claims(ctx)).filter((path) => path !== marker);
  } catch (error) {
    await ctx.transport.remove(marker).catch(() => {});
    throw error;
  }
  for (const other of otherClaims) {
    const otherOwner = await readOwner(ctx, other);
    const alive = otherOwner === undefined ? undefined : processIsAlive(otherOwner);
    if (alive === true || alive === undefined) {
      await ctx.transport.remove(marker).catch(() => {});
      throw busy(guard, otherOwner ?? current);
    }
    await ctx.transport.remove(other).catch(() => {});
  }

  if (current !== undefined) {
    const latest = await readOwner(ctx, ownerFile);
    if (latest?.generation !== current.generation) {
      await ctx.transport.remove(marker).catch(() => {});
      throw busy(guard, latest);
    }
    const parked = `${guard}/.stale-owner-${current.generation}`;
    const moved = await ctx.transport.exec("mv", [ownerFile, parked], { allowFailure: true });
    if (moved.code !== 0) {
      await ctx.transport.remove(marker).catch(() => {});
      throw busy(guard, await readOwner(ctx, ownerFile));
    }
  } else {
    let staleClaims: string[];
    try {
      staleClaims = (await claims(ctx)).filter((path) => path !== marker);
    } catch (error) {
      await ctx.transport.remove(marker).catch(() => {});
      throw error;
    }
    if (staleClaims.length > 0) {
      let claimed = false;
      for (const staleClaim of staleClaims) {
        const staleOwner = await readOwner(ctx, staleClaim);
        if (staleOwner !== undefined && processIsAlive(staleOwner) !== false) continue;
        const retired = `${guard}/.retired-claim-${randomBytes(6).toString("hex")}`;
        const moved = await ctx.transport.exec("mv", [staleClaim, retired], { allowFailure: true });
        if (moved.code === 0) {
          await ctx.transport.remove(retired).catch(() => {});
          claimed = true;
          break;
        }
      }
      if (!claimed) {
        await ctx.transport.remove(marker).catch(() => {});
        throw busy(guard);
      }
    }
  }

  const published = await ctx.transport.exec("ln", [marker, ownerFile], { allowFailure: true });
  if (published.code !== 0) {
    if (current !== undefined) {
      const parked = `${guard}/.stale-owner-${current.generation}`;
      const restored = await ctx.transport.exec("ln", [parked, ownerFile], { allowFailure: true });
      if (restored.code === 0) await ctx.transport.remove(parked).catch(() => {});
    }
    if (await readOwner(ctx, ownerFile) !== undefined) await ctx.transport.remove(marker).catch(() => {});
    throw busy(guard, await readOwner(ctx, ownerFile));
  }
  await ctx.transport.remove(marker).catch(() => {});
  if (current !== undefined) await ctx.transport.remove(`${guard}/.stale-owner-${current.generation}`).catch(() => {});
  return candidate;
}

async function release(ctx: Context, owner: MutationOwner): Promise<void> {
  const current = await readOwner(ctx, ownerPath(ctx));
  if (current?.generation !== owner.generation) return;
  await ctx.transport.remove(ownerPath(ctx)).catch(() => {});
  await removeEmptyDirectory(ctx, guardPath(ctx));
}

/** Runs a lock-state mutation under the shared, recoverable mutation guard. */
export async function withMutationGuard<T>(ctx: Context, body: () => Promise<T>, breakLock = false): Promise<T> {
  const owner = await claim(ctx, breakLock);
  if (owner === undefined) return body();
  try {
    return await body();
  } finally {
    await release(ctx, owner);
  }
}
