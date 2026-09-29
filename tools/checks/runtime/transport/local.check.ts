// check:requires linux-host
// The shared transport contract (scenarios/contract.ts) against a real LocalTransport — only
// meaningful on a Linux host, since LocalTransport itself refuses everywhere else (see
// local-target-unsupported.check.ts, docs/guide/requirements.md). Runs for real under
// `npm run check:linux` (Docker, the official node:24 image) and on a native Linux host;
// skipped elsewhere via the linux-host capability.

import { LocalTransport } from "#framework/runtime/transport/transport.ts";
import { runTransportScenarios } from "./scenarios/contract.ts";
import { finish } from "#checks/kit/harness.ts";

await runTransportScenarios("local", () => new LocalTransport());

finish("transport contract: local");
