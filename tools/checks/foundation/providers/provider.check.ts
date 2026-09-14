import assert from "node:assert/strict";
import { configureProvider } from "../../../framework/commands/management/provider.ts";
import type { Context } from "../../../framework/core/context.ts";

const calls: string[][] = [];
// configure-provider now takes the instance lock (#186) — a plain mkdir is the atomic claim
// takeLock() makes; harmless here since nothing else is contending for it in these checks.
const noContention = {
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  writeFile: async () => {},
  remove: async () => {},
};
const ctx = {
  settings: { dataDir: "/target/data", gatewayPort: "18789" },
  transport: {
    ...noContention,
    exists: async (path: string) => path.endsWith("config/.env") || path.endsWith("openclaw.json"),
    readFile: async (path: string) => path.endsWith("openclaw.json")
      ? JSON.stringify({ models: { providers: { custom: {} } } })
      : "CUSTOM_API_KEY=secret-value\n",
  },
  runtime: { runOneOff: async (_service: string, args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; } },
} as unknown as Context;

await configureProvider(ctx, []);
assert.equal(calls.length, 1);
assert.deepEqual(calls[0].slice(0, 4), ["dist/index.js", "config", "set", "models.providers.custom.apiKey"]);
assert.ok(calls[0].includes(JSON.stringify({ source: "env", id: "CUSTOM_API_KEY" })));
assert.ok(!calls.flat().includes("secret-value"));

calls.length = 0;
const explicit = { ...ctx, transport: {
  ...noContention,
  exists: async (path: string) => path.endsWith("config/.env"),
  readFile: async () => "VERTEX_TOKEN=secret-value\n",
} } as unknown as Context;
await configureProvider(explicit, ["--provider", "vertex", "--env", "VERTEX_TOKEN"]);
assert.equal(calls.length, 1);
assert.ok(calls[0].includes("models.providers.vertex.apiKey"));
assert.ok(calls[0].includes(JSON.stringify({ source: "env", id: "VERTEX_TOKEN" })));

// Regression: --provider openai --env OPENAI_API_KEY must touch only openai, even when
// another provider's key (ANTHROPIC_API_KEY) is also present in the secrets file. Before
// the fix, the auto-discovery loop over secrets ran unconditionally and folded anthropic
// into the same pass, repointing it at OPENAI_API_KEY too.
calls.length = 0;
const twoKeys = { ...ctx, transport: {
  ...noContention,
  exists: async (path: string) => path.endsWith("config/.env") || path.endsWith("openclaw.json"),
  readFile: async (path: string) => path.endsWith("openclaw.json")
    ? JSON.stringify({ models: { providers: { openai: {}, anthropic: {} } } })
    : "OPENAI_API_KEY=openai-secret\nANTHROPIC_API_KEY=anthropic-secret\n",
} } as unknown as Context;
await configureProvider(twoKeys, ["--provider", "openai", "--env", "OPENAI_API_KEY"]);
assert.equal(calls.length, 1, "only one provider must be reconfigured");
assert.ok(calls[0].includes("models.providers.openai.apiKey"), "the named provider is the one touched");
assert.ok(!calls.flat().some((arg) => arg.includes("anthropic")), "the other provider must not be mentioned at all");

// Auto-discovery (no --provider) must still sweep every provider it finds a key for — the
// fix scopes the loop to the explicit-provider case, it must not remove discovery itself.
calls.length = 0;
await configureProvider(twoKeys, []);
assert.equal(calls.length, 2, "auto-discovery still configures every provider it found a key for");
const touched = calls.map((call) => call[3]).sort();
assert.deepEqual(touched, ["models.providers.anthropic.apiKey", "models.providers.openai.apiKey"]);

// Regression: auto-discovery must not mint a second, differently-punctuated provider id
// from an env var name. "custom-proxy" is already configured; CUSTOM_PROXY_API_KEY converts
// back to "custom_proxy" (underscored) if read blindly — a distinct id that would get its
// own apiKey-only provider object with none of custom-proxy's declared settings.
calls.length = 0;
const dashedProvider = { ...ctx, transport: {
  ...noContention,
  exists: async (path: string) => path.endsWith("config/.env") || path.endsWith("openclaw.json"),
  readFile: async (path: string) => path.endsWith("openclaw.json")
    ? JSON.stringify({ models: { providers: { "custom-proxy": {} } } })
    : "CUSTOM_PROXY_API_KEY=proxy-secret\n",
} } as unknown as Context;
await configureProvider(dashedProvider, []);
assert.equal(calls.length, 1, "only the already-configured provider is touched, not a second minted one");
assert.ok(calls[0].includes("models.providers.custom-proxy.apiKey"), "the real, hyphenated id is used");
assert.ok(!calls.flat().some((arg) => arg.includes("custom_proxy")), "no underscored duplicate is ever created");

// Regression: a provider whose apiKey is already an explicit, non-env SecretRef (file/exec/
// store) must not be silently replaced by a conventional env ref without --force.
// providerSecretVariable only recognizes the env case, so "current" reads as undefined for
// a file ref — that must not be mistaken for "nothing set yet".
calls.length = 0;
const fileRefProvider = { ...ctx, transport: {
  ...noContention,
  exists: async (path: string) => path.endsWith("config/.env") || path.endsWith("openclaw.json"),
  readFile: async (path: string) => path.endsWith("openclaw.json")
    ? JSON.stringify({ models: { providers: { custom: { apiKey: { source: "file", provider: "vault", id: "/key" } } } } })
    : "CUSTOM_API_KEY=secret-value\n",
} } as unknown as Context;
await configureProvider(fileRefProvider, []);
assert.equal(calls.length, 0, "an explicit file-ref apiKey is left alone without --force");

calls.length = 0;
await configureProvider(fileRefProvider, ["--force"]);
assert.equal(calls.length, 1, "--force does replace it");
assert.ok(calls[0].includes("models.providers.custom.apiKey"));

// Regression: configure-provider must respect the instance lock, not bypass it. Before the
// fix, it wrote models.providers.<id>.apiKey with no takeLock()/guarded() call at all.
{
  const holder = JSON.stringify({ operationId: "op-holder", what: "apply", by: "someone@host pid 1", takenAt: new Date().toISOString() });
  const lockedCtx = { ...ctx, transport: {
    ...noContention,
    exists: async (path: string) => path.endsWith("config/.env") || path.endsWith("openclaw.json"),
    readFile: async (path: string) => {
      if (path.endsWith("holder.json")) return holder;
      return path.endsWith("openclaw.json")
        ? JSON.stringify({ models: { providers: { custom: {} } } })
        : "CUSTOM_API_KEY=secret-value\n";
    },
    exec: async (command: string, args: string[]) => {
      if (command === "mkdir" && args[0] !== "-p") return { code: 1, stdout: "", stderr: "" };
      if (command === "test" && args[0] === "-d") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  } } as unknown as Context;

  calls.length = 0;
  let refused = "";
  try {
    await configureProvider(lockedCtx, []);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  assert.ok(refused.includes("another operation is changing this instance"), "configure-provider refuses when another operation already holds the instance lock");
  assert.equal(calls.length, 0, "a refused configure-provider never writes the config");
}

process.stderr.write("provider configuration checks passed\n");
