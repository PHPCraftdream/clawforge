// Probe-level checks for the REAL exported probes (platformProbes.bootIdentity /
// processStartIdentity), driven through probeSeams so no OS command ever spawns. Each
// scenario imports a fresh module instance: the probe memoizes boot identity, so a fresh
// instance is the only way to drive several answers without cache bleed.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";

interface RunResult {
  stdout: string;
}

interface IdentityModule {
  probeSeams: {
    run: (cmd: string, args: string[], opts: object) => Promise<RunResult>;
    readText: (path: string) => Promise<string>;
    platform: () => NodeJS.Platform;
  };
  platformProbes: {
    bootIdentity: () => Promise<string | undefined>;
    processStartIdentity: (pid: number) => Promise<{
      startedAt?: string;
      key?: string;
      source: "native" | "approximate";
    } | undefined>;
  };
}

interface RunCall {
  cmd: string;
  args: string[];
  opts: object;
}

let moduleCase = 0;
async function freshIdentity(): Promise<IdentityModule> {
  moduleCase += 1;
  const resolved = import.meta.resolve("#framework/runtime/lock/process-identity.ts");
  return await import(`${resolved}?probe-case=${moduleCase}`) as IdentityModule;
}

/** Patches the fresh module's seams, restores every field in finally. */
async function withSeams(
  target: IdentityModule,
  seams: Partial<IdentityModule["probeSeams"]>,
  body: () => Promise<void>,
): Promise<void> {
  const originals = {
    run: target.probeSeams.run,
    readText: target.probeSeams.readText,
    platform: target.probeSeams.platform,
  };
  Object.assign(target.probeSeams, seams);
  try {
    await body();
  } finally {
    Object.assign(target.probeSeams, originals);
  }
}

const BOOT_ID = "0123abcd-0000-4000-8000-000000000001";

