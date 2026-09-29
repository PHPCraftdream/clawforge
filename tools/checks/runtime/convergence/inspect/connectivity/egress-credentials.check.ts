import { gatherInspection, inspect, doctor } from "#framework/commands/orchestration/inspect/gather.ts";
import { redactEndpoint, redactEndpointText, publicConfigValue } from "#framework/commands/orchestration/inspect/helpers.ts";
import { computePlan, plan } from "#framework/commands/orchestration/plan.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { maskSecrets } from "#framework/core/io/log.ts";
import { toolEnvelope, maskStructuredResult } from "#framework/integration/mcp/schema.ts";
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
          const urls = JSON.parse(options.input ?? "[]") as string[];
          inputs.push(urls);
          return {
            code: 0,
            stdout: JSON.stringify(urls.map((url) => ({ url, state, detail: `probe diagnostic ${url} E_SYNTHETIC` }))),
            stderr: "",
          };
        },
      },
    };
    const inspection = await gatherInspection(ctx);
    check(`${state}: live-only endpoints are probed with original credentials`, inputs[0], [providerUrl, proxyUrl]);
    check(`${state}: observations retain host/path and redact credentials`, inspection.observed.egress?.map((entry) => entry.endpoint), [publicProvider, publicProxy]);
    check(`${state}: endpoint status remains diagnostic`, inspection.observed.egress?.map((entry) => entry.state), [state, state]);
    check(`${state}: probe detail shares URL redaction`, inspection.observed.egress?.map((entry) => entry.detail), [`probe diagnostic ${publicProvider} E_SYNTHETIC`, `probe diagnostic ${publicProxy} E_SYNTHETIC`]);
    const findings = inspection.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE");
    check(`${state}: failures retain their findings`, findings.length, state === "ok" ? 0 : 2);

    const terminalText = await terminalOutput(() => inspect(ctx, []));
    const terminalJson = await terminalOutput(() => inspect(ctx, ["--json"]));
    const doctorText = await terminalOutput(async () => {
      try { await doctor(ctx, []); }
      catch { /* Fixture-only blocking findings are still printed. */ }
    });
    const doctorJson = await terminalOutput(async () => {
      try { await doctor(ctx, ["--json"]); }
      catch { /* Fixture-only blocking findings are still printed. */ }
    });
    const planText = await terminalOutput(() => plan(ctx, []));
    const planJson = await terminalOutput(() => plan(ctx, ["--json"]));
    const computed = await computePlan(ctx);
    const doctorPayload = JSON.parse(doctorJson) as { problems: { code: string }[] };
    check(`${state}: doctor JSON retains failed endpoint diagnostics`, doctorPayload.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE").length, findings.length);
    check(`${state}: plan retains failed endpoint diagnostics`, computed.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE").length, findings.length);
    const inspectPayload = JSON.parse(terminalJson) as { observed: { egress: { endpoint: string; state: string }[] } };
    check(`${state}: inspect JSON preserves useful endpoints and status`, inspectPayload.observed.egress.map(({ endpoint, state }) => ({ endpoint, state })), [{ endpoint: publicProvider, state }, { endpoint: publicProxy, state }]);
    const planPayload = JSON.parse(planJson) as { problems: { code: string }[] };
    check(`${state}: plan JSON retains failed endpoint diagnostics`, planPayload.problems.filter((entry) => entry.code === "EGRESS_UNREACHABLE").length, findings.length);
    if (state !== "ok") {
      check(`${state}: doctor text retains diagnostic host/path`, doctorText.includes("provider.example/v1/models") && doctorText.includes("proxy.example:9050/connect"), true);
      check(`${state}: plan text retains diagnostic host/path`, planText.includes("provider.example/v1/models") && planText.includes("proxy.example:9050/connect"), true);
    }
    const capturedMCP: Record<string, string> = {};
    for (const [name, command] of Object.entries({ inspect, doctor, plan })) {
      let captured = "";
      let machine = "";
      await withOutputSink((chunk) => { captured += chunk; }, async () => {
        try { await command(ctx, []); }
        catch (error) {
          // Like MCP, preserve the emitted diagnostics even when doctor rejects the verdict.
          if (name !== "doctor") throw error;
        }
      }, (chunk) => { machine += chunk; });
      const envelope = maskStructuredResult(toolEnvelope({ summary: name, readOnly: true, structured: true }, captured, machine, "synthetic-capture", []));
      capturedMCP[name] = JSON.stringify({ content: [{ type: "text", text: maskSecrets(captured) }], structuredContent: envelope });
      if (name === "inspect" || state !== "ok") {
        check(`${state}: captured MCP ${name} preserves diagnostic host/path`, capturedMCP[name].includes("provider.example/v1/models") && capturedMCP[name].includes("proxy.example:9050/connect"), true);
      }
    }
    check(`${state}: terminal text contains sanitized egress`, terminalText.includes(publicProvider) && terminalText.includes(publicProxy), true);
    const outputs = { inspection: JSON.stringify(inspection), terminalText, terminalJson, doctorText, doctorJson, planText, planJson, plan: JSON.stringify(computed), capturedMCP: JSON.stringify(capturedMCP) };
    for (const [name, text] of Object.entries(outputs)) {
      check(`${state}: ${name} excludes every unregistered inline credential`, secrets.filter((secret) => text.includes(secret)), []);
    }
    check(`${state}: all diagnostic calls retain original probe input`, inputs.every((urls) => urls[0] === providerUrl && urls[1] === proxyUrl), true);
  }
} finally {
  await teardownFixtureDeployment(deployment);
}
finish("egress credential URL publication");
