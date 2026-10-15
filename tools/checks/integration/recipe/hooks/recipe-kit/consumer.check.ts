import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { consumerFetch, RecipeKitRefusal, REQUEST_BYTES_MAX } from "#framework/recipe-kit/index.ts";
import type { CommandResult, RecipeContext, RecipeRunOptions, ConsumerRequest } from "#framework/recipe-kit/index.ts";
import { maskSecrets, registerSecret } from "#framework/core/io/log.ts";
import { curlQuote, parseResponse, STATUS_TRAILER } from "#framework/recipe-kit/curl.ts";

const calls: { service: string; command?: string; args: string[]; options?: RecipeRunOptions }[] = [];
const response = (body: string, status = 200): string => `HTTP/1.1 ${status} OK\r\nContent-Type: text/plain\r\nX-Ignore: private\r\n\r\n${body}${STATUS_TRAILER}${status}:0`;
let result: CommandResult = { code: 0, stdout: response("ééé"), stderr: "" };
const ctx: RecipeContext = { runtime: {
  async runOneOff(service, args, options) { calls.push({ service, args, options }); return result; },
  async execCommand(service, command, args, options) { calls.push({ service, command, args, options }); return result; },
} };
async function refusal(name: string, request: ConsumerRequest, reason: string, context = ctx): Promise<void> {
  try { await consumerFetch(context, request); checkTrue(name, false); }
  catch (error) { check(name, error instanceof RecipeKitRefusal ? error.reason : String(error), reason); checkTrue(`${name} no cause`, error instanceof Error && !Object.hasOwn(error, "cause")); }
}
check("escape quotes slash LF CR", curlQuote('a"b\\c\n\r'), '"a\\"b\\\\c\\n\\r"');
const request: ConsumerRequest = { url: "https://example.test/", body: 'a"b\\c\n\r', responseHeaders: ["Content-Type"], timeoutMs: 90, bodyBytesMax: 5 };
check("utf8 body and selected lowercase headers", await consumerFetch(ctx, request), { status: 200, headers: { "content-type": "text/" }, body: "éé", truncated: true });
check("exec fixed argv", calls[0].args, ["--disable", "--config", "-"]);
check("gateway curl", [calls[0].service, calls[0].command, calls[0].options?.timeoutMs], ["gateway", "curl", 90]);
// Parse curl's line-oriented configuration into directive/value pairs, not prose pins.
function directives(input: string | undefined): [string, string | undefined][] {
  return (input ?? "").trimEnd().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line.trim(), undefined] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  });
}
check("stdin protocols curl limits", directives(calls[0].options?.input).filter(([name]) =>
  ["proto", "proto-redir", "max-filesize", "max-redirs"].includes(name)),
[["proto", '"=http,https"'], ["proto-redir", '"=http,https"'], ["max-filesize", "5"], ["max-redirs", "0"]]);
check("hostile body stdin only", directives(calls[0].options?.input).find(([name]) => name === "data-raw"),
  ["data-raw", '"a\\"b\\\\c\\n\\r"']);
