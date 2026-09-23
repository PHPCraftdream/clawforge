// Checks the .env parser and the settings it produces.
//
// parseEnv is deliberately not `source .env`: it must never execute anything the file
// contains, so every parsing rule (quoting, comments, first-`=`-wins) is asserted here
// rather than trusted. toSettings is checked for its required field and its defaults, since
// a wrong default silently points a deployment at the wrong directory or port.

import { parseEnv, serializeEnvLine, toSettings } from "#framework/core/env.ts";

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

// --- parseEnv ------------------------------------------------------------------

check(
  "comments and blank lines are skipped",
  parseEnv("# a comment\n\nKEY=value\n   \n# another\n"),
  { KEY: "value" },
);

check("a plain KEY=VALUE line is captured", parseEnv("KEY=value"), { KEY: "value" });

check(
  "double-quoted value has the quotes stripped",
  parseEnv('KEY="value"'),
  { KEY: "value" },
);

check(
  "single-quoted value has the quotes stripped",
  parseEnv("KEY='value'"),
  { KEY: "value" },
);

// The guard is `value.length > 1`, so a single lone quote character is data, not a pair to
// strip — stripping it would produce an empty string instead of the quote itself.
check("a lone double quote is not stripped", parseEnv('KEY="'), { KEY: '"' });
check("a lone single quote is not stripped", parseEnv("KEY='"), { KEY: "'" });

// Only the first `=` splits key from value: a value containing `=` (a URL query string, a
// base64 blob) must survive whole rather than being truncated.
check(
  "only the first = splits key from value",
  parseEnv("KEY=a=b=c"),
  { KEY: "a=b=c" },
);

check("a line with no = is ignored", parseEnv("NOTANASSIGNMENT\nKEY=value"), { KEY: "value" });

check("KEY= with an empty value is kept as an empty string", parseEnv("KEY="), { KEY: "" });

check(
  "whitespace around key and value is trimmed",
  parseEnv("  KEY  =  value  "),
  { KEY: "value" },
);

check(
  "a mismatched quote pair is left alone",
  parseEnv(`KEY="value'`),
  { KEY: "\"value'" },
);

check(
  "a full multi-line file parses every rule at once",
  parseEnv(
    [
      "# repo .env",
      "",
      "OC_DATA_DIR=/srv/openclaw/data",
      'OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:extended-stable"',
      "OC_SSH_HOST=",
      "STRAY LINE WITH NO EQUALS",
      "QUERY=a=b&c=d",
    ].join("\n"),
  ),
  {
    OC_DATA_DIR: "/srv/openclaw/data",
    OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:extended-stable",
    OC_SSH_HOST: "",
    QUERY: "a=b&c=d",
  },
);

// --- serializeEnvLine: the write side is parseEnv's exact inverse (P2-13) ----------
//
// The store writers (secrets --apply/--dump, upsertEnvValue) route through this single
// serializer. Every probe below is a structural shape, not a credential, and the check
// output above prints only booleans — no store value is ever echoed.

function roundTrips(label: string, value: string): void {
  check(
    `serialize → parse round trip: ${label}`,
    parseEnv(serializeEnvLine("PROBE_KEY", value))["PROBE_KEY"] === value,
    true,
  );
}

// The flagship loss: padding that only quoting preserves.
roundTrips("edge whitespace survives quoting", " sample ");
check(
  "a padded value is written single-quoted",
  serializeEnvLine("PROBE_KEY", " sample "),
  `PROBE_KEY=' sample '`,
);

// A value carrying its own quote character is lossless because parseEnv strips exactly
// one matched outer pair and does no escape processing: `'it's'` reads back as it's,
// and a bare `"wrapped"` — no single quote inside, but quote-wrapped — would be
// unwrapped by the next read, so it is quoted too.
roundTrips("a value containing a single quote", "it's");
roundTrips("a value that is itself double-quote-wrapped", `"wrapped"`);
roundTrips("a lone double quote (parseEnv's length>1 guard)", `"`);
roundTrips("a lone single quote", `'`);
roundTrips("a value made of two single quotes", `''`);

// parseEnv treats `#` and backslashes as literal bytes (only a `#` at line START is a
// comment), so these stay bare — quoting them would also round-trip, but the bare form
// pins the minimal quoting contract.
roundTrips("an embedded # stays literal", "abc#def");
roundTrips("a leading # is data, not a comment", "#not-a-comment");
roundTrips("a literal backslash-n is two bytes, not a newline", "a\\nb");
roundTrips("a literal double backslash stays literal", "a\\\\b");
roundTrips("interior whitespace is not edge whitespace", "a b c");
roundTrips("an empty value stays empty", "");
roundTrips("a URL-safe generated secret stays bare", "9tT4xQeFv2nH8sK1mR7wY5uC3zA6dB0pL-X_o");
check(
  "the common URL-safe path is written bare, unchanged",
  serializeEnvLine("PROBE_KEY", "9tT4xQeFv2nH8sK1mR7wY5uC3zA6dB0pL-X_o"),
  "PROBE_KEY=9tT4xQeFv2nH8sK1mR7wY5uC3zA6dB0pL-X_o",
);