// The darwin owner-start case parses a timezone-less local date; pin UTC so the expected
// ISO is machine-independent (same trick as watch/check/process-identity.check.ts).
const originalTZ = process.env.TZ;
process.env.TZ = "UTC";
try {
  // --- 1. win CIM boot success ------------------------------------------------------------------------
  {
    const target = await freshIdentity();
    await withSeams(target, {
      platform: () => "win32",
      run: async () => ({ stdout: "2026-10-15T04:12:00Z\n" }),
    }, async () => {
      check("win CIM boot success yields the canonical win id", await target.platformProbes.bootIdentity(), "win:2026-10-15T04:12:00Z");
    });
  }

  // --- 2. win wmic fallback ---------------------------------------------------------------------------
  {
    const target = await freshIdentity();
    const calls: RunCall[] = [];
    await withSeams(target, {
      platform: () => "win32",
      run: async (cmd: string, args: string[], opts: object) => {
        calls.push({ cmd, args, opts });
        if (calls.length === 1) throw new Error("cim unavailable");
        return { stdout: "LastBootUpTime=20261015041200.500000+120\r\n\r\n" };
      },
    }, async () => {
      check("win wmic boot fallback subtracts the DMTF offset", await target.platformProbes.bootIdentity(), "win:2026-10-15T02:12:00Z");
      check("the wmic fallback asked wmic for LastBootUpTime",
        [calls[1]?.cmd, calls[1]?.args], ["wmic", ["os", "get", "LastBootUpTime", "/value"]]);
    });
  }

  // --- 3. darwin boot -----------------------------------------------------------------------------------
  {
    const target = await freshIdentity();
    await withSeams(target, {
      platform: () => "darwin",
      run: async () => ({ stdout: "{ sec = 1760002400, usec = 0 } Sat Oct  9 09:33:20 2025" }),
    }, async () => {
      check("darwin kern.boottime yields the canonical mac id", await target.platformProbes.bootIdentity(), "mac:2025-10-09T09:33:20Z");
    });
  }

  // --- 4. boot probe failure ----------------------------------------------------------------------------
  {
    const target = await freshIdentity();
    await withSeams(target, {
      platform: () => "win32",
      run: async () => { throw new Error("unavailable"); },
    }, async () => {
      check("a failing boot probe is undefined, not a guess", await target.platformProbes.bootIdentity(), undefined);
    });
  }

  // --- 5. foreign-pid owner-start failure ---------------------------------------------------------------
  {
    const target = await freshIdentity();
    await withSeams(target, {
      platform: () => "win32",
      run: async () => { throw new Error("unavailable"); },
    }, async () => {
      const proof = await target.platformProbes.processStartIdentity(424242);
      // A failed probe for another pid is no identity at all — never an approximate object.
      check("a failed owner-start probe for a foreign pid is exactly undefined", proof, undefined);
    });
  }

  // --- 6. own-pid owner-start failure -------------------------------------------------------------------
  {
    const target = await freshIdentity();
    await withSeams(target, {
      platform: () => "win32",
      run: async () => { throw new Error("unavailable"); },
    }, async () => {
      const proof = await target.platformProbes.processStartIdentity(process.pid);
      check("a failed own-pid probe keeps the approximate source", proof?.source, "approximate");
      checkTrue("the approximate answer carries a wall-clock start time", typeof proof?.startedAt === "string");
    });
  }

  // --- 7. win owner-start CIM success -------------------------------------------------------------------
  {
    const target = await freshIdentity();
    await withSeams(target, {
      platform: () => "win32",
      run: async () => ({ stdout: "2026-01-01T00:00:00.000Z\n" }),
    }, async () => {
      check("win CIM owner-start carries full ISO, whole-second key", await target.platformProbes.processStartIdentity(424242),
        { startedAt: "2026-01-01T00:00:00.000Z", key: "win:2026-01-01T00:00:00Z", source: "native" });
    });
  }

  // --- 7b. win owner-start: an impossible CIM date is no identity, never a normalized key ----------------
  {
    const target = await freshIdentity();
    await withSeams(target, {
      platform: () => "win32",
      run: async () => ({ stdout: "2026-02-30T00:00:00.000Z\n" }),
    }, async () => {
      check("an impossible CIM owner-start date yields no identity", await target.platformProbes.processStartIdentity(424242), undefined);
    });
  }

  // --- 8. darwin owner-start ----------------------------------------------------------------------------
  {
    const target = await freshIdentity();
    await withSeams(target, {
      platform: () => "darwin",
      run: async () => ({ stdout: "Mon Oct 13 09:33:20 2025\n" }),
    }, async () => {
      check("darwin owner-start carries the whole-second mac key", await target.platformProbes.processStartIdentity(424242),
        { startedAt: "2025-10-13T09:33:20.000Z", key: "mac:2025-10-13T09:33:20Z", source: "native" });
    });
  }

  // --- 9. linux boot id -----------------------------------------------------------------------------------
  {
    const target = await freshIdentity();
    await withSeams(target, {
      platform: () => "linux",
      readText: async () => `${BOOT_ID}\n`,
    }, async () => {
      check("linux boot_id yields the canonical linux id", await target.platformProbes.bootIdentity(), `linux:${BOOT_ID}`);
    });

    const bad = await freshIdentity();
    await withSeams(bad, {
      platform: () => "linux",
      readText: async () => "not-a-uuid",
    }, async () => {
      check("a malformed boot_id is undefined", await bad.platformProbes.bootIdentity(), undefined);
    });
  }

  // --- 10. linux foreign-pid owner-start ------------------------------------------------------------------
  {
    const target = await freshIdentity();
    // Realistic /proc/<pid>/stat: comm holds a space, starttime (field 22) sits at index 19
    // after the closing paren. Tick count chosen freely — the key is the raw field.
    // Realistic /proc/<pid>/stat: comm holds a space; starttime (field 22) is index 19 after
    // the closing paren — state at index 0, then fields 4..21, then the tick count.
    const stat = `  4242 (node my proc) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654321 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;
    await withSeams(target, {
      platform: () => "linux",
      readText: async (path: string) => {
        checkTrue("the linux owner-start probe read /proc/<pid>/stat", path === "/proc/4242/stat");
        return stat;
      },
    }, async () => {
      check("linux foreign-pid owner-start is tick-key only, no wall time", await target.platformProbes.processStartIdentity(4242),
        { startedAt: undefined, key: "tick:987654321", source: "native" });
    });

    const corrupt = await freshIdentity();
    await withSeams(corrupt, {
      platform: () => "linux",
      readText: async () => "4242 (node) S 1 2",
    }, async () => {
      check("a short /proc stat line yields undefined", await corrupt.platformProbes.processStartIdentity(4242), undefined);
    });
  }

  // --- 11. every spawned call is bounded --------------------------------------------------------------------
  {
    const target = await freshIdentity();
    const calls: RunCall[] = [];
    await withSeams(target, {
      platform: () => "win32",
      run: async (cmd: string, args: string[], opts: object) => {
        calls.push({ cmd, args, opts });
        throw new Error("everything unavailable");
      },
    }, async () => {
      check("an all-failing win probe resolves undefined boot", await target.platformProbes.bootIdentity(), undefined);
      check("an all-failing win probe resolves undefined owner-start", await target.platformProbes.processStartIdentity(424242), undefined);
      check("every spawned call carried the bounded options",
        calls.map((call) => call.opts),
        calls.map(() => ({ timeout: 10_000, windowsHide: true })));
      checkTrue("the wmic fallbacks were actually exercised (2 boot + 2 owner-start calls)", calls.length >= 4);
    });
  }
} finally {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
}
finish("instance lock probe seams");
