// The argument value parsers (core/values/value.ts and the domain parsers beside their
// grammars): what they accept, what they refuse, that example/invalidExample tell the truth,
// and that the refusal a user reads equals what the command's own hand-written parser prints
// today for the same bad value — the commands are called, their text is not restated here.

import { bind, tokenize, ArgumentError } from "#framework/core/command/index.ts";
import type { ArgumentSpec } from "#framework/core/command/index.ts";
import { countValue, nameValue, nonEmptyValue, portValue, regexValue, ValueError, type ValueParser } from "#framework/core/values/value.ts";
import { invalidNameMessage, safeName } from "#framework/core/values/names.ts";
import { sinceValue } from "#framework/core/values/durations.ts";
import { scheduleIntervalValue } from "#framework/commands/operate/schedule.ts";
import { imageRefValue } from "#framework/runtime/docker/image-ref.ts";
import { setIdValue, receiptIdValue } from "#framework/set/artifacts/receipt.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { exposeSsh } from "#framework/commands/operate/expose/ssh.ts";
import { watchInstall } from "#framework/commands/operate/watch/install.ts";
import { incident } from "#framework/commands/operate/incident/index.ts";
import type { Context } from "#framework/core/context.ts";

// The migrated lifecycle commands, through their spec faces: the refusal text is the binder's.
const logs = openclawCommands.logs.run;
const upgrade = openclawCommands.upgrade.run;
const backupPruneReplaced = (ctx: Context, args: string[]) => openclawCommands.backup.run(ctx, ["prune-replaced", ...args]);
const backupInstall = (ctx: Context, args: string[]) => openclawCommands.backup.run(ctx, ["install", ...args]);
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

/** What a user reads for `--<name> <raw>` through the shared binder. */
function refusalOf(parser: ValueParser<unknown>, raw: string, name = "x", kind: "option" | "positional" = "option"): string | undefined {
  const spec: ArgumentSpec = kind === "option"
    ? { name, kind: "option", valueName: "v", description: "d", parse: parser }
    : { name, kind: "positional", description: "d", parse: parser };
  try {
    bind([spec], tokenize([spec], kind === "option" ? [`--${name}=${raw}`] : [raw]));
    return undefined;
  } catch (error) {
    check(`${parser.expected}: "${raw}" is refused as an ArgumentError naming the argument`, error instanceof ArgumentError && (error as ArgumentError).argument === name, true);
    return (error as Error).message;
  }
}

/** What the command itself prints today: run with a context that is never reached, because every
 *  one of these refuses its arguments first. */
async function printedBy(run: (ctx: Context, args: string[]) => Promise<void>, args: string[]): Promise<string> {
  try {
    await run({} as Context, args);
  } catch (error) {
    return (error as Error).message;
  }
  return "(accepted)";
}

// --- valid values --------------------------------------------------------------------------

check("count: digits", countValue().parse("42"), 42);
check("count: zero", countValue().parse("0"), 0);
check("port: 1", portValue().parse("1"), 1);
check("port: 65535", portValue().parse("65535"), 65535);
check("regex: a pattern", regexValue().parse("a|b").test("b"), true);
check("regex: the empty pattern is valid", regexValue().parse("") instanceof RegExp, true);
check("name: a safe name", nameValue("recipe").parse("my-recipe"), "my-recipe");
check("non-empty: any text", nonEmptyValue().parse("a b"), "a b");
check("since: a duration", sinceValue.parse("1h30m"), "1h30m");
check("since: a timestamp", sinceValue.parse("2026-10-01T10:00:00Z"), "2026-10-01T10:00:00Z");
check("interval: 6h in minutes", scheduleIntervalValue({ bareMinutes: false }).parse("6h"), 360);
check("interval: a bare number is minutes when allowed", scheduleIntervalValue({ bareMinutes: true }).parse("10"), 10);
check("image: a reference", imageRefValue.parse("ghcr.io/openclaw/openclaw:2026.6.1").repository, "openclaw/openclaw");
check("set id: 64 hex characters", setIdValue().parse("ab".repeat(32)), "ab".repeat(32));
check("receipt id: a plain id", receiptIdValue().parse("fresh-1"), "fresh-1");

// --- invalid values ------------------------------------------------------------------------

