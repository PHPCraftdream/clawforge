// The set model, assertion by assertion.
//
// The content id is the set's identity: what installs, updates and compares by. If
// canonicalisation were broken, two machines would build the same content into two
// different ids — and if the id did not move when the content did, a changed set would
// install as if nothing had changed. The secret-value scan exists because "the manifest
// cannot carry values by construction" is a claim that is CHECKED here, not asserted.

import {
  buildSetManifest,
  canonicalJson,
  setManifestId,
  SET_MANIFEST_VERSION,
  DESIRED_STATE_PATH,
} from "../framework/set/model.ts";
import { checksumOfFileMap } from "../framework/checksums.ts";
import type { SetManifest, SetManifestInput, SetRecipe } from "../framework/set/model.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

// A fake instance value: it must never appear in a manifest, but the scan that checks
// that must itself be able to fire when one does.
const fakeValues = ["tok_live_example_123", "sk-demo-9999"];

const mirror = { "server.ts": "a".repeat(64), "data/page.md": "b".repeat(64) };
const agentFiles = { "AGENTS.md": "c".repeat(64), "config.json": "d".repeat(64) };

const agentDeclaration = {
  agentId: "demo",
  mcpServerName: "demo",
  cronJobName: "demo-refresh",
  cronSchedule: "17 3 * * *",
  cronTimeoutSeconds: 900,
};

const agentRecipe: SetRecipe = {
  checksum: checksumOfFileMap(mirror),
  files: mirror,
  agentChecksum: checksumOfFileMap(agentFiles),
  agentFiles,
  agent: agentDeclaration,
};

function input(overrides: Partial<SetManifestInput> = {}): SetManifestInput {
  return {
    name: "demo",
    requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:" + "1".repeat(64) },
    files: {
      [DESIRED_STATE_PATH]: "e".repeat(64),
      "recipes/demo/server.ts": "a".repeat(64),
      "recipes/demo/data/page.md": "b".repeat(64),
      "recipes/demo/agent/AGENTS.md": "c".repeat(64),
      "recipes/demo/agent/cron-message.txt": "f".repeat(64),
    },
    recipes: { demo: agentRecipe },
    secrets: ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY"],
    acceptance: {
      demo: [
        { kind: "mcp_responds", tools: ["demo_search"] },
        { kind: "cron_matches", job: "demo-refresh", schedule: "17 3 * * *" },
        { kind: "agent_answers", usesModel: true, agent: "demo", message: "example" },
      ],
    },
    ...overrides,
  };
}

function manifest(overrides: Partial<SetManifestInput> = {}): SetManifest {
  return buildSetManifest(input(overrides));
}

// Every string anywhere in a value, however deep — what the value scan walks.
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
  } catch {
    return true;
  }
  return false;
}

function carriesValue(manifestValue: SetManifest): boolean {
  const canonical = canonicalJson(manifestValue);
  const strings = stringsOf(manifestValue);
  return fakeValues.some((value) => canonical.includes(value) || strings.includes(value));
}

// --- determinism: the same content, the same id ----------------------------------------------

// Separate literals, keys inserted in a different order — what two machines' builders
// would naturally produce from the same content.
const builtOne = manifest();
const builtTwo = buildSetManifest({
  name: "demo",
  files: {
    "recipes/demo/server.ts": "a".repeat(64),
    [DESIRED_STATE_PATH]: "e".repeat(64),
    "recipes/demo/agent/AGENTS.md": "c".repeat(64),
    "recipes/demo/data/page.md": "b".repeat(64),
    "recipes/demo/agent/cron-message.txt": "f".repeat(64),
  },
  secrets: ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY"],
  recipes: { demo: agentRecipe },
  requires: { image: "ghcr.io/openclaw/openclaw@sha256:" + "1".repeat(64), framework: "0.1.0" },
  acceptance: {
    demo: [
      { kind: "mcp_responds", tools: ["demo_search"] },
      { kind: "cron_matches", job: "demo-refresh", schedule: "17 3 * * *" },
      { kind: "agent_answers", usesModel: true, agent: "demo", message: "example" },
    ],
  },
});
check("the same manifest built twice gives the same id", setManifestId(builtOne) === setManifestId(builtTwo), true);
check("the id is a sha256 digest", /^[0-9a-f]{64}$/.test(setManifestId(builtOne)), true);