await consumerFetch({ runtime: { runOneOff: ctx.runtime.runOneOff } }, request);
check("fallback entrypoint", calls.at(-1), { service: "gateway", args: ["--disable", "--config", "-"], options: { input: calls[0].options?.input, allowFailure: true, timeoutMs: 90, entrypoint: "curl", noDeps: true } });
result.stdout = response("xx tiny-token tail");
check("secret crossing retention boundary", [...new TextEncoder().encode((await consumerFetch(ctx, { ...request, secrets: ["tiny-token"] })).body)], [120, 120, 32, 42, 42]);
result.stdout = response("a p Bearer tok tok u:p dTpw encoded%21 encoded! short");
const redacted = await consumerFetch(ctx, { ...request, bodyBytesMax: 1000, headers: { Authorization: "Bearer tok", "Proxy-Authorization": "Basic xyz" }, basicAuth: { username: "u", password: "p" }, proxy: "socks5h://a:encoded%21@example.test", secrets: ["short"] });
checkTrue("short credentials and encoded proxy values gone", !redacted.body.includes("tok") && !redacted.body.includes("encoded") && !redacted.body.includes("u:p") && !redacted.body.includes("dTpw") && !redacted.body.includes("short"));
result.stdout = response('"\\u0074\\u006f\\u006b"');
check("short unicode JSON secret", (await consumerFetch(ctx, { ...request, secrets: ["tok"], bodyBytesMax: 100 })).body, '"***"');
const chainBody = "HTTP/1.1 500 Fake\r\n\r\nbody";
const chain = `HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 302 Found\r\nLocation: /next\r\n\r\nHTTP/2 201 Created\r\nX-Key: final\r\n\r\n${chainBody}${STATUS_TRAILER}201:1`;
const parsedChain = parseResponse(chain, ["x-key"]);
check("proxy interim redirect chain status and headers", [parsedChain.status, parsedChain.headers], [201, { "x-key": "final" }]);
check("HTTP-like body preserved byte-for-byte", [...new TextEncoder().encode(parsedChain.body)], [...new TextEncoder().encode(chainBody)]);
const redirectBody = "HTTP/1.1 200 Fake\r\n\r\nbody";
const unfollowed = parseResponse(response(redirectBody, 302), []);
check("unfollowed redirect status and headers", [unfollowed.status, unfollowed.headers], [302, {}]);
check("unfollowed redirect body preserved byte-for-byte", [...new TextEncoder().encode(unfollowed.body)], [...new TextEncoder().encode(redirectBody)]);
// Requirement table: accepted bodies stay in stdin with independently authored escaping;
// rejected controls/oversize bodies must never reach either runtime entry point.
const hostileInputs: { label: string; body: string; quoted?: string }[] = [
  { label: "quotes", body: 'a"b', quoted: '"a\\"b"' },
  { label: "backslash", body: "a\\b", quoted: '"a\\\\b"' },
  { label: "LF", body: "a\nb", quoted: '"a\\nb"' },
  { label: "NUL", body: "a\0b" },
  { label: "long", body: "x".repeat(REQUEST_BYTES_MAX + 1) },
];
for (const { label, body, quoted } of hostileInputs) {
  const before = calls.length;
  if (quoted === undefined) {
    await refusal(`${label} refused`, { ...request, body }, "invalid-request");
    check(`${label} no runtime contact`, calls.length, before);
  } else {
    await consumerFetch(ctx, { ...request, body });
    check(`${label} one runtime contact`, calls.length, before + 1);
    check(`${label} fixed argv`, calls.at(-1)?.args, ["--disable", "--config", "-"]);
    check(`${label} stdin encoding`, directives(calls.at(-1)?.options?.input).find(([name]) => name === "data-raw"), ["data-raw", quoted]);
  }
}
await refusal("other controls refused", { ...request, body: "\t" }, "invalid-request");
await refusal("header LF refused", { ...request, headers: { test: "a\nb" } }, "invalid-request");
await refusal("file protocol", { ...request, url: "file:///etc/passwd" }, "invalid-request");
await refusal("URL credentials", { ...request, url: "https://u:p@example.test" }, "invalid-request");
const registrationSecret = "before-contact-credential";
await consumerFetch({ runtime: { async runOneOff() {
  check("registered before contact", maskSecrets(registrationSecret), "***");
  return { code: 0, stdout: response("ok"), stderr: "" };
} } }, { ...request, secrets: [registrationSecret] });
const headerSecret = "registered-header-credential";
registerSecret(headerSecret);
result.stdout = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Credential: ${headerSecret}\r\nX-Ignore: private\r\n\r\nok${STATUS_TRAILER}200:0`;
check("selected headers redact registered secret without truncation", await consumerFetch(ctx, {
  ...request, bodyBytesMax: 100, responseHeaders: ["Content-Type", "X-Credential"],
}), { status: 200, headers: { "content-type": "text/plain", "x-credential": "***" }, body: "ok", truncated: false });
result.stdout = response("ok");
await consumerFetch(ctx, { ...request, method: "POST", headers: { "X-Request": "forwarded" }, maxRedirects: 3 });
check("request fields and redirect budget forwarded", directives(calls.at(-1)?.options?.input).filter(([name]) =>
  ["url", "request", "max-redirs", "location"].includes(name)), [
  ["max-redirs", "3"], ["url", '"https://example.test/"'], ["location", undefined],
  ["request", '"POST"'],
]);
const forwardedHeader = directives(calls.at(-1)?.options?.input).find(([name]) => name === "header")?.[1];
check("request header forwarded", (JSON.parse(forwardedHeader ?? '""') as string).split(":").map((part) => part.trim()), ["X-Request", "forwarded"]);
result.stdout = response("12345");
check("exact body budget and clipped headers do not flag body", (await consumerFetch(ctx, request)).truncated, false);
result.stdout = response("long-redaction-secret");
check("flag uses redacted full body bytes", await consumerFetch(ctx, { ...request, secrets: ["long-redaction-secret"] }), { status: 200, headers: { "content-type": "text/" }, body: "***", truncated: false });
result.stdout = response("x".repeat(100));
check("captured chunked-sized body retained and flagged", await consumerFetch(ctx, { ...request, responseHeaders: [] }), { status: 200, headers: {}, body: "xxxxx", truncated: true });
result.code = 7;
await refusal("nonzero curl", request, "exit");
result.code = 0;
result.stdout = "malformed private body";
await refusal("malformed output", request, "response");
await refusal("transport output-free", request, "transport", { runtime: { runOneOff: async () => { throw new Error(request.url); } } });
await refusal("real curl helper deadline", { ...request, timeoutMs: 10 }, "timeout", { runtime: { runOneOff: () => new Promise(() => {}) } });
finish("recipe-kit consumer");
