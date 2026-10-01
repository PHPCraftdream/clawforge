// The shared duration grammar (core/values/durations.ts) and its consumers' parity with it.
// The expected values and messages below were pinned against the three pre-merge grammars
// (schedule.ts's parseIntervalToMinutes, env.ts's inline threshold pattern, logs.ts's inline
// --since predicates) before they were folded into one module: any drift between a consumer
// and the grammar it now delegates to fails here.

import { parseInterval, durationMs, validSince } from "#framework/core/values/durations.ts";
import { parseIntervalToMinutes } from "#framework/commands/operate/schedule.ts";
import { parseDurationThreshold } from "#framework/core/env.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

async function deathOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

// --- interval mode: watch's bare minutes allowed --------------------------------------------

check("30m -> 30 minutes", parseInterval("30m").minutes, 30);
check("6h -> 360 minutes", parseInterval("6h").minutes, 360);
check("1d -> 1440 minutes", parseInterval("1d").minutes, 1440);
check("a bare number is minutes", [parseInterval("30").minutes, parseInterval("30").bare], [30, true]);
check("an explicit unit is reported as such", parseInterval("45m").bare, false);
check("surrounding whitespace is trimmed before matching", parseInterval(" 45m ").minutes, 45);

const watchGrammar = `--interval must be a number of minutes or look like 30m, 6h or 1d (minutes, hours or days)`;
check("the empty value is refused, naming the input", await deathOf(() => parseInterval("")), `${watchGrammar} — got ""`);
for (const malformed of ["abc", "1.5h", "-5", "5 m", "10mm", " 5x "]) {
  check(`"${malformed}" is refused with the watch grammar`, await deathOf(() => parseInterval(malformed)), `${watchGrammar} — got "${malformed}"`);
}

// --- interval mode: backup requires an explicit unit -------------------------

check("an explicit unit passes in backup mode", [parseInterval("6m", { requireUnit: true }).minutes, parseInterval("6h", { requireUnit: true }).minutes], [6, 360]);
check(
  "a bare value is refused in backup mode, naming the input",
  await deathOf(() => parseInterval("6", { requireUnit: true })),
  `--interval needs an explicit unit; a bare number is minutes only for watch install — got "6"`,
);
check(
  "the nearestUnit hook adds the caller's own suggestions",
  await deathOf(() => parseInterval("6", { requireUnit: true, nearestUnit: (value) => `${value}m` })),
  `--interval needs an explicit unit — nearest valid: 6m; a bare number is minutes only for watch install — got "6"`,
);
check(
  "the empty value takes the grammar refusal, not the bare-value one",
  await deathOf(() => parseInterval("", { requireUnit: true })),
  `--interval must look like 30m, 6h or 1d (an explicit unit is required) — got ""`,
);

// --- the schedule wrapper keeps its scheduler range check --------------------

check("watch's wrapper accepts the shared spellings", [parseIntervalToMinutes("30m"), parseIntervalToMinutes("30")], [30, 30]);
check("backup's wrapper accepts the unit spellings", parseIntervalToMinutes("6h", { bareMinutes: false }), 360);
check("the wrapper refuses an interval no cron line can encode", /no faithful encoding/.test(await deathOf(() => parseIntervalToMinutes("5h"))), true);
check(
  "the wrapper's backup refusal is the shared message verbatim",
  await deathOf(() => parseIntervalToMinutes("6", { bareMinutes: false })),
  `--interval needs an explicit unit — nearest valid: 6m; a bare number is minutes only for watch install — got "6"`,
);
check(
  "the wrapper's watch refusal is the shared message verbatim",
  await deathOf(() => parseIntervalToMinutes("abc")),
  `${watchGrammar} — got "abc"`,
);

// --- threshold mode: .env values ---------------------------------------------

check("3d parses to days in ms", durationMs("3d"), 3 * 86_400_000);
check("36h parses to hours in ms", durationMs("36h"), 36 * 3_600_000);
check("90m parses to minutes in ms", durationMs("90m"), 90 * 60_000);
check("0m is a valid spelling worth zero", durationMs("0m"), 0);
check("a bare number is not a threshold spelling", durationMs("7"), undefined);
check("off is not a threshold spelling of the module", durationMs("off"), undefined);
check("a value with surrounding spaces is not matched untrimmed", durationMs(" 2h "), undefined);

check("unset falls back to the default", parseDurationThreshold("OC_BACKUP_MAX_AGE", undefined, 172_800_000, "2d"), 172_800_000);
check("the consumer trims before applying the grammar", parseDurationThreshold("OC_BACKUP_MAX_AGE", " 2h ", 172_800_000, "2d"), 2 * 3_600_000);
check("0 disables through the consumer", parseDurationThreshold("OC_BACKUP_MAX_AGE", "0", 172_800_000, "2d"), 0);
check("OFF (any case) disables through the consumer", parseDurationThreshold("OC_BACKUP_MAX_AGE", "OFF", 172_800_000, "2d"), 0);
{
  let output = "";
  const result = await withOutputSink(
    (line) => { output += line; },
    () => Promise.resolve(parseDurationThreshold("OC_BACKUP_MAX_AGE", "banana", 172_800_000, "2d")),
  );
  check("garbage falls back to the default", result, 172_800_000);
  checkTrue("the warning names the variable and the raw value", /OC_BACKUP_MAX_AGE/.test(output) && output.includes("banana"));
}
{
  let output = "";
  await withOutputSink(
    (line) => { output += line; },
    () => Promise.resolve(parseDurationThreshold("OC_BACKUP_MAX_AGE", "0", 172_800_000, "2d")),
  );
  checkTrue("disabling is reported, not silent", /OC_BACKUP_MAX_AGE=0/.test(output) && output.includes("disabled"));
}

// --- since mode: logs' --before-compose grammar ------------------------------

for (const valid of ["10m", "2h", "1h30m", "5s", "0m", "2024-01-15", "2024-01-15T10:30:00Z", "2024-01-15 10:30:00", "2024-01-15t10:30:00.123+02:00"]) {
  check(`since accepts ${JSON.stringify(valid)}`, validSince(valid), true);
}
for (const invalid of ["", "abc", "10", "1.5h", "m", "2024-01-15T10:30", "20240115"]) {
  check(`since refuses ${JSON.stringify(invalid)}`, validSince(invalid), false);
}

finish("durations");
