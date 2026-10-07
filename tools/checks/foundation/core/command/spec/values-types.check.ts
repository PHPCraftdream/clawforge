// Type-level: Values<> infers the right type from an argument list written the way commands
// will write them (`as const satisfies`). The assertions are compile-time — `npm run typecheck`
// fails if the inference regresses; the runtime half only proves the file was loaded.

import type { ArgumentSpec, Values } from "#framework/core/command/index.ts";
import type { ValueParser } from "#framework/core/values/value.ts";
import * as kinds from "#framework/core/values/kinds.ts";
import type { ValueKind } from "#framework/core/values/kind.ts";
import { choice, count, port, text } from "#framework/core/values/kinds.ts";
import { finish, typeAssert } from "#checks/kit/harness.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<_T extends true>(): void {}

// A logs-like single body.
const LOGS_LIKE = [
  { name: "tail", kind: "option", valueName: "n", value: count("a number of lines"), description: "d" },
  { name: "since", kind: "option", valueName: "duration", value: kinds.since, description: "d" },
  { name: "grep", kind: "option", valueName: "pattern", value: kinds.pattern(), description: "d" },
] as const satisfies readonly ArgumentSpec[];
type LogsValues = Values<typeof LOGS_LIKE>;
assertType<Equal<LogsValues["tail"], number | undefined>>();
assertType<Equal<LogsValues["since"], string | undefined>>();
assertType<Equal<LogsValues["grep"], RegExp | undefined>>();

// A backup-like action: flags, a choices option, a counted option, required and variadic arguments.
const BACKUP_LIKE = [
  { name: "profile", kind: "option", valueName: "profile", value: choice(["full", "migrate", "share"] as const), description: "d" },
  { name: "dry-run", kind: "flag", description: "d", effect: "read" },
  { name: "keep", kind: "option", valueName: "n", value: count(), description: "d" },
  { name: "port", kind: "option", valueName: "port", value: port(), required: true, description: "d" },
  { name: "archive", kind: "positional", required: true, value: text("d", { leadingDash: "allow" }), description: "d" },
  { name: "name", kind: "option", valueName: "name", value: text("d"), description: "d" },
  { name: "args", kind: "variadic", value: text("d", { leadingDash: "allow" }), description: "d" },
] as const satisfies readonly ArgumentSpec[];
type BackupValues = Values<typeof BACKUP_LIKE>;
assertType<Equal<BackupValues["profile"], "full" | "migrate" | "share" | undefined>>();
assertType<Equal<BackupValues["dry-run"], boolean>>();
assertType<Equal<BackupValues["keep"], number | undefined>>();
assertType<Equal<BackupValues["port"], number>>();
assertType<Equal<BackupValues["archive"], string>>();
assertType<Equal<BackupValues["name"], string | undefined>>();
assertType<Equal<BackupValues["args"], readonly string[]>>();

// A custom parser's own type flows through (wrapped as the value kind the binder converts with).
const custom: ValueParser<{ readonly id: bigint }> = { expected: "an id", example: "1", invalidExample: "x", parse: (raw) => ({ id: BigInt(raw) }) };
const CUSTOM_KIND: ValueKind<{ readonly id: bigint }> = { ...custom, kind: "text", invalid: [{ raw: "x", stage: "parse", why: "test" }] };
const CUSTOM = [{ name: "id", kind: "option", valueName: "id", value: CUSTOM_KIND, description: "d" }] as const satisfies readonly ArgumentSpec[];
assertType<Equal<Values<typeof CUSTOM>["id"], { readonly id: bigint } | undefined>>();

typeAssert("the type-level assertions compiled");
finish("values type inference");
