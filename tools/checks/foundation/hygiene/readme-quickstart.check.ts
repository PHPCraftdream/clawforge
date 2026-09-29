// README's Quick start must not claim a fixed web interface port: new-app writes
// OPENCLAW_GATEWAY_PORT from 20000-32767, so a hardcoded 18789 sends an operator to the
// wrong address (docs/internal/review-2026-09-29-round-13.md, U8). It must still point at
// how to find the real one (./clawforge status).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const readme = await readFile(resolve(monorepoRoot, "README.md"), "utf8");

const start = readme.indexOf("## Quick start");
check("README has a Quick start section", start !== -1, true);
const nextHeading = readme.indexOf("\n## ", start + 1);
const quickStart = readme.slice(start, nextHeading === -1 ? readme.length : nextHeading);

check("the Quick start section names no fixed gateway port", quickStart.includes("18789"), false);
checkTrue("...and instead points at status to find the real one", quickStart.includes("./clawforge status") || quickStart.includes("`status`"));

finish("readme-quickstart");
