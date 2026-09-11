// Checks the .env parser and the settings it produces.
//
// parseEnv is deliberately not `source .env`: it must never execute anything the file
// contains, so every parsing rule (quoting, comments, first-`=`-wins) is asserted here
// rather than trusted. toSettings is checked for its required field and its defaults, since
// a wrong default silently points a deployment at the wrong directory or port.

import { parseEnv, toSettings } from "../framework/env.ts";

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

// --- toSettings: required field --------------------------------------------------

try {
  toSettings({});
  check("toSettings without OC_DATA_DIR throws", "did not throw", "UserError: OC_DATA_DIR is not set in .env");
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  check("toSettings without OC_DATA_DIR throws", message, "UserError: OC_DATA_DIR is not set in .env");
}

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
