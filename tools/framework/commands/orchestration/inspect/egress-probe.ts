// The egress probe: the `node -e` script observeEgress (observe.ts, this same directory)
// execs into the gateway container, and the budgets that bound it. Own file because the
// script is shipped text the deadline checks time, and the observe module has plenty of
// its own to hold.

// Outbound reachability is asked of the CONTAINER, not of this machine: the inbound probes
// above curl from the operator side, and a name that resolves there and not inside the
// container is exactly how 2026-09-20 happened — the gateway unable to reach its model
// provider for a day while every probe stayed green. One `node -e` exec carries the whole
// probe: the image has node (that is how the outage was diagnosed) and curl cannot be
// assumed. Endpoints travel on stdin, never argv — a configured proxy URL can carry
// credentials, and command lines end up in logs; stdin does not.
//
// The script answers BOTH failure questions separately, because they fail differently:
// dns.promises.lookup goes through the container's own resolver (getaddrinfo: /etc/hosts
// and /etc/resolv.conf); a fetch that returns at all — any status, 401 included — proves
// the path is open. Non-HTTP schemes (the tor socks5 proxy) cannot go through fetch, so
// they get a plain TCP connect: something listening is the reachability fact, and a
// fetch-based check would report every healthy tor setup as unreachable.
//
// One deadline governs each endpoint end to end: armed BEFORE dns.lookup, so a slow or hung
// resolver spends the same budget a slow server would; kept armed across the fetch so a
// body that never ends cannot outlive it — fetch settling on the headers, the body is
// expressly cancelled underneath the still-running timer. The answer on expiry is the
// normal "timeout" observation, never an exception and never silence.

// Each endpoint's whole-probe budget — DNS, connection, headers and body alike. All
// endpoints probe concurrently, so this is also the script's own wall-clock ceiling once
// node is up.
export const EGRESS_PROBE_TIMEOUT_MS = 5000;

// The exec that carries the script is bounded in turn, with slack for node boot and the
// docker/WSL client around it. A deadline the child process can ignore is not a deadline:
// without this, one wedged exec stalls inspect — and, MCP dispatch being sequential, every
// request queued behind it.
export const EGRESS_EXEC_TIMEOUT_MS = EGRESS_PROBE_TIMEOUT_MS + 5000;

/** The script observeEgress execs into the gateway container, parameterized by the
 *  per-endpoint budget so checks can run it against deliberately unresponsive servers in
 *  seconds rather than the production five. Exported for those checks — the shipped script
 *  must be the exact text they time. */
export function egressProbeScript(timeoutMs: number): string {
  return `const dns = require("dns").promises;
const net = require("net");
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let urls = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) urls = parsed.filter((url) => typeof url === "string");
  } catch (error) {}
  Promise.all(urls.map((url) => probe(url)))
    .then((answers) => { console.log(JSON.stringify(answers)); })
    .catch((error) => { console.log("[]"); });
});
const TIMEOUT_MS = ${timeoutMs};
async function probe(url) {
  let host;
  let port;
  let isHttp;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port;
    isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    return { url, state: "invalid" };
  }
  const controller = new AbortController();
  let atDeadline = false;
  let deadlineFired = () => {};
  const deadlineReached = new Promise((resolve) => { deadlineFired = resolve; });
  const giveUp = setTimeout(() => { atDeadline = true; controller.abort(); deadlineFired(); }, TIMEOUT_MS);
  const timeoutAnswer = () => ({ url, state: "timeout", detail: "no answer within " + TIMEOUT_MS + "ms" });
  try {
    try {
      // dns.lookup takes no signal, so the lookup races the deadline instead; the lookup is
      // drained through .catch on the way into the race, because a loser that rejects later
      // would otherwise be an unhandled rejection and kill the whole probe process.
      const lookup = dns.lookup(host);
      await Promise.race([lookup.catch(() => undefined), deadlineReached]);
      if (atDeadline) return timeoutAnswer();
      await lookup;
    } catch (error) {
      if (atDeadline) return timeoutAnswer();
      return { url, state: "dns", detail: String((error && error.code) || (error && error.message) || error) };
    }
    if (!isHttp) {
      return await new Promise((resolve) => {
        const socket = net.connect({ host, port: port === "" ? 1080 : Number(port) });
        const finish = (answer) => { socket.destroy(); resolve(answer); };
        socket.once("connect", () => { finish({ url, state: "ok" }); });
        socket.once("error", (error) => { finish({ url, state: "unreachable", detail: String((error && error.code) || error.message) }); });
        deadlineReached.then(() => { finish(timeoutAnswer()); });
      });
    }
    if (typeof fetch !== "function") {
      return { url, state: "unreachable", detail: "this node has no fetch to probe with" };
    }
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
      if (atDeadline) return timeoutAnswer();
      // fetch settles on the headers, and the body is not wanted: cancel it while the
      // deadline is still armed, so a server that sends headers and then never ends the
      // body cannot hold the connection — or this probe — open past the budget.
      await Promise.race([response.body?.cancel().catch(() => undefined), deadlineReached]);
      if (atDeadline) return timeoutAnswer();
      return { url, state: "ok" };
    } catch (error) {
      if (atDeadline) return timeoutAnswer();
      const cause = (error && error.cause) || error;
      return { url, state: "unreachable", detail: String((cause && cause.code) || (cause && cause.message) || cause) };
    }
  } finally {
    clearTimeout(giveUp);
  }
}`;
}

export const EGRESS_PROBE_SCRIPT = egressProbeScript(EGRESS_PROBE_TIMEOUT_MS);
