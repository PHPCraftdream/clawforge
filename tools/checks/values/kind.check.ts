// The declared value kinds (core/values/kinds.ts): every constructor's example parses, every
// parse-stage invalid sample is refused with a ValueError, and the kinds the decisions pinned
// down (hostId, checksum, sshDestination, name, text, choice) accept and refuse the exact
// values their decisions name.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { ValueError, type ValueParser } from "#framework/core/values/value.ts";
import {
  absolutePath, checksum, choice, commandName, count, envVar, hostId, id, image, interval,
  localDirectory, localFile, name, pattern, port, positive, providerId, receiptId, recipeRef, since, sshDestination, text,
} from "#framework/core/values/kinds.ts";
import type { ValueKind } from "#framework/core/values/kind.ts";

/** A parse the sweep could run: the example is accepted, each parse-stage sample refused. */
function sweep(kind: ValueKind<unknown>, label: string): void {
  let value: unknown;
  try {
    value = kind.parse(kind.example);
  } catch (error) {
    value = error;
  }
  checkTrue(`${label}: example "${kind.example}" parses`, !(value instanceof Error));
  for (const sample of kind.invalid) {
    if (sample.stage !== "parse") continue;
    let refused: unknown;
    try {
      kind.parse(sample.raw);
    } catch (error) {
      refused = error;
    }
    checkTrue(`${label}: refuses "${sample.raw}" (${sample.why}) with a ValueError`, refused instanceof ValueError);
  }
}

const KINDS: ReadonlyArray<readonly [string, ValueKind<unknown>]> = [
  ["choice", choice(["a", "b"])],
  ["count", count("a number of lines")],
  ["positive", positive()],
  ["receiptId", receiptId()],
  ["count (default voice)", count()],
  ["port", port()],
  ["pattern", pattern()],
  ["interval (bare minutes)", interval()],
  ["interval (unit required)", interval({ requireUnit: true })],
  ["providerId", providerId()],
  ["envVar", envVar()],
  ["since", since],
  ["name (create)", name("recipe", "create")],
  ["name (read)", name("recipe", "read")],
  ["id", id("operation", "op-1")],
  ["checksum", checksum("hex64", { expected: "a declaration checksum", invalid: (raw) => `invalid expect "${raw}"`, example: "ab".repeat(32) })],
  ["hostId", hostId()],
  ["sshDestination", sshDestination()],
  ["commandName", commandName(["help", "status"], (input, candidates) => (input === "" ? undefined : candidates[0]))],
  ["absolutePath", absolutePath()],
  ["localFile", localFile("a set artifact")],
  ["localDirectory", localDirectory("a recipe source")],
  ["recipeRef", recipeRef()],
  ["image", image()],
  ["text (refuse)", text("path on the target")],
  ["text (allow)", text("args", { leadingDash: "allow" })],
];
for (const [label, kind] of KINDS) sweep(kind, label);

// --- the decisions, pinned with literals ------------------------------------------------------

// operations --limit's grammar, verbatim: one refusal sentence for both mistakes.
check("positive takes its example", positive().parse("10"), 10);
for (const raw of ["0", "abc", ""]) {
  let refused: unknown;
  try {
    positive().parse(raw);
  } catch (error) {
    refused = error;
  }
  checkTrue(`positive refuses "${raw}" with a ValueError`, refused instanceof ValueError);
  check(`positive refuses "${raw}"`, refused instanceof Error ? (refused as Error).message.split(" ") : refused, ["needs", "a", "positive", "number"]);
}
// set receipts --receipt: the receipt grammar wrapped exactly.
check("receiptId takes its example", receiptId().parse("fresh-1"), "fresh-1");
{
  let refused: unknown;
  try {
    receiptId().parse("Bad_Id");
  } catch (error) {
    refused = error;
  }
  checkTrue("receiptId refuses an upper-case id with a ValueError", refused instanceof ValueError);
  check("receiptId refuses an upper-case id", refused instanceof Error ? (refused as Error).message.split(" ") : refused, [":", "invalid", "receipt", "id", "\"Bad_Id\""]);
}

