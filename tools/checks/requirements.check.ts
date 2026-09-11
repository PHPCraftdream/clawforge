// Checks secret discovery, location, presence and rendering end to end.
//
// No target: openclaw.json content and the target .env are supplied by a stub transport.
// Assertions compare the actual returned arrays/objects/strings, not just "did not throw".
// collectConfiguredProviders() is not exported (it is an internal helper of requirements()),
// so its two sources (models.providers, auth.profiles) and their dedup are exercised
// indirectly through requirements() instead of by direct import.

import { collectSecretRefs, requirements, status, missing, template } from "../framework/secrets.ts";
import type { SecretRequirement, SecretStatus } from "../framework/secrets.ts";
import type { Context } from "../framework/context.ts";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    process.stderr.write(`  ok   ${name}\n`);
    return;
  }
  failed += 1;
  process.stderr.write(
    `  FAIL ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}\n`,
  );
}

// --- collectSecretRefs: nested object -------------------------------------------

check(
  "collectSecretRefs finds a ref nested three levels deep",
  collectSecretRefs({ gateway: { auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } } }),
  [{ name: "OPENCLAW_GATEWAY_TOKEN", usedBy: "gateway.auth.token" }],
);

// --- collectSecretRefs: array -----------------------------------------------------

check(
  "collectSecretRefs finds refs inside an array, indexed in usedBy",
  collectSecretRefs({ list: [{ source: "env", id: "FOO" }, { source: "env", id: "BAR" }] }),
  [
    { name: "FOO", usedBy: "list[0]" },
    { name: "BAR", usedBy: "list[1]" },
  ],
);

// --- requirements()/status(): stub Context --------------------------------------

const DATA_DIR = "/srv/openclaw/data";
const CONFIG_PATH = `${DATA_DIR}/config/openclaw.json`;
const TARGET_ENV_PATH = `${DATA_DIR}/config/.env`;

function makeCtx(options: {
  configExists?: boolean;
  config?: unknown;
  repoEnv?: Record<string, string>;
  targetEnvExists?: boolean;
  targetEnvText?: string;
}): Context {
  const { configExists = true, config = {}, repoEnv = {}, targetEnvExists = false, targetEnvText = "" } = options;
  return {
    settings: { dataDir: DATA_DIR, env: repoEnv },
    transport: {
      description: "stub",
      async exists(path: string): Promise<boolean> {
        if (path === CONFIG_PATH) return configExists;
        if (path === TARGET_ENV_PATH) return targetEnvExists;
        return false;
      },
      async readFile(path: string): Promise<string> {
        if (path === CONFIG_PATH) return JSON.stringify(config);
        if (path === TARGET_ENV_PATH) return targetEnvText;
        return "";
      },
      async writeFile(): Promise<void> {},
      async mkdirp(): Promise<void> {},
      async remove(): Promise<void> {},
      async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  } as unknown as Context;
}

const GATEWAY_CONFIG = { gateway: { auth: { token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } } };
const OTHER_REF_CONFIG = { provider: { key: { source: "env", id: "SOME_OTHER_VAR" } } };

// --- requirements(): no config -> no requirements --------------------------------

check(
  "requirements is empty when openclaw.json does not exist",
  await requirements(makeCtx({ configExists: false })),
  [],
);

// --- requirements(): gateway token ref lands in repo-env --------------------------

check(
  "the gateway token ref is located in repo-env",
  await requirements(makeCtx({ config: GATEWAY_CONFIG })),
  [{ name: "OPENCLAW_GATEWAY_TOKEN", location: "repo-env", usedBy: "gateway.auth.token", required: true }],
);

// --- requirements(): any other ref lands in target-env -----------------------------

check(
  "a non-gateway ref is located in target-env",
  await requirements(makeCtx({ config: OTHER_REF_CONFIG })),
  [{ name: "SOME_OTHER_VAR", location: "target-env", usedBy: "provider.key", required: true }],
);

// --- requirements(): provider configured via models.providers ----------------------

check(
  "a provider configured via models.providers adds its conventional key",
  await requirements(makeCtx({ config: { models: { providers: { zai: {} } } } })),
  [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true }],
);

// --- requirements(): provider configured via auth.profiles -------------------------

check(
  "a provider configured via auth.profiles (id before ':') adds its conventional key",
  await requirements(makeCtx({ config: { auth: { profiles: { "zai:default": {} } } } })),
  [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true }],
);

// --- requirements(): both paths configuring the same provider is not duplicated -----

