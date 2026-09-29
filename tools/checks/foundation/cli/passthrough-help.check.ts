// Checks that `./clawforge cli --help` shows this framework's own help, like every other
// command, and that only a `--help` placed after a bare `--` reaches the wrapped tool.
//
// U7 (docs/internal/review-2026-09-29-round-13.md): `cli --help` used to always reach
// OpenClaw's own --help unconditionally (the removed passesThroughHelp flag), which meant a
// fresh, never-bootstrapped deployment answered "never been bootstrapped" instead of a help
// screen. requestsHelp (entry/cli.ts) now draws the same before-the-first-`--` boundary
// host's own parser (parseHostArgs) already drew.

import { defineApp } from "#framework/core/app.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { runApp, requestsHelp } from "#framework/entry/cli.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

checkTrue("--help alone requests our own help", requestsHelp(["--help"]));
checkTrue("--help before a later -- still requests our own help", requestsHelp(["--help", "--", "x"]));
check("--help after a -- is the wrapped tool's own, not ours", requestsHelp(["--", "--help"]), false);
check("no --help anywhere requests nothing", requestsHelp(["config", "get", "x"]), false);

const app = defineApp({ name: "passthrough-help-check", description: "fixture", commands: openclawCommands });

let output = "";
await withOutputSink((chunk) => { output += chunk; }, () => runApp(app, ["cli", "--help"]));
check("./clawforge cli --help prints our own summary, not OpenClaw's", output.includes(openclawCommands.cli.summary), true);

finish("passthrough-help");
