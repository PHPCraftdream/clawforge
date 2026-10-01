// ImageRef laws (refactor plan stage 1, I7): runtime/docker/image-ref.ts owns the one
// grammar for image references — parse/format round-trip on every supported form, strict
// rejection of everything else, and the channel/withDigest/sameContent laws the upgrade,
// bootstrap and set paths rely on.

import { parse, tryParse, format, channel, withDigest, sameContent, digestOf, hasDigest } from "#framework/runtime/docker/image-ref.ts";
import { check, finish } from "#checks/kit/harness.ts";
import { UserError } from "#framework/core/io/log.ts";

const HEX = "a".repeat(64);

// --- parse(format(x)) = x on every form the grammar accepts ---------------------------------

const ROUND_TRIP = [
  "openclaw/openclaw",
  "openclaw/openclaw:1.2.3",
  `openclaw/openclaw@sha256:${HEX}`,
  `openclaw/openclaw:1.2.3@sha256:${HEX}`,
  `registry.example:5000/openclaw/openclaw:1.2.3@sha256:${HEX}`,
  "docker.io/library/openclaw:latest",
  "localhost:5000/openclaw",
  "localhost/openclaw:dev",
];
for (const value of ROUND_TRIP) {
  const ref = tryParse(value);
  check(`parses ${value}`, ref !== undefined, true);
  check(`format(parse) round-trips ${value}`, ref === undefined ? undefined : format(ref), value);
}

// A registry port's colon is never read as a tag; a tag only ever sits on the last segment.
check("a registry port survives parsing", tryParse("registry.example:5000/openclaw/openclaw:1.2.3")?.tag, "1.2.3");
check("no port on a registryless repo", tryParse("openclaw/openclaw:1.2.3")?.registry, undefined);
check("a path colon after a registry is still the tag", tryParse("registry.example:5000/repo:tag")?.tag, "tag");

// --- rejection -------------------------------------------------------------------------------

const REJECTED = [
  "",
  "   ",
  "openclaw/openclaw ",            // trailing whitespace
  "openclaw/openclaw@",            // digest with nothing after it
  `openclaw/openclaw@sha256:${"a".repeat(63)}`,  // wrong length
  `openclaw/openclaw@sha256:${"A".repeat(64)}`,  // uppercase hex
  "openclaw/openclaw@deadbeef",    // missing algorithm
  "openclaw/openclaw@md5:0123",    // wrong algorithm
  `openclaw/openclaw@sha256:nothex`,
  "openclaw/openclaw:",            // empty tag
  "openclaw/openclaw:1.2.3:4",     // two colons in the last segment
  "openclaw/openclaw@sha256:",     // empty digest
];
for (const value of REJECTED) {
  check(`rejects ${JSON.stringify(value)}`, tryParse(value), undefined);
}
let threw: unknown;
try {
  parse("openclaw/openclaw@sha256:zz");
} catch (error) {
  threw = error;
}
check("parse throws a UserError on a malformed reference", threw instanceof UserError, true);
check("the error names the input", threw instanceof Error && threw.message.includes("openclaw/openclaw@sha256:zz"), true);

// --- channel / withDigest / sameContent laws --------------------------------------------------

const DIGEST = `sha256:${HEX}`;
check("channel strips the digest", channel(parse(`openclaw/openclaw:1.2.3@${DIGEST}`)), "openclaw/openclaw:1.2.3");
check("channel keeps the tag", channel(parse(`openclaw/openclaw:1.2.3@${DIGEST}`)), "openclaw/openclaw:1.2.3");
check("channel of a tagless repo is itself", channel(parse("openclaw/openclaw")), "openclaw/openclaw");
check("channel keeps the registry", channel(parse(`registry.example:5000/repo:tag@${DIGEST}`)), "registry.example:5000/repo:tag");
check("withDigest pins a tag", format(withDigest(parse("openclaw/openclaw:1.2.3"), DIGEST)), `openclaw/openclaw:1.2.3@${DIGEST}`);
check("withDigest replaces an old digest", format(withDigest(parse(`openclaw/openclaw@sha256:${"b".repeat(64)}`), DIGEST)), `openclaw/openclaw@${DIGEST}`);

// Same content under different spellings: the pin forms .env holds vs Docker's own answer.
check("a digest equals its tagged pin", sameContent(`openclaw/openclaw@${DIGEST}`, `openclaw/openclaw:1.2.3@${DIGEST}`), true);
check("a bare Docker digest equals its full form", sameContent(DIGEST, `openclaw/openclaw:1.2.3@${DIGEST}`), true);
check("a value is the same content as itself", sameContent("openclaw/openclaw:1.2.3", "openclaw/openclaw:1.2.3"), true);
check("two different digests differ", sameContent(DIGEST, `sha256:${"b".repeat(64)}`), false);
check("a tag is not the content it resolves to", sameContent("openclaw/openclaw:1.2.3", `openclaw/openclaw@${DIGEST}`), false);
check("two tags differ", sameContent("openclaw/openclaw:1.2.3", "openclaw/openclaw:1.2.4"), false);

check("digestOf reads the digest off a pin", digestOf(`openclaw/openclaw:1.2.3@${DIGEST}`), DIGEST);
check("digestOf reads a bare digest", digestOf(DIGEST), DIGEST);
check("digestOf of a tag is undefined", digestOf("openclaw/openclaw:1.2.3"), undefined);
// Comparison leniency: a pin recorded in a non-canonical spelling still compares to itself.
check("digestOf still reads a non-canonical suffix", digestOf("fixture@sha256:abc"), "sha256:abc");
check("so sameContent holds for it", sameContent("fixture@sha256:abc", "other/fixture@sha256:abc"), true);
check("hasDigest on a pin", hasDigest(`openclaw/openclaw:1.2.3@${DIGEST}`), true);
check("hasDigest on a tag", hasDigest("openclaw/openclaw:1.2.3"), false);

finish("ImageRef laws");
