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

/** What a program receives when `line` is typed into cmd.exe: cmd's own pass (`%` expands,
 *  `& | < > ^` outside quotes split or redirect — a line with either throws), then
 *  CommandLineToArgvW's (2n backslashes + quote = n backslashes and a toggle, 2n+1 = n and a literal). */
export function cmdExeArgv(line: string): string[] {
  if (line.includes("%")) throw new Error("% expands in cmd.exe");
  let open = false;
  for (const char of line) {
    if (char === '"') open = !open;
    else if (!open && "&|<>^".includes(char)) throw new Error(`cmd.exe would act on ${char}`);
  }
  const argv: string[] = [];
  let current = "";
  let inArg = false;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    let slashes = 0;
    while (line[index] === "\\") { slashes++; index++; }
    if (line[index] === '"') {
      current += "\\".repeat(Math.floor(slashes / 2));
      inArg = true;
      if (slashes % 2 === 1) current += '"';
      else quoted = !quoted;
      continue;
    }
    current += "\\".repeat(slashes);
    if (index >= line.length) break;
    const char = line[index] as string;
    if (!quoted && (char === " " || char === "\t")) {
      if (inArg) argv.push(current);
      current = "";
      inArg = false;
    } else {
      current += char;
      inArg = true;
    }
  }
  if (inArg) argv.push(current);
  return argv;
}
