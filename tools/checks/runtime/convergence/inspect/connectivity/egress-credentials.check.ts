import { gatherInspection } from "#framework/commands/orchestration/inspect/gather.ts";
import { orchestrationCommands } from "#framework/commands/interface/groups/openclawCommands.orchestration.ts";
import { redactEndpoint, redactEndpointText, publicConfigValue } from "#framework/commands/orchestration/inspect/helpers.ts";
import { computePlan } from "#framework/commands/orchestration/plan.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { fileURLToPath } from "node:url";
import { credentialCases, unknownDiagnosticUrl } from "./credential-consumer.fixture.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "../fixture.ts";
import type { ExecOptions } from "#framework/runtime/transport/transport.ts";
import { check, finish } from "#checks/kit/harness.ts";

const providerUrl = "https://inline-user:inline-password@provider.example/v1/models?api_key=inline-api-key&view=brief&api_key=duplicate-api-key&access%5Ftoken=encoded-access-token#opaque-fragment-token";
const proxyUrl = "socks5h://proxy-user:proxy-password@proxy.example:9050/connect?PaSsWoRd=inline-query-password&auth=inline-auth&region=demo#access_token=fragment-access-token";
const publicProvider = "https://***@provider.example/v1/models?api_key=***&view=brief&api_key=***&access%5Ftoken=***#***";
const publicProxy = "socks5h://***@proxy.example:9050/connect?PaSsWoRd=***&auth=***&region=demo#***";
const secrets = ["inline-user", "inline-password", "inline-api-key", "duplicate-api-key", "encoded-access-token", "opaque-fragment-token", "proxy-user", "proxy-password", "inline-query-password", "inline-auth", "fragment-access-token"];

check("provider URL preserves host/path and ordinary query", redactEndpoint(providerUrl), publicProvider);
check("proxy URL shares the same credential policy", redactEndpoint(proxyUrl), publicProxy);
check("safe URL remains unchanged", redactEndpoint("https://provider.example/v1?view=brief"), "https://provider.example/v1?view=brief");
check("sanitizer is idempotent", redactEndpoint(publicProvider), publicProvider);
check("credentials in malformed URLs also disappear", redactEndpoint("https://user:pass@broken host/v1?token=broken-value#fragment-value"), "https://***@broken host/v1?token=***#***");
check("percent-encoded key and signature credentials disappear", redactEndpoint("https://provider.example/v1?%61pi_key=secret&signature=signed&key=other&v=1"), "https://provider.example/v1?%61pi_key=***&signature=***&key=***&v=1");
check("archive-recognized credential key names share the public URL policy", redactEndpoint("https://provider.example/v1?auth_key=auth-value&encryptionKey=encrypt-value&signing-key-id=sign-value"), "https://provider.example/v1?auth_key=***&encryptionKey=***&signing-key-id=***");
check("config URL redaction uses the same fragment policy", publicConfigValue("endpoint", providerUrl), "[redacted]");
check("standalone config URLs without an authority still redact credential queries", publicConfigValue("endpoint", "custom:route?access_token=opaque-value"), "[redacted]");
check("diagnostics preserve surrounding punctuation", redactEndpointText(`failed (${providerUrl}), retry`), `failed (${publicProvider}), retry`);
check("malformed endpoint diagnostics use the known original URL", redactEndpointText("failed https://bad host/v1?token=broken-value", "https://bad host/v1?token=broken-value"), "failed https://bad host/v1?token=***");
check("URL query punctuation cannot expose credential suffixes", redactEndpointText("failed https://provider.example/v1?token=prefix)private-tail"), "failed https://provider.example/v1?token=***");
check("an error prefix cannot swallow a credential URI", redactEndpointText(`error: ${unknownDiagnosticUrl}`).includes("UNKNOWN SUFFIX"), false);
check("an error prefix preserves the diagnostic host/path", redactEndpointText(`error: ${unknownDiagnosticUrl}`).includes("diagnostic.example/detail"), true);
check("malformed standalone config URL still hides credential query", publicConfigValue("endpoint", "https://broken host/v1?token=FAKE_CONFIG_TOKEN"), "[redacted]");
check("nested literal URI credentials remain masked", redactEndpoint("https://provider.example/v1?forward=https://nested-user:NESTED_PASSWORD@other.example/path"), "https://provider.example/v1?forward=https://***@other.example/path");
check("ignored controls in query names preserve credential policy", redactEndpoint("https://provider.example/v1?api_\tkey=FAKE_QUERY_CONTROL&view=brief"), "https://provider.example/v1?api_\tkey=***&view=brief");
for (const entry of credentialCases) {
  const publicUrl = redactEndpoint(entry.url);
  check(`${entry.label}: raw authority and password suffix disappear`, publicUrl.includes(entry.username) || publicUrl.includes(entry.password.split(/\s|%20/).at(-1)!), false);
  check(`${entry.label}: useful path and ordinary query survive`, publicUrl.includes("/v1?view=brief&api_key=***&api_key=***&access%5Ftoken=***#***"), true);
  check(`${entry.label}: unknown diagnostic URL crosses whitespace safely`, redactEndpointText(`failed (${entry.url}), retry`), `failed (${publicUrl}), retry`);
}

