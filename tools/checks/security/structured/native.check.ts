import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { LocalTransport } from "#framework/runtime/transport/transport.ts";
import { readPrivateState, writePrivateState, appendPrivateJournal, PrivateDataError } from "#framework/security/privacy/private-config.ts";
import type { Context } from "#framework/core/context.ts";
import { withInstanceLock } from "#framework/runtime/lock/instance-lock.ts";
import { fixture } from "./fixture.ts";
import { diskLocks } from "./diagnostics.ts";

await requires("linux-host", "native private structured", async () => {
  await requires("posix-sh", "native shell", async () => {
    await requires("gnu-userland", "native atomic rename", async () => {
      const f = await fixture();
      const ctx = { settings: { dataDir: f.root, env: {} }, transport: new LocalTransport() } as unknown as Context;
      const path = `${f.root}/vault/a/b/state.json`;
      try {
        await writePrivateState(ctx, path, { private: true }, { version: 1 });
        check("native state roundtrip", await readPrivateState(ctx, path, { version: 1 }), { private: true });
        check("native missing", await readPrivateState(ctx, `${f.root}/vault/missing/x.json`, { version: 1 }), undefined);
        await requires("posix-modes", "private boundary modes", async () => {
          for (const parent of ["vault", "vault/a", "vault/a/b"]) check(`mode ${parent}`, (await stat(`${f.root}/${parent}`)).mode & 0o777, 0o700);
          // Differential: the original mkdirp + leaf-only chmod leaves new ancestors public.
          const legacy = `${f.root}/legacy/a/b`;
          const mask = process.umask(0o022);
          try {
            await ctx.transport.mkdirp(legacy);
            await ctx.transport.exec("chmod", ["700", legacy]);
          } finally { process.umask(mask); }
          check("original mechanism ancestor modes under umask 022", await Promise.all(["legacy", "legacy/a", "legacy/a/b"].map(async parent => (await stat(`${f.root}/${parent}`)).mode & 0o777)), [0o755, 0o755, 0o700]);
          check("state mode", (await stat(path)).mode & 0o777, 0o600);
        });
        await requires("symlink", "final symlink refusal and replacement", async () => {
          const outside = `${f.root}/outside`;
          const link = `${f.root}/vault/link.json`;
          await writeFile(outside, "unchanged"); await symlink(outside, link);
          let code: unknown;
          try { await readPrivateState(ctx, link, { version: 1 }); } catch (error) { code = error instanceof PrivateDataError ? error.code : error; }
          check("native final symlink read", code, "symlink");
          await writePrivateState(ctx, link, { safe: true }, { version: 1 });
          check("native replacement leaves referent", await readFile(outside, "utf8"), "unchanged");
        });
        const bytes = await readFile(path);
        const transport = new LocalTransport();
        const exec = transport.exec.bind(transport);
        transport.exec = async (command, args, options) => {
          if (command === "mv" && args.at(-1) === path) throw Error("injected publication failure");
          return exec(command, args, options);
        };
        let code: unknown;
        try { await writePrivateState({ ...ctx, transport }, path, { changed: true }, { version: 1 }); } catch (error) { code = error instanceof PrivateDataError ? error.code : error; }
        check("native publication failure", code, "io");
        check("native preservation", await readFile(path), bytes);
        const journal = `${f.root}/vault/held.jsonl`;
        await withInstanceLock(ctx, "u5", "u5-held", {}, async () => {
          const results = await Promise.allSettled([appendPrivateJournal(ctx, journal, { item: 1 }), appendPrivateJournal(ctx, journal, { item: 2 })]);
          check("native held-lock siblings", results.map(result => result.status).sort(), ["fulfilled", "rejected"]);
          check("native held-lock refusal code", results.filter(result => result.status === "rejected").map(result => result.reason.code), ["busy"]);
        });
        function worker(writer: string): Promise<{ writer: string; accepted: number[]; attempts: Array<{ index: number; attempts: number; elapsedMs: number; lastError?: string }> }> {
          return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./worker.ts", import.meta.url)), f.root, writer], { stdio: ["ignore", "pipe", "pipe"] });
            let output = "", errors = "";
            child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
            const timer = setTimeout(() => { child.kill(); reject(Error(`worker ${writer} timeout; stdout=${output}; stderr=${errors}`)); }, 120_000);
            child.on("error", reject);
            child.on("close", code => { clearTimeout(timer); if (code !== 0) reject(Error(errors)); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
          });
        }
        const reports = await Promise.all([worker("one"), worker("two")]);
        process.stderr.write(`native worker reports: ${JSON.stringify(reports)}\n`);
        process.stderr.write(`native post-worker disk locks: ${JSON.stringify(await diskLocks(ctx))}\n`);
        for (const report of reports) check(`worker ${report.writer} accepted all intended records`, report.accepted, [0, 1, 2]);
        const text = await readFile(`${f.root}/vault/concurrent.jsonl`, "utf8");
        checkTrue("concurrent final newline", text.endsWith("\n"));
        const records = text.trimEnd().split("\n").map(line => JSON.parse(line));
        check("accepted lines complete and unique", records.map(record => `${record.writer}:${record.index}`).sort(), reports.flatMap(report => report.accepted.map(index => `${report.writer}:${index}`)).sort());
        await requires("posix-modes", "journal modes", async () => { check("journal mode 600", (await stat(`${f.root}/vault/concurrent.jsonl`)).mode & 0o777, 0o600); });
      } finally { await f.dispose(); }
    });
  });
});
finish("private structured native U5");