for (const [raw, why] of [["-1", "a sign"], ["1.5", "a fraction"], ["", "empty"], ["abc", "text"], [" 5", "a space"]] as const) {
  check(`count refuses ${why}`, refusalOf(countValue("a number of lines"), raw)?.startsWith("--x takes a number of lines, not"), true);
}
for (const raw of ["0", "65536", "08", "x", "-1"]) {
  check(`port refuses ${JSON.stringify(raw)}`, refusalOf(portValue(), raw)?.startsWith("--x must be a port number between 1 and 65535, got: "), true);
}
check("port: empty is its own refusal", refusalOf(portValue(), ""), "--x needs a port number");
check("regex refuses an unclosed group", refusalOf(regexValue(), "(")?.startsWith("--x takes a valid regular expression: "), true);
check("name refuses upper case, positional label", refusalOf(nameValue("recipe"), "Bad", "x", "positional")?.startsWith("<x>: invalid recipe name \"Bad\""), true);
check("non-empty refuses empty", refusalOf(nonEmptyValue(), ""), "--x needs a value");
check("since refuses a sentence", refusalOf(sinceValue, "yesterday"), "--x takes a duration (10m, 2h, 1h30m) or an RFC3339/ISO date-time, not \"yesterday\"");
check("interval refuses garbage", refusalOf(scheduleIntervalValue({ bareMinutes: true }), "abc")?.startsWith("--x must be a number of minutes or look like 30m, 6h or 1d"), true);
check("image refuses a space", refusalOf(imageRefValue, "not an image")?.startsWith("--x: \"not an image\" is not a valid image reference"), true);

check("set id refuses a short blob", refusalOf(setIdValue(), "zz"), "--x: invalid set id \"zz\"");
check("receipt id refuses an upper case id", refusalOf(receiptIdValue(), "Bad_Id"), "--x: invalid receipt id \"Bad_Id\"");
check("receipt id refuses a path step", refusalOf(receiptIdValue(), ".."), "--x: invalid receipt id \"..\"");

// --- the parsers describe themselves truthfully ----------------------------------------------

const PARSERS: ReadonlyArray<readonly [string, ValueParser<unknown>]> = [
  ["count", countValue()], ["port", portValue()], ["regex", regexValue()], ["name", nameValue("recipe")],
  ["non-empty", nonEmptyValue()], ["since", sinceValue], ["interval", scheduleIntervalValue({ bareMinutes: true })],
  ["backup interval", scheduleIntervalValue({ bareMinutes: false })], ["image", imageRefValue],
  ["set id", setIdValue()], ["receipt id", receiptIdValue()],
];
for (const [name, parser] of PARSERS) {
  let accepted = true;
  try {
    parser.parse(parser.example);
  } catch {
    accepted = false;
  }
  check(`${name}: example "${parser.example}" parses`, accepted, true);
  let refused: unknown;
  try {
    parser.parse(parser.invalidExample);
  } catch (error) {
    refused = error;
  }
  checkTrue(`${name}: invalidExample "${parser.invalidExample}" throws a ValueError`, refused instanceof ValueError);
  checkTrue(`${name}: a refusal carries its clause`, refused instanceof ValueError && refused.clause !== "");
}

// --- the same text the commands print today ----------------------------------------------------

check("logs --tail", refusalOf(countValue("a number of lines"), "abc", "tail"), await printedBy(logs, ["--tail", "abc"]));
check("logs --since", refusalOf(sinceValue, "yesterday", "since"), await printedBy(logs, ["--since", "yesterday"]));
check("logs --grep", refusalOf(regexValue(), "(", "grep"), await printedBy(logs, ["--grep", "("]));
check(
  "backup prune-replaced --keep",
  refusalOf(countValue("a non-negative integer"), "abc", "keep"),
  await printedBy(backupPruneReplaced, ["--keep", "abc"]),
);
check("incident --tail", refusalOf(countValue("a number of lines", () => "needs a number of lines"), "abc", "tail"), await printedBy(incident, ["--tail", "abc"]));
for (const raw of ["x", "0", "65536", "08", "99999"]) {
  check(`expose ssh --local-port ${raw}`, refusalOf(portValue(), raw, "local-port"), await printedBy(exposeSsh, ["--local-port", raw]));
}
check("expose ssh --local-port (empty)", refusalOf(portValue(), "", "local-port"), await printedBy(exposeSsh, ["--local-port="]));
check("upgrade --image", refusalOf(imageRefValue, "not an image", "image"), await printedBy(upgrade, ["--image", "not an image"]));
for (const raw of ["abc", "", "7x"]) {
  check(`watch install --interval ${JSON.stringify(raw)}`, refusalOf(scheduleIntervalValue({ bareMinutes: true }), raw, "interval"), await printedBy(watchInstall, ["--interval", raw]));
}
for (const raw of ["6", "abc", "7m"]) {
  check(`backup install --interval ${JSON.stringify(raw)}`, refusalOf(scheduleIntervalValue({ bareMinutes: false }), raw, "interval"), await printedBy(backupInstall, ["--interval", raw]));
}

// Windows reserves device names on every path segment whatever the directory: a name the
// name pattern accepts but cmd and Git Bash cannot open or remove (R18).
for (const raw of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) {
  let refused: string | undefined;
  try {
    safeName("recipe", raw);
  } catch (error) {
    refused = (error as Error).message;
  }
  check(`name: the reserved device name "${raw}" is refused`, refused, invalidNameMessage("recipe", raw));
  check(`name: the reserved device name "${raw}" is refused through the parser`, refusalOf(nameValue("recipe"), raw, "name")?.includes(`invalid recipe name "${raw}"`), true);
}
checkTrue('name: a lookalike with a suffix is still fine', safeName("recipe", "con-course") === "con-course");

finish("value parser");