/** Captures terminal writers without changing command output mode. */
async function terminalOutput(body: () => Promise<void>): Promise<string> {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let text = "";
  const collect = ((chunk: string | Uint8Array): boolean => {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = collect;
  process.stderr.write = collect;
  try { await body(); }
  finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return text;
}

const { deployment, stubContext, goodChecksums } = await setupFixtureDeployment();
try {
  for (const state of ["ok", "dns", "unreachable", "invalid", "timeout"] as const) {
    for (const entry of [{ label: "prior-query-policy", url: providerUrl, username: "inline-user", password: "inline-password" }, ...credentialCases]) {
    const providerUrl = entry.url;
    const publicProvider = redactEndpoint(providerUrl);
    let normalizedPassword = entry.password;
    try { normalizedPassword = new URL(providerUrl).password; } catch { /* Malformed authority still needs masking. */ }
    const forbidden = [...secrets, entry.username, encodeURIComponent(entry.username), entry.password, normalizedPassword, entry.password.split(/\s|%20/).at(-1)!];
    const base = stubContext({
      targetEnv: "ZAI_API_KEY=k\n",
      mirrorChecksums: goodChecksums,
      liveConfig: {
        models: { providers: { zai: {}, synthetic: { baseUrl: providerUrl } } },
        channels: { synthetic: { proxy: proxyUrl } },
      },
    });
    const inputs: string[][] = [];
    const ctx = {
      ...base,
      runtime: {
        ...base.runtime,
        async execCommand(_service: string, _command: string, _args: string[], options: ExecOptions = {}) {
          const input = options.input ?? "[]";
          const urls = JSON.parse(typeof input === "string" ? input : Buffer.from(input).toString("utf8")) as string[];
          inputs.push(urls);
          return {
            code: 0,
            stdout: JSON.stringify(urls.map((url) => ({ url, state, detail: `probe diagnostic ${url} E_SYNTHETIC; error: ${unknownDiagnosticUrl}` }))),
            stderr: "",
          };
        },
      },
    };
    const inspection = await gatherInspection(ctx);
    check(`${state}: live-only endpoints are probed with original credentials`, inputs[0], [providerUrl, proxyUrl]);
    check(`${state}: observations retain host/path and redact credentials`, inspection.observed.egress?.map((entry) => entry.endpoint), [publicProvider, publicProxy]);
    check(`${state}: endpoint status remains diagnostic`, inspection.observed.egress?.map((entry) => entry.state), [state, state]);
    check(`${state}: probe detail preserves diagnostic host/path`, inspection.observed.egress?.every((entry) => entry.detail?.includes("diagnostic.example/detail")), true);
    const findings = inspection.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE");
    check(`${state}: failures retain their findings`, findings.length, state === "ok" ? 0 : 2);

    const terminalText = await terminalOutput(() => orchestrationCommands.inspect.run(ctx, []));
    const terminalJson = await terminalOutput(() => orchestrationCommands.inspect.run(ctx, ["--json"]));
    const doctorText = await terminalOutput(async () => {
      try { await orchestrationCommands.doctor.run(ctx, []); }
      catch { /* Fixture-only blocking findings are still printed. */ }
    });
    const doctorJson = await terminalOutput(async () => {
      try { await orchestrationCommands.doctor.run(ctx, ["--json"]); }
      catch { /* Fixture-only blocking findings are still printed. */ }
    });
    const planText = await terminalOutput(() => orchestrationCommands.plan.run(ctx, []));
    const planJson = await terminalOutput(() => orchestrationCommands.plan.run(ctx, ["--json"]));
    const computed = await computePlan(ctx);
    const doctorPayload = JSON.parse(doctorJson) as { problems: { code: string }[] };
    check(`${state}: doctor JSON retains failed endpoint diagnostics`, doctorPayload.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE").length, findings.length);
    check(`${state}: plan retains failed endpoint diagnostics`, computed.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE").length, findings.length);
    const inspectPayload = JSON.parse(terminalJson) as { observed: { egress: { endpoint: string; state: string }[] } };
    check(`${state}: inspect JSON preserves useful endpoints and status`, inspectPayload.observed.egress.map(({ endpoint, state }) => ({ endpoint, state })), [{ endpoint: publicProvider, state }, { endpoint: publicProxy, state }]);
    const planPayload = JSON.parse(planJson) as { problems: { code: string }[] };
    check(`${state}: plan JSON retains failed endpoint diagnostics`, planPayload.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE").length, findings.length);
    if (state !== "ok") {
      check(`${state}: doctor text retains diagnostic host/path`, doctorText.includes("/v1") && doctorText.includes("proxy.example:9050/connect"), true);
      check(`${state}: plan text retains diagnostic host/path`, planText.includes("/v1") && planText.includes("proxy.example:9050/connect"), true);
    }
    check(`${state}: terminal text contains sanitized egress`, terminalText.includes(publicProvider) && terminalText.includes(publicProxy), true);
    const outputs = { inspection: JSON.stringify(inspection), terminalText, terminalJson, doctorText, doctorJson, planText, planJson, plan: JSON.stringify(computed) };
    for (const [name, text] of Object.entries(outputs)) {
      check(`${entry.label}/${state}: ${name} excludes every unregistered inline credential`, [...forbidden, "unknown-fictional-user", "UNKNOWN SUFFIX", "SUFFIX", "FAKE_DETAIL_TOKEN", "FAKE_DETAIL_FRAGMENT"].filter((secret) => text.includes(secret)), []);
    }
    check(`${state}: all diagnostic calls retain original probe input`, inputs.every((urls) => urls[0] === providerUrl && urls[1] === proxyUrl), true);
    }
  }
} finally {
  await teardownFixtureDeployment(deployment);
}
const executableFixture = fileURLToPath(new URL("./credential-consumer.fixture.ts", import.meta.url));
const forbidden = [
  ...credentialCases.flatMap(({ username, password, url }) => {
    let normalized = password;
    try { normalized = new URL(url).password; } catch { /* Invalid URL uses raw fallback. */ }
    return [username, encodeURIComponent(username), password, normalized, password.split(/\s|%20/).at(-1)!];
  }),
  "fictional-proxy-user", "PROXY SUFFIX", "SUFFIX", "FAKE_PROXY_TOKEN",
  "unknown-fictional-user", "UNKNOWN SUFFIX", "FAKE_DETAIL_TOKEN", "FAKE_DETAIL_FRAGMENT",
  "FAKE_QUERY_SECRET", "FAKE_REPEAT_SECRET", "FAKE_ENCODED_SECRET", "FAKE_FRAGMENT_SECRET",
];
for (const command of ["inspect", "doctor", "plan"]) {
  for (const args of [[], ["--json"]]) {
    const result = await spawnLocal(process.execPath, ["--experimental-strip-types", executableFixture, command, ...args], { allowFailure: true, timeoutMs: 30_000 });
    check(`executable ${command} ${args}: command completes or doctor reports blocking fixture findings`, command === "doctor" ? [0, 1].includes(result.code) : result.code === 0, true);
    const output = `${result.stdout}${result.stderr}`;
    check(`executable ${command} ${args}: diagnostics retain useful host/path`, output.includes("provider.example/v1") && output.includes("proxy.example:9050/connect"), true);
    check(`executable ${command} ${args}: no raw/normalized credential or whitespace suffix`, forbidden.filter((secret) => output.includes(secret)), []);
  }
}
const mcp = await spawnLocal(process.execPath, ["--experimental-strip-types", executableFixture, "control-mcp"], {
  input: ["inspect", "doctor", "plan"].map((name, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } })).join("\n") + "\n",
  timeoutMs: 30_000,
});
check("real control MCP fixture exits cleanly", mcp.code, 0);
const responses = mcp.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { id: number; result: { content: { text: string }[]; structuredContent: { result: unknown } } });
for (const [id, name] of ["inspect", "doctor", "plan"].entries()) {
  const response = responses.find((entry) => entry.id === id);
  const text = JSON.stringify(response) ?? "";
  check(`real MCP ${name}: structured diagnostic retains host/path`, (JSON.stringify(response?.result.structuredContent.result) ?? "").includes("provider.example/v1"), true);
  check(`real MCP ${name}: text diagnostic retains host/path`, response?.result.content.some(({ text }) => text.includes("provider.example/v1")), true);
  check(`real MCP ${name}: excludes raw/normalized credentials and whitespace suffixes`, forbidden.filter((secret) => text.includes(secret)), []);
}
finish("egress credential URL publication");
