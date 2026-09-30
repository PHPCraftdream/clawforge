import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "#framework/core/context.ts";
import type { Context } from "#framework/core/context.ts";
import type { AppCommand } from "#framework/core/app.ts";
import { hostPlatform } from "#framework/runtime/transport/transport.ts";
import { inspect, doctor } from "#framework/commands/orchestration/inspect/gather.ts";
import { plan } from "#framework/commands/orchestration/plan.ts";
import { serveMcp } from "#framework/integration/mcp/server.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "../fixture.ts";

// Fictional authorities only. The controlled runtime below never performs a probe.
export const credentialCases = [
  { label: "space", scheme: "https://", password: "FAKE SPACE PASSWORD", host: "provider.example" },
  { label: "username-space", scheme: "https://", password: "FAKE USERSUFFIX", host: "provider.example" },
  { label: "extra-slashes", scheme: "https:////", password: "FAKE EXTRASUFFIX", host: "provider.example" },
  { label: "mixed-slashes", scheme: "https:/\\", password: "FAKE MIXEDSUFFIX", host: "provider.example" },
  { label: "malformed-separators", scheme: "https: / /", password: "FAKE SEPARATORSUFFIX", host: "broken host" },
  { label: "tab", scheme: "https://", password: "FAKE\tTABSUFFIX", host: "provider.example" },
  { label: "lf", scheme: "https://", password: "FAKE\nLFSUFFIX", host: "provider.example" },
  { label: "cr", scheme: "https://", password: "FAKE\rCRSUFFIX", host: "provider.example" },
  { label: "encoded", scheme: "https://", password: "FAKE%20ENCODEDSUFFIX", host: "provider.example" },
  { label: "backslash", scheme: "https:\\\\", password: "FAKE BACKSLASHSUFFIX", host: "provider.example" },
  { label: "missing-slashes", scheme: "https:", password: "FAKE MISSINGSLASHSUFFIX", host: "provider.example" },
  { label: "scheme-controls", scheme: "ht\ttps:/\n/", password: "FAKE SCHEMESUFFIX", host: "provider.example" },
  { label: "malformed", scheme: "https://", password: "FAKE MALFORMEDSUFFIX", host: "broken host" },
].map(({ label, scheme, password, host }) => ({
  label,
  username: label === "username-space" ? "fictional user name" : `fictional-${label}-user`,
  password,
  url: `${scheme}${label === "username-space" ? "fictional user name" : `fictional-${label}-user`}:${password}@${host}/v1?view=brief&api_key=FAKE_QUERY_SECRET&api_key=FAKE_REPEAT_SECRET&access%5Ftoken=FAKE_ENCODED_SECRET#FAKE_FRAGMENT_SECRET`,
}));

export const unknownDiagnosticUrl = "https://unknown-fictional-user:FAKE UNKNOWN SUFFIX@diagnostic.example/detail?region=demo&token=FAKE_DETAIL_TOKEN#FAKE_DETAIL_FRAGMENT";

// Runnable offline proof: node --experimental-strip-types <this-file> inspect --json
// or pipe tools/call JSON-RPC lines into the same executable with control-mcp.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Explicit POSIX-target seam on Windows; no target process or filesystem is accessed.
  hostPlatform.current = "linux";
  const fixture = await setupFixtureDeployment();
  try {
    await writeFile(resolve(fixture.deployment, ".env"), "OC_TARGET_LOCATION=local\nOC_DATA_DIR=/srv/clawforge/data\nOC_BACKUP_DIR=/srv/clawforge/backups\nOC_COMPOSE_PROJECT=credential-fixture\nOPENCLAW_GATEWAY_TOKEN=fixture-gateway-token\n");
    const endpoints = [...credentialCases.map(({ url }) => url), "socks5h://fictional-proxy-user:FAKE PROXY SUFFIX@proxy.example:9050/connect?region=demo&auth=FAKE_PROXY_TOKEN"];
    const base = fixture.stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: fixture.goodChecksums,
      liveConfig: {
        models: { providers: Object.fromEntries(credentialCases.map(({ label, url }) => [label, { baseUrl: url }])) },
        channels: { synthetic: { proxy: endpoints.at(-1) } },
      },
    });
    const controlled = (ctx: Context): Context => {
      // Keep the full real Context/Transport surface; replace only controlled observations.
      Object.assign(ctx.transport, base.transport);
      Object.assign(ctx.runtime, base.runtime, {
        async execCommand(_service: string, _command: string, _args: string[], options: { input?: string | Uint8Array } = {}) {
          const input = options.input ?? "[]";
          const urls = JSON.parse(typeof input === "string" ? input : Buffer.from(input).toString("utf8")) as string[];
          if (JSON.stringify(urls) !== JSON.stringify(endpoints)) throw new Error("original private probe input changed");
          return { code: 0, stdout: JSON.stringify(urls.map((url) => ({ url, state: "dns", detail: `failed ${url}; error: ${unknownDiagnosticUrl} E_SYNTHETIC` }))), stderr: "" };
        },
      });
      return ctx;
    };
    const commands: Record<string, AppCommand> = Object.fromEntries(Object.entries({ inspect, doctor, plan }).map(([name, run]) => [name, {
      summary: name, readOnly: true, structured: true,
      arguments: [{ name: "json", kind: "flag", description: "JSON output" }],
      run: (ctx: Context, args: string[]) => run(controlled(ctx), args),
    }]));
    const mode = process.argv[2] ?? "inspect";
    if (mode === "control-mcp") await serveMcp({ name: "credential-fixture", description: "Offline credential diagnostic fixture", commands });
    else {
      const command = commands[mode];
      if (command === undefined) throw new Error(`unknown fixture command: ${mode}`);
      await command.run(await createContext(), process.argv.slice(3));
    }
  } finally { await teardownFixtureDeployment(fixture.deployment); }
}
