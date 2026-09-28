// A check file opts out of parallel runs with a `// check:exclusive` header line.

import { check, finish } from "#checks/kit/harness.ts";
import { discoverChecks, splitExclusive } from "#checks/kit/discover.ts";

const found = await discoverChecks();
const exclusive = found.filter((entry) => entry.exclusive).map((entry) => entry.label);

check("the dist rebuild runs alone", exclusive.includes("foundation/packaging/build-output.check.ts"), true);
check("an ordinary check stays in the parallel pool", exclusive.includes("foundation/core/env.check.ts"), false);

const { pooled, alone } = splitExclusive(found);
check("every file lands in exactly one group", pooled.length + alone.length, found.length);
check("the exclusive group is exactly the marked files", alone.map((entry) => entry.label), exclusive);

finish("discovery");