// Values that cannot live on one line are refused with the key named, never written
// lossily: a real newline splits into two lines, and a \r is eaten by the reader's line
// trim as a CRLF terminator.
try {
  serializeEnvLine("PROBE_KEY", "first\nsecond");
  check("a value with a newline is refused", "did not throw", "threw");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check("a value with a newline is refused", message.includes("PROBE_KEY") && message.includes("newline"), true);
}
try {
  serializeEnvLine("PROBE_KEY", "carriage\rreturn");
  check("a value with a carriage return is refused", "did not throw", "threw");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check("a value with a carriage return is refused", message.includes("PROBE_KEY"), true);
}
try {
  serializeEnvLine("BAD-NAME", "x");
  check("an invalid variable name is refused", "did not throw", "threw");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check("an invalid variable name is refused", message.includes("invalid environment variable name"), true);
}

// --- toSettings: required field --------------------------------------------------

try {
  toSettings({});
  check("toSettings without OC_DATA_DIR throws", "did not throw", "UserError: OC_DATA_DIR is not set in .env");
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  check("toSettings without OC_DATA_DIR throws", message, "UserError: OC_DATA_DIR is not set in .env");
}

// --- toSettings: OC_DATA_DIR must be a safe, already-normalized absolute path ------
//
// ensureDataDirs (runtime/datadir.ts) later resolves the canonical root on the target and
// changes ownership only for what it creates or a provenance marker vouches for, so a loose
// string here must never even reach that machinery: each of these is asserted to throw
// before any Context (and so any transport) exists (audit 2026-09-23, XS round 4, P1-01;
// round 6, P1-09).

function rejects(dataDir: string, label: string): void {
  try {
    toSettings({ OC_DATA_DIR: dataDir });
    check(`OC_DATA_DIR ${label} is rejected`, "did not throw", "threw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(`OC_DATA_DIR ${label} is rejected`, message.includes("OC_DATA_DIR"), true);
  }
}

rejects("/", '"/"');
rejects("/srv", '"/srv" (top-level, depth 1)');
rejects("/srv/data/", '"/srv/data/" (trailing slash, not normalized)');
rejects(".", '"." (not absolute)');
rejects("..", '".." (not absolute)');
rejects("relative/data", '"relative/data" (not absolute)');
rejects("/srv//data", '"/srv//data" (double slash, not normalized)');
rejects("/srv/data/..", '"/srv/data/.." (not normalized)');
rejects("/srv/./data", '"/srv/./data" (not normalized)');

check(
  "OC_DATA_DIR at depth 2 is accepted",
  toSettings({ OC_DATA_DIR: "/srv/data" }).dataDir,
  "/srv/data",
);

// P1-09: depth is a backstop, not the safety property. A normal, valid-looking standard
// directory two segments deep passes on purpose — the safety comes from ensureDataDirs
// (runtime/datadir.ts), which resolves the canonical root through its ancestors and
// provenance-gates every ownership change on the real filesystem before any mkdir/chown.
check(
  "OC_DATA_DIR naming a standard two-segment system directory is accepted (handled safely at the filesystem layer)",
  toSettings({ OC_DATA_DIR: "/var/lib" }).dataDir,
  "/var/lib",
);

// --- toSettings: defaults ----------------------------------------------------------

const minimal = toSettings({ OC_DATA_DIR: "/srv/openclaw/data" });

check("dataDir is passed through", minimal.dataDir, "/srv/openclaw/data");
check("bindAddress defaults to 127.0.0.1", minimal.bindAddress, "127.0.0.1");
check("gatewayPort defaults to 18789", minimal.gatewayPort, "18789");
check("serviceUrl is built from the default bind address and port", minimal.serviceUrl, "http://127.0.0.1:18789");
check("backupDir defaults to a sibling of the data directory's parent", minimal.backupDir, "/srv/openclaw/backups");
check("snapshotDir defaults to a sibling of the data directory's parent", minimal.snapshotDir, "/srv/openclaw/snapshots");
check("image defaults", minimal.image, "ghcr.io/openclaw/openclaw:extended-stable");
check("location defaults to auto", minimal.location, "auto");
check("wslDistro defaults", minimal.wslDistro, "Ubuntu-24.04");
check("sshHost defaults to empty", minimal.sshHost, "");
check("remotePath defaults", minimal.remotePath, "/opt/openclaw");
check("env is carried through unchanged", minimal.env, { OC_DATA_DIR: "/srv/openclaw/data" });

// --- toSettings: explicit values override every default ----------------------------

const full = toSettings({
  OC_DATA_DIR: "/srv/openclaw/data",
  OC_BIND_ADDRESS: "0.0.0.0",
  OPENCLAW_GATEWAY_PORT: "9999",
  OC_BACKUP_DIR: "/custom/backups",
  OC_SNAPSHOT_DIR: "/custom/snapshots",
  OPENCLAW_IMAGE: "example.com/openclaw:custom",
  OC_TARGET_LOCATION: "ssh",
  OC_WSL_DISTRO: "Debian",
  OC_SSH_HOST: "user@example.com",
  OC_REMOTE_PATH: "/home/user/openclaw",
});

check("bindAddress override", full.bindAddress, "0.0.0.0");
check("gatewayPort override", full.gatewayPort, "9999");
check("serviceUrl reflects the overridden address and port", full.serviceUrl, "http://0.0.0.0:9999");
check("backupDir override bypasses the derived default", full.backupDir, "/custom/backups");
check("snapshotDir override bypasses the derived default", full.snapshotDir, "/custom/snapshots");
check("image override", full.image, "example.com/openclaw:custom");
check("location override", full.location, "ssh");
check("wslDistro override", full.wslDistro, "Debian");
check("sshHost override", full.sshHost, "user@example.com");
check("remotePath override", full.remotePath, "/home/user/openclaw");

process.stderr.write(failed === 0 ? "all env checks passed\n" : `${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
