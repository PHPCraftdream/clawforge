import { readdir, readFile } from "node:fs/promises";
import { lockHome } from "#framework/runtime/lock/instance-lock.ts";
import { LocalTransport, type Transport } from "#framework/runtime/transport/transport.ts";
import type { Context } from "#framework/core/context.ts";

export function errorReport(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
}

// Native-only, read-only snapshots: read directly so diagnostic reads cannot
// obscure the failed command. Directory disappearance during a read is reported.
export async function diskLocks(ctx: Context) {
  const home = lockHome(ctx);
  async function directory(path: string) {
    try {
      const entries = (await readdir(path)).sort();
      const records: Record<string, unknown> = {};
      for (const name of entries.filter(name => name.endsWith(".json"))) {
        try { records[name] = await readFile(`${path}/${name}`, "utf8"); }
        catch (error) { records[name] = errorReport(error); }
      }
      return { path, entries, records };
    } catch (error) { return { path, error: errorReport(error) }; }
  }
  return { at: new Date().toISOString(), home: await directory(home), lock: await directory(`${home}/operation.lock`), mutation: await directory(`${home}/operation.mutation`) };
}

export function diagnosticTransport() {
  const failures: Array<Record<string, unknown>> = [];
  let total = 0;
  function record(failure: Record<string, unknown>) {
    total++;
    // Keep the first events (including release) and a rolling tail, not unbounded retries.
    if (failures.length === 40) failures.splice(20, 1);
    failures.push({ at: new Date().toISOString(), ...failure });
  }
  const transport: Transport = new LocalTransport();
  const exec = transport.exec.bind(transport);
  const diagnosticExec: Transport["exec"] = async (command, args, options) => {
    const invocation = [command, args, options];
    try {
      const result = await exec(command, args, options);
      if (result.code !== 0 || result.timedOut) record({ method: "exec", args: invocation, result });
      return result;
    } catch (error) {
      record({ method: "exec", args: invocation, error: errorReport(error) });
      throw error;
    }
  };
  transport.exec = diagnosticExec;
  return { transport, report: () => ({ total, failures: [...failures] }) };
}