// hostId (§3 "Вид для host id"): every recorded form still reads — only empty and control
// characters are refused, or a foreign lock could become unsolvable.
for (const raw of ["DESKTOP-1:win32", "srv:linux-4026531836", "plainhost", "srv"]) {
  check(`hostId accepts the recorded form "${raw}"`, hostId().parse(raw), raw);
}
check("checksum hex64 accepts a full digest", checksum("hex64", {
  expected: "a declaration checksum",
  invalid: () => "invalid",
  example: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
}).parse("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"), "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
checkTrue("checksum hex64 refuses a short prefix", (() => {
  try {
    checksum("hex64", { expected: "e", invalid: (raw: string) => `: invalid set id "${raw}"`, example: "ab".repeat(32) }).parse("9f86d081");
    return false;
  } catch {
    return true;
  }
})());
for (const raw of ["a\tb", "a\nb", "a\rb"]) {
  let refused: unknown;
  try {
    hostId().parse(raw);
  } catch (error) {
    refused = error;
  }
  checkTrue(`hostId refuses "${raw}" with a ValueError`, refused instanceof ValueError);
}
for (const raw of ["a\tb", "a\nb", "a\rb"]) {
  let refused: unknown;
  try {
    sshDestination().parse(raw);
  } catch (error) {
    refused = error;
  }
  checkTrue(`sshDestination refuses "${raw}" with a ValueError`, refused instanceof ValueError);
}
for (const raw of ["-oProxyCommand=x", "a b"]) {
  let refused: unknown;
  try {
    sshDestination().parse(raw);
  } catch (error) {
    refused = error;
  }
  checkTrue(`sshDestination refuses "${raw}" with a ValueError`, refused instanceof ValueError);
  check(`sshDestination refuses "${raw}"`, refused instanceof Error ? (refused as Error).message.split(" ").slice(0, 6) : refused, ["takes", "an", "ssh", "destination", "(user@host),", "not"]);
}
check("name read accepts a recipe name", name("recipe", "read").parse("local"), "local");
checkTrue("text refuses a leading dash", (() => {
  try {
    text("path on the target").parse("-x");
    return false;
  } catch (error) {
    return error instanceof ValueError;
  }
})());
check("text with allow takes a leading dash", text("args", { leadingDash: "allow" }).parse("-x"), "-x");
check("choice carries its list", choice(["a", "b"]).choices, ["a", "b"]);
check("choice parses a member", choice(["a", "b"]).parse("a"), "a");
{
  let refused: unknown;
  try {
    choice(["a", "b"]).parse("c");
  } catch (error) {
    refused = error;
  }
  checkTrue("choice refuses a non-member with a ValueError", refused instanceof ValueError);
}

// absolutePath wraps the deploy boundary: the boundary's own refusal comes through joined
// after the argument's label.
check("absolutePath takes an absolute POSIX path", absolutePath().parse("/opt/openclaw"), "/opt/openclaw");
for (const raw of ["relative/x", "C:\\x"]) {
  let refused: unknown;
  try {
    absolutePath().parse(raw);
  } catch (error) {
    refused = error;
  }
  checkTrue(`absolutePath refuses "${raw}" with a ValueError`, refused instanceof ValueError);
  const message = refused instanceof Error ? (refused as Error).message : "";
  check(`absolutePath's refusal names --path (${raw})`, refused instanceof Error ? message.split(" ").slice(1, 5) : refused, ["--path", "must", "be", "an"]);
  check(`absolutePath's refusal keeps "absolute POSIX path" (${raw})`, refused instanceof Error ? message.split(" ").slice(5, 8) : refused, ["absolute", "POSIX", "path"]);
}
check("absolutePath's refusal is the boundary's own sentence", (() => {
  try {
    absolutePath().parse("relative/x");
    return "";
  } catch (error) {
    return (error as Error).message;
  }
})().split(" ").slice(1, 12), ["--path", "must", "be", "an", "absolute", "POSIX", "path", "—", "\"relative/x\"", "is", "not.\nDeploy"]);

// configure-provider (provider.ts:55–56 today): the kinds refuse exactly what prepare's own
// regexes refuse, in the kind's voice.
check("providerId takes the provider id a caller passes today", providerId().parse("openai"), "openai");
for (const raw of ["openai!", "-x", ""]) {
  let refused: unknown;
  try {
    providerId().parse(raw);
  } catch (error) {
    refused = error;
  }
  checkTrue(`providerId refuses "${raw}"`, refused instanceof ValueError && (refused as Error).message === (raw === "" ? "needs a value" : `takes a provider id, not "${raw}"`));
}
check("envVar takes the variable name a caller passes today", envVar().parse("OPENAI_API_KEY"), "OPENAI_API_KEY");
for (const raw of ["1BAD", "OPENAI-API-KEY", ""]) {
  let refused: unknown;
  try {
    envVar().parse(raw);
  } catch (error) {
    refused = error;
  }
  checkTrue(`envVar refuses "${raw}"`, refused instanceof ValueError && (refused as Error).message === (raw === "" ? "needs a value" : `takes an environment variable name, not "${raw}"`));
}
// interval's enforceRange runs after the grammar, its own exception untouched.
{
  let seen = 0;
  check("interval calls enforceRange with the bare minutes", interval({ enforceRange: (minutes) => { seen = minutes; } }).parse("6h"), 360);
  check("enforceRange sees the parsed minutes", seen, 360);
  checkTrue("an enforceRange exception propagates unchanged", (() => {
    try {
      interval({ enforceRange: () => { throw new RangeError("cron range"); } }).parse("6h");
      return false;
    } catch (error) {
      return error instanceof RangeError;
    }
  })());
}

// The examples of every constructor stay values a caller could actually pass (I11: the
// expectations above are literals, not product symbols).
checkTrue("a kind is a ValueParser", typeof (count() as ValueParser<number>).parse === "function");

finish("value kind");
