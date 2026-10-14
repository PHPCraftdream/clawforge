import { checkTrue, finish } from "#checks/kit/harness.ts";
import { fetchPublishedChecksum, ChecksumError, type FetchSeam } from "#framework/commands/management/recipe/run/pin/checksum.ts";

const asset = "https://github.com/acme/releases/download/v1/tool.tgz";
const digest = "A".repeat(64);
const errorCode = async (url: string, fetcher: FetchSeam): Promise<string> => {
  try { await fetchPublishedChecksum(url, fetcher); return "none"; }
  catch (error) { return error instanceof ChecksumError ? error.code : "unknown"; }
};
const response = (status: number, body = "", headers?: HeadersInit): Response => new Response(body, { status, headers });
const sumURL = "https://github.com/acme/releases/download/v1/SHA256SUMS";

{
  const calls: string[] = [];
  const result = await fetchPublishedChecksum(asset, async (input, init) => {
    calls.push(String(input));
    checkTrue("primary GET uses manual redirect, credential omit, and no authorization", init?.method === "GET" && init.redirect === "manual" && init.credentials === "omit" && !(init.headers instanceof Headers && init.headers.has("authorization")) && !(typeof init.headers === "object" && init.headers !== null && "authorization" in init.headers));
    return response(200, `${digest}  tool.tgz\n`);
  });
  checkTrue("primary success normalizes digest and reports source URL", result.digest === digest.toLowerCase() && result.sourceURL === `${asset}.sha256`);
  checkTrue("primary success requests exact checksum URL", calls.join("|") === `${asset}.sha256`);
}
{
  const calls: string[] = [];
  const result = await fetchPublishedChecksum(asset, async (input) => {
    calls.push(String(input));
    return calls.length === 1 ? response(404) : response(200, `${"b".repeat(64)} other.tgz\n${digest} *tool.tgz\n`);
  });
  checkTrue("SHA256SUMS fallback selects matching entry", result.digest === digest.toLowerCase() && result.sourceURL === sumURL && calls.join("|") === `${asset}.sha256|${sumURL}`);
}
for (const [label, body] of [["primary filename mismatch", `${digest} other.tgz\n`], ["malformed digest", `${"z".repeat(64)} tool.tgz\n`], ["bare digest refused", `${digest}\n`], ["two digest lines refused", `${digest} tool.tgz\n${"b".repeat(64)} other.tgz\n`], ["duplicate matching entries refused", `${digest} tool.tgz\n${digest} tool.tgz\n`]] as const) {
  checkTrue(`${label}: parse refusal`, await errorCode(asset, async () => response(200, body)) === "parse");
}
{
  let count = 0;
  const code = await errorCode(asset, async () => { count++; return response(404); });
  checkTrue("primary and fallback 404 yield missing HTTP result", code === "http" && count === 2);
}
{
  let count = 0;
  const code = await errorCode(asset, async () => { count++; return response(503); });
  checkTrue("non-200 primary does not fall back", code === "http" && count === 1);
}
{
  const calls: string[] = [];
  const code = await errorCode(asset, async (input) => {
    calls.push(String(input));
    return response(302, "", { location: "https://evil.example/check" });
  });
  checkTrue("foreign redirect is rejected before foreign fetch", code === "redirect" && calls.length === 1 && calls[0] === `${asset}.sha256`);
}
{
  const calls: string[] = [];
  const result = await fetchPublishedChecksum(asset, async (input) => {
    calls.push(String(input));
    return calls.length === 1 ? response(302, "", { location: "https://objects.githubusercontent.com/checksum" }) : response(200, `${digest} tool.tgz\n`);
  });
  checkTrue("allowed redirect is followed and reported", result.digest === digest.toLowerCase() && result.sourceURL === "https://objects.githubusercontent.com/checksum" && calls.length === 2);
}
{
  const signed = "https://release-assets.githubusercontent.com/download?token=abc";
  const result = await fetchPublishedChecksum(asset, async (input) => String(input).endsWith(".sha256") ? response(302, "", { location: signed }) : response(200, `${digest} tool.tgz\n`));
  checkTrue("signed release redirect query is accepted", result.sourceURL === signed);
}
for (const [label, url] of [["HTTP URL refused", "http://github.com/a/tool.tgz"], ["credential URL refused", "https://user:pass@github.com/a/tool.tgz"], ["foreign URL refused", "https://evil.example/a/tool.tgz"], ["initial query refused", "https://github.com/a/tool.tgz?token=abc"], ["initial fragment refused", "https://github.com/a/tool.tgz#fragment"]] as const) {
  let count = 0;
  checkTrue(`${label}: URL refusal occurs before fetch`, await errorCode(url, async () => { count++; return response(200); }) === "url" && count === 0);
}
{
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const code = await errorCode(asset, async () => new Response(body, { status: 200 }));
  checkTrue("oversize streamed body is rejected and cancelled", code === "size" && cancelled);
}
for (const [label, body, expected] of [["fallback filename mismatch", `${digest} other.tgz\n`, "missing"], ["fallback malformed line", `${"z".repeat(64)} tool.tgz\n`, "parse"], ["fallback duplicate", `${digest} tool.tgz\n${digest} tool.tgz\n`, "parse"]] as const) {
  const code = await errorCode(asset, async (input) => String(input).endsWith(".sha256") ? response(404) : response(200, body));
  checkTrue(`${label}: rejected`, code === expected);
}
{
  const code = await errorCode(asset, async () => new Promise<Response>(() => undefined));
  checkTrue("stalled fetch obeys 8s deadline", code === "timeout");
}
{
  let calls = 0;
  const code = await errorCode(asset, async () => { calls++; return response(302, "", { location: "https://github.com/next" }); });
  checkTrue("redirect cap enforced", code === "redirect" && calls === 6);
}
for (const status of [404, 503] as const) {
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => undefined); } });
  let calls = 0;
  const started = Date.now();
  const code = await errorCode(asset, async () => { calls++; return calls === 1 && status === 404 ? new Response(stalled, { status }) : calls === 1 ? new Response(stalled, { status }) : response(503); });
  checkTrue(`HTTP ${status} stalled cancellation is nonblocking`, code === "http" && cancelled && Date.now() - started < 1000);
}
{
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); }, cancel() { return new Promise<void>(() => undefined); } });
  const started = Date.now();
  const code = await errorCode(asset, async () => new Response(body, { status: 200 }));
  checkTrue("stalled cancellation cannot hang oversize rejection", code === "size" && Date.now() - started < 1000);
}
finish("recipe pin checksum");
