// Compose's own container/network lifecycle progress lines (spawn-failure.ts's COMPOSE_NOISE)
// must never reach an operator as if they were the reason a call failed — neither in a
// rejected call's own detail (meaningfulLines, exercised here against the new lifecycle
// patterns; transport-listing.check.ts already pins the original "No services to build" one)
// nor in what a `--stream: true` caller watches scroll by live (noiseFilteredForwarder).
// See docs/first-hour-acceptance.md's 2026-09-27 run: a Compose progress line standing in for
// the real failure reason, and streamed progress reaching the operator during bootstrap/smoke,
// were two of its findings.

import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { withOutputSink } from "#framework/core/io/output.ts";

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

/** Builds JS source that writes a Compose lifecycle line, its state word split in two so the
 *  literal never sits contiguous in THIS file's own source — process.execPath's argv is
 *  echoed verbatim into an unshortened failure headline (describeInvocation does not shorten
 *  a bare node invocation), and a contiguous literal there would make a check pass for the
 *  wrong reason (the phrase surviving in the echoed argv) rather than the right one (surviving,
 *  un-filtered, in what was actually read from stdout/stderr). */
function lifecycleLineSource(kind: "Container" | "Network", name: string, state: string): string {
  const mid = Math.ceil(state.length / 2);
  return `' ${kind} ${name} ' + '${state.slice(0, mid)}' + '${state.slice(mid)}'`;
}

// --- a rejected call's own detail: the new lifecycle patterns, same discipline as the
// original "No services to build" one (transport-listing.check.ts) --------------------------

{
  // The real bug report this covers: a Compose container/network lifecycle line (not the
  // "No services to build" phrase) was the whole detail, hiding the real reason underneath.
  const script =
    `process.stderr.write(${lifecycleLineSource("Container", "demo-gateway-1", "Running")} + '\\n');` +
    `process.stderr.write(${lifecycleLineSource("Network", "demo_default", "Creating")} + '\\n');` +
    "process.stdout.write('the real reason lives on stdout\\n');" +
    "process.exit(1);";
  let message = "";
  try {
    await spawnLocal(process.execPath, ["-e", script]);
  } catch (error) {
    message = (error as Error).message;
  }
  check("noise filtered: container/network lifecycle lines defer to the real reason", message.includes("the real reason lives on stdout"), true);
  check("noise filtered: neither lifecycle line survives", message.includes("Running") || message.includes("Creating"), false);
}

{
  // Anchored precisely so a real error that merely mentions a container survives: only an
  // EXACT " Container <name> <state>" line is noise, not a sentence naming one.
  const script = "process.stderr.write('Error: Container demo-gateway-1 is unhealthy and refuses to start\\n'); process.exit(1);";
  let message = "";
  try {
    await spawnLocal(process.execPath, ["-e", script]);
  } catch (error) {
    message = (error as Error).message;
  }
  check("noise filter is precise: a real error naming a container is never dropped", message.includes("is unhealthy and refuses to start"), true);
}

// --- streamed forwarding: noise dropped live, real output next to it survives ---------------

{
  const script =
    `process.stderr.write(${lifecycleLineSource("Container", "demo-gateway-1", "Starting")} + '\\n');` +
    `process.stderr.write(${lifecycleLineSource("Container", "demo-gateway-1", "Started")} + '\\n');` +
    "process.stderr.write('Error: something real broke\\n');" +
    `process.stdout.write(${lifecycleLineSource("Network", "demo_default", "Creating")} + '\\n');` +
    "process.stdout.write('real progress line\\n');";
  let forwarded = "";
  const result = await withOutputSink(
    (chunk) => { forwarded += chunk; },
    () => spawnLocal(process.execPath, ["-e", script], { stream: true, allowFailure: true }),
  );
  check("streamed: lifecycle noise never reaches what the operator watches", /Starting|Started|Creating/.test(forwarded), false);
  check("streamed: a real line right next to the noise still comes through", forwarded.includes("something real broke") && forwarded.includes("real progress line"), true);
  check("captured result: the full raw text stays untouched, noise included", result.stderr.includes("Starting") && result.stdout.includes("Creating"), true);
}

{
  // A noise line split across two chunks must still be recognized whole, not half-forwarded.
  const script =
    `const line = ${lifecycleLineSource("Container", "demo-gateway-1", "Running")} + '\\n';` +
    "process.stdout.write(line.slice(0, 5));" +
    "setTimeout(() => process.stdout.write(line.slice(5)), 20);";
  let forwarded = "";
  await withOutputSink((chunk) => { forwarded += chunk; }, () => spawnLocal(process.execPath, ["-e", script], { stream: true }));
  check("streamed: a noise line split across chunks is still dropped whole", forwarded.includes("Running"), false);
}

{
  // OC_DEBUG=1 wants the undiluted stream — the same escape hatch entry/cli.ts's own
  // OC_DEBUG branch gives a rejected call's full argv.
  const script = `process.stderr.write(${lifecycleLineSource("Container", "demo-gateway-1", "Running")} + '\\n');`;
  const previous = process.env.OC_DEBUG;
  process.env.OC_DEBUG = "1";
  let forwarded = "";
  try {
    await withOutputSink((chunk) => { forwarded += chunk; }, () => spawnLocal(process.execPath, ["-e", script], { stream: true }));
  } finally {
    if (previous === undefined) delete process.env.OC_DEBUG;
    else process.env.OC_DEBUG = previous;
  }
  check("OC_DEBUG=1 shows the noise line live too", forwarded.includes("Running"), true);
}

{
  // Precise anchoring, live too: a real error that merely mentions a container must survive
  // the streamed path exactly as it survives the failure-detail path.
  const script = "process.stderr.write('Error: Container demo-gateway-1 is unhealthy and refuses to start\\n');";
  let forwarded = "";
  await withOutputSink((chunk) => { forwarded += chunk; }, () => spawnLocal(process.execPath, ["-e", script], { stream: true }));
  check("streamed noise filter is precise: a real error naming a container still reaches the operator", forwarded.includes("is unhealthy and refuses to start"), true);
}

// --- a failed `sh -c <script>` never pastes its body into the rejection's own message -------
//
// The exact repro shape `quoting.ts`'s publishCommand builds (apply-config's own staging
// write hit this): `sh -c '<multi-statement script>' sh <temp> <target>`, failing because the
// parent directory does not exist. Before the fix, the whole script became the headline;
// stderr's real cause — from the shell itself — must be what the message leads with.

{
  const script = "temporary=$1; target=$2; trap 'rm -f -- \"$temporary\"' EXIT; cat > \"$temporary\" && mv -f -- \"$temporary\" \"$target\"; status=$?; exit $status";
  let message = "";
  try {
    await spawnLocal("sh", ["-c", script, "sh", "/no/such/dir/x.tmp", "/no/such/dir/x"], { input: "content" });
  } catch (error) {
    message = (error as Error).message;
  }
  check("a failed sh -c publish script never pastes its body into the message", message.includes("trap 'rm -f"), false);
  check("the real shell-reported cause still comes through", /no such file or directory/i.test(message), true);
}

process.stderr.write(failed === 0 ? "all spawn noise checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
