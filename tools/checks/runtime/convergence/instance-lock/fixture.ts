// Shared fixture for the instance-lock.check.ts split (claims/takeover/nesting/misc.check.ts,
// this same directory): the stubbed Context every one of those files claims a lock against.
//
// Not `check`/`failed` — module state shared across check files that run in the same process
// (tools/checks/run.ts imports them one after another) would let one file's failure count leak
// into another's. Each check file keeps its own trivial copy of those instead.

import { withOutputSink } from "#framework/core/output.ts";
import type { Context } from "#framework/core/context.ts";

/** A target with the one property the lock is built on: `mkdir` of an existing directory
 *  fails. Emulated rather than assumed, because it is the entire mechanism — a stub whose
 *  mkdir always succeeded would let this file pass against a lock that locks nothing. */
export function stubContext() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    ctx: {
      settings: { dataDir: "/srv/clawforge" },
      transport: {
        async exec(command: string, args: string[]) {
          if (command === "mkdir") {
            const target = args[args.length - 1];
            if (dirs.has(target)) return { code: 1, stdout: "", stderr: "File exists" };
            dirs.add(target);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "rmdir") {
            const target = args[args.length - 1];
            const hasFile = [...files.keys()].some((entry) => entry.startsWith(`${target}/`));
            const hasChild = [...dirs].some((entry) => entry.startsWith(`${target}/`));
            if (hasFile || hasChild) return { code: 1, stdout: "", stderr: "Directory not empty" };
            dirs.delete(target);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "mv") {
            // Emulates POSIX rename: fails once the source is gone — only one racing mover wins.
            const [source, dest] = args;
            if (!dirs.has(source)) return { code: 1, stdout: "", stderr: "No such file or directory" };
            for (const entry of [...dirs].filter((entry) => entry === source || entry.startsWith(`${source}/`))) {
              dirs.delete(entry);
              dirs.add(dest + entry.slice(source.length));
            }
            for (const [key, value] of [...files.entries()].filter(([k]) => k === source || k.startsWith(`${source}/`))) {
              files.delete(key);
              files.set(dest + key.slice(source.length), value);
            }
            return { code: 0, stdout: "", stderr: "" };
          }
          if (command === "rm") {
            const target = args[args.length - 1];
            for (const entry of [...dirs].filter((entry) => entry === target || entry.startsWith(`${target}/`))) dirs.delete(entry);
            for (const key of [...files.keys()].filter((key) => key === target || key.startsWith(`${target}/`))) files.delete(key);
            return { code: 0, stdout: "", stderr: "" };
          }
          // `test -d` is how the lock asks whether a directory is there — whether a claim
          // failed into a held lock, whether a takeover's restore has anywhere to put the
          // displaced directory back, whether a release still owns the root it is about to
          // remove. A stub that answered "yes" to everything would let the checks pass
          // against a lock that is not atomic, so it is answered from the modeled tree.
          if (command === "test" && args[0] === "-d") {
            return { code: dirs.has(args[1] ?? "") ? 0 : 1, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        async readFile(path: string): Promise<string> {
          const content = files.get(path);
          if (content === undefined) throw new Error(`no such file: ${path}`);
          return content;
        },
        async writeFile(path: string, content: string): Promise<void> {
          files.set(path, content);
        },
        async remove(path: string): Promise<void> {
          files.delete(path);
          dirs.delete(path);
          for (const key of files.keys()) {
            if (key.startsWith(`${path}/`)) files.delete(key);
          }
        },
        async removeEmptyTree(path: string): Promise<boolean> {
          for (const dir of [...dirs].filter((entry) => entry.startsWith(`${path}/`)).sort((a, b) => b.length - a.length)) {
            const hasFile = [...files.keys()].some((entry) => entry.startsWith(`${dir}/`));
            const hasChild = [...dirs].some((entry) => entry.startsWith(`${dir}/`));
            if (!hasFile && !hasChild) dirs.delete(dir);
          }
          const hasFile = [...files.keys()].some((entry) => entry.startsWith(`${path}/`));
          const hasChild = [...dirs].some((entry) => entry.startsWith(`${path}/`));
          if (!hasFile && !hasChild) {
            dirs.delete(path);
            return true;
          }
          return false;
        },
      },
    } as unknown as Context,
  };
}

/** Runs `body`, capturing the message of whatever it throws — the lock's job is to refuse, so
 *  most of what is worth asserting about it is the shape of a refusal. */
export async function refused(body: () => Promise<unknown>): Promise<string> {
  let message = "";
  await withOutputSink(
    () => {},
    async () => {
      try {
        await body();
      } catch (error) {
        message = (error as Error).message;
      }
    },
  );
  return message;
}
