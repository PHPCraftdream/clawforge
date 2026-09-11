import assert from "node:assert/strict";
import { configureProvider } from "../../../framework/commands/management/provider.ts";
import type { Context } from "../../../framework/core/context.ts";

const calls: string[][] = [];
const ctx = {
  settings: { dataDir: "/target/data", gatewayPort: "18789" },
  transport: {
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
  exists: async (path: string) => path.endsWith("config/.env"),
  readFile: async () => "VERTEX_TOKEN=secret-value\n",
} } as unknown as Context;
await configureProvider(explicit, ["--provider", "vertex", "--env", "VERTEX_TOKEN"]);
assert.equal(calls.length, 1);
assert.ok(calls[0].includes("models.providers.vertex.apiKey"));
assert.ok(calls[0].includes(JSON.stringify({ source: "env", id: "VERTEX_TOKEN" })));
process.stderr.write("provider configuration checks passed\n");
