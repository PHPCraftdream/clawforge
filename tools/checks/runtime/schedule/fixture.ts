import type { ExecResult } from "#framework/runtime/transport/transport.ts";

/** Models a single target transaction; the Linux check exercises the actual shell/flock. */
export function stubCrontabTransaction(args: string[], current: string, listingFailure?: ExecResult): { result: ExecResult; next: string; wrote: boolean } {
  if (listingFailure !== undefined) {
    return { result: { code: 28, stdout: "", stderr: "could not read crontab; table unchanged" }, next: current, wrote: false };
  }
  const pattern = new RegExp(args[3]);
  const rows = current.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const kept = rows.filter((row) => !pattern.test(row));
  if (args[5] === "install") kept.push(args[4]);
  const next = kept.length === 0 ? "" : `${kept.join("\n")}\n`;
  const wrote = next !== current;
  return { result: { code: 0, stdout: wrote ? "updated\n" : "unchanged\n", stderr: "" }, next, wrote };
}
