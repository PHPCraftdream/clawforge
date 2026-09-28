// Import for fixtures that build a `local` target but never run target commands: it makes
// createTransport treat the host as Linux, in this process and (through NODE_OPTIONS) in
// every child process the fixture spawns.

import { hostPlatform } from "#framework/runtime/transport/transport.ts";

hostPlatform.current = "linux";

const preload = `--import=${import.meta.url}`;
const options = process.env.NODE_OPTIONS ?? "";
if (!options.includes(preload)) process.env.NODE_OPTIONS = `${options} ${preload}`.trim();