// --- the id moves when the content does ---------------------------------------------------------

check(
  "a changed file checksum changes the id",
  setManifestId(manifest({ files: { ...input().files, [DESIRED_STATE_PATH]: "9".repeat(64) } })) !== setManifestId(builtOne),
  true,
);
check(
  "a changed required framework version changes the id",
  setManifestId(manifest({ requires: { framework: "0.2.0", image: input().requires.image } })) !== setManifestId(builtOne),
  true,
);
check(
  "a changed image digest changes the id",
  setManifestId(manifest({ requires: { framework: "0.1.0", image: "ghcr.io/openclaw/openclaw@sha256:" + "2".repeat(64) } })) !==
    setManifestId(builtOne),
  true,
);
check(
  "an added recipe changes the id",
  setManifestId(
    manifest({
      recipes: {
        demo: agentRecipe,
        "demo-two": { checksum: checksumOfFileMap({ "srv.ts": "0".repeat(64) }), files: { "srv.ts": "0".repeat(64) } },
      },
    }),
  ) !== setManifestId(builtOne),
  true,
);
check(
  "a changed secret name changes the id",
  setManifestId(manifest({ secrets: ["OPENCLAW_GATEWAY_TOKEN", "OTHER_KEY"] })) !== setManifestId(builtOne),
  true,
);
check(
  "an added secret name changes the id",
  setManifestId(manifest({ secrets: ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY", "NEW_KEY"] })) !== setManifestId(builtOne),
  true,
);

// --- canonicalisation ---------------------------------------------------------------------------

// A hand-written copy of the built manifest with every object literal's keys reordered:
// if the id moved, the canonicalisation is pretending, not sorting.
{
  const reordered: SetManifest = {
    name: builtOne.name,
    files: {
      "recipes/demo/agent/cron-message.txt": "f".repeat(64),
      "recipes/demo/agent/AGENTS.md": "c".repeat(64),
      "recipes/demo/data/page.md": "b".repeat(64),
      "recipes/demo/server.ts": "a".repeat(64),
      [DESIRED_STATE_PATH]: "e".repeat(64),
    },
    recipes: {
      demo: {
        agent: {
          cronTimeoutSeconds: 900,
          cronSchedule: "17 3 * * *",
          cronJobName: "demo-refresh",
          mcpServerName: "demo",
          agentId: "demo",
        },
        agentFiles: { "config.json": "d".repeat(64), "AGENTS.md": "c".repeat(64) },
        agentChecksum: checksumOfFileMap(agentFiles),
        files: { "data/page.md": "b".repeat(64), "server.ts": "a".repeat(64) },
        checksum: checksumOfFileMap(mirror),
      },
    },
    requires: { image: builtOne.requires.image, framework: builtOne.requires.framework },
    secrets: ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY"],
    acceptance: {
      demo: [
        { kind: "mcp_responds", tools: ["demo_search"] },
        { kind: "cron_matches", job: "demo-refresh", schedule: "17 3 * * *" },
        { kind: "agent_answers", usesModel: true, agent: "demo", message: "example" },
      ],
    },
    version: builtOne.version,
  };
  check("key order in the manifest does not change the id", setManifestId(reordered) === setManifestId(builtOne), true);
}

// The assertion that breaks directly if the recursive key sort is removed.
check("the canonical form is the sorted one", canonicalJson({ b: 1, a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1},"b":1}');
// Optional fields are exactly the kind a caller sets with an ordinary spread, so a field
// set to `undefined` and a field omitted must be the same set: the lock writes its recipe
// entries the omitted way, and a `set build` written the spread way would otherwise
// disagree with it about the id of the same content. agentChecksum, agentFiles and agent
// are the model's only optional fields.
{
  const plain: SetRecipe = { checksum: checksumOfFileMap(mirror), files: mirror };
  const spread: SetRecipe = {
    checksum: checksumOfFileMap(mirror),
    files: mirror,
    agentChecksum: undefined,
    agentFiles: undefined,
    agent: undefined,
  };
  check(
    "an optional field set to undefined and one omitted are the same set",
    setManifestId(manifest({ recipes: { demo: plain } })) === setManifestId(manifest({ recipes: { demo: spread } })),
    true,
  );
  // The cheap invariant that catches this class outright: `undefined` is not JSON, so it
  // must never survive into the canonical form at all.
  check(
    "the canonical form never contains the substring \"undefined\"",
    canonicalJson(manifest({ recipes: { demo: spread } })).includes("undefined"),
    false,
  );
}

// --- secrets are names only ----------------------------------------------------------------------

// The clean case: no fake instance value in the canonical form or in any string of the
// manifest — but the check below proves this scan can actually fire.
check("no secret value appears in the manifest", fakeValues.some((value) => canonicalJson(builtOne).includes(value)), false);
check(
  "no secret value appears in any string of the manifest",
  fakeValues.some((value) => stringsOf(builtOne).includes(value)),
  false,
);
check("the manifest's secrets are the sorted names", [...builtOne.secrets], ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY"]);
check(
  "the scan is not a rubber stamp",
  carriesValue(manifest({ secrets: ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY", "tok_live_example_123"] })),
  true,
);

// --- normalisation by the builder ----------------------------------------------------------------

check(
  "the order and duplication of secret names in the input does not change the id",
  setManifestId(manifest({ secrets: ["ZAI_API_KEY", "OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY"] })) === setManifestId(builtOne),
  true,
);
check(
  "the built manifest's secrets are sorted and deduplicated",
  manifest({ secrets: ["ZAI_API_KEY", "OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY"] }).secrets,
  ["OPENCLAW_GATEWAY_TOKEN", "ZAI_API_KEY"],
);

// --- machine-independence is enforced, not hoped for ----------------------------------------------
//
// Each of these would bake one machine's spelling into the id, or let a key escape the
// deployment directory; the builder refuses them rather than canonicalising them away.

check(
  "an absolute POSIX path in files is refused",
  throws(() => buildSetManifest(input({ files: { "/srv/openclaw/recipes/demo/server.ts": "a".repeat(64) } }))),
  true,
);
check(
  "a Windows drive path in files is refused",
  throws(() => buildSetManifest(input({ files: { "D:\\dev\\apps\\demo\\config\\desired-state.json": "e".repeat(64) } }))),
  true,
);
check(
  "a .. escape in files is refused",
  throws(() => buildSetManifest(input({ files: { "recipes/../secrets/demo.env": "f".repeat(64) } }))),
  true,
);
check(
  "a backslash separator in files is refused",
  throws(() => buildSetManifest(input({ files: { "recipes\\demo\\server.ts": "a".repeat(64) } }))),
  true,
);
check(
  "an empty path key in files is refused",
  throws(() => buildSetManifest(input({ files: { "": "e".repeat(64) } }))),
  true,
);
check(
  "an absolute path inside a recipe's files is refused",
  throws(() =>
    buildSetManifest(input({ recipes: { demo: { ...agentRecipe, files: { "/etc/demo/server.ts": "a".repeat(64) } } } })),
  ),
  true,
);

// --- shape invariants ------------------------------------------------------------------------------

check("the config declaration enters the file map by its deployment-relative path", Object.keys(builtOne.files).includes(DESIRED_STATE_PATH), true);
check("the manifest carries the set format version", builtOne.version, SET_MANIFEST_VERSION);

process.stderr.write(failed === 0 ? "all set model checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