check(
  "the same provider configured via both paths yields exactly one requirement",
  await requirements(
    makeCtx({ config: { models: { providers: { zai: {} } }, auth: { profiles: { "zai:default": {} } } } }),
  ),
  [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true }],
);

// --- requirements(): dedup by name between an explicit ref and a configured provider -

check(
  "an explicit SecretRef and a configured provider for the same name yield exactly one entry",
  await requirements(
    makeCtx({
      config: {
        models: { providers: { zai: {} } },
        provider: { key: { source: "env", id: "ZAI_API_KEY" } },
      },
    }),
  ),
  [{ name: "ZAI_API_KEY", location: "target-env", usedBy: "provider.key", required: true }],
);

// --- status(): repo-env presence follows ctx.settings.env --------------------------

check(
  "a repo-env requirement is present when settings.env carries a non-blank value",
  await status(makeCtx({ config: GATEWAY_CONFIG, repoEnv: { OPENCLAW_GATEWAY_TOKEN: "abc123" } })),
  [
    {
      name: "OPENCLAW_GATEWAY_TOKEN",
      location: "repo-env",
      usedBy: "gateway.auth.token",
      required: true,
      present: true,
    },
  ],
);

check(
  "a repo-env requirement is absent when settings.env lacks the key",
  await status(makeCtx({ config: GATEWAY_CONFIG, repoEnv: {} })),
  [
    {
      name: "OPENCLAW_GATEWAY_TOKEN",
      location: "repo-env",
      usedBy: "gateway.auth.token",
      required: true,
      present: false,
    },
  ],
);

check(
  "a repo-env value that is blank after trim counts as absent",
  (await status(makeCtx({ config: GATEWAY_CONFIG, repoEnv: { OPENCLAW_GATEWAY_TOKEN: "   " } })))[0]?.present,
  false,
);

// --- status(): target-env is read from <dataDir>/config/.env on the target ---------

check(
  "a target-env requirement is present when the target .env has a value",
  await status(makeCtx({ config: OTHER_REF_CONFIG, targetEnvExists: true, targetEnvText: "SOME_OTHER_VAR=value123\n" })),
  [
    {
      name: "SOME_OTHER_VAR",
      location: "target-env",
      usedBy: "provider.key",
      required: true,
      present: true,
    },
  ],
);

check(
  "target-env is treated as empty when the target .env file does not exist",
  await status(makeCtx({ config: OTHER_REF_CONFIG, targetEnvExists: false })),
  [
    {
      name: "SOME_OTHER_VAR",
      location: "target-env",
      usedBy: "provider.key",
      required: true,
      present: false,
    },
  ],
);

// --- missing(): required and not present --------------------------------------------

const statusEntries: SecretStatus[] = [
  { name: "A", location: "repo-env", usedBy: "x", required: true, present: true },
  { name: "B", location: "target-env", usedBy: "y", required: true, present: false },
  { name: "C", location: "target-env", usedBy: "z", required: false, present: false },
];

check("missing filters to entries that are required and not present", missing(statusEntries), [
  { name: "B", location: "target-env", usedBy: "y", required: true, present: false },
]);

// --- template(): section headers, used-by comments, bare NAME= lines ----------------

const templateEntries: SecretRequirement[] = [
  { name: "OPENCLAW_GATEWAY_TOKEN", location: "repo-env", usedBy: "gateway.auth.token", required: true },
  { name: "ZAI_API_KEY", location: "target-env", usedBy: "provider zai", required: true },
];

const expectedTemplate =
  "# Secrets required by this OpenClaw instance.\n" +
  "# Values are intentionally absent: fill them in on the target.\n" +
  "#\n" +
  "# repo-env    -> .env next to the repository (passed into the container by the runtime)\n" +
  "# target-env  -> <data>/config/.env on the target (read by OpenClaw itself)\n" +
  "\n" +
  "# --- repo-env ---\n" +
  "# used by: gateway.auth.token\n" +
  "OPENCLAW_GATEWAY_TOKEN=\n" +
  "\n" +
  "# --- target-env ---\n" +
  "# used by: provider zai\n" +
  "ZAI_API_KEY=\n";

check(
  "template renders both sections with headers, used-by comments and bare NAME= lines",
  template(templateEntries),
  expectedTemplate,
);

check(
  "template omits a location's section header entirely when it has no entries",
  template([{ name: "OPENCLAW_GATEWAY_TOKEN", location: "repo-env", usedBy: "gateway.auth.token", required: true }]).includes(
    "# --- target-env ---",
  ),
  false,
);

process.stderr.write(failed === 0 ? "all requirements checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
