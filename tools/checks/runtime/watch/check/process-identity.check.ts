// Windows birth-time parsing and owner identity: no WMIC/ps execution, only existing signal-0 checks.
import { check, finish } from "#checks/kit/harness.ts";
import {
  localLiveness, machineName, parseWindowsProcessStartedAt, platformProbes,
} from "#framework/runtime/lock/process-identity.ts";

const births = [
  {
    name: "positive offset subtracts minutes and crosses into the previous UTC day",
    output: "\r\nCreationDate=20261009013045.123456+330\r\n\r\n",
    utc: "2026-10-08T20:00:45.123Z",
  },
  {
    name: "negative offset adds minutes and crosses into the next UTC day",
    output: "CreationDate=20261008233045.987654-210\n",
    utc: "2026-10-09T03:00:45.987Z",
  },
];
const inconclusive = [
  { name: "missing CreationDate", output: "" },
  { name: "empty CreationDate", output: "CreationDate=" },
  { name: "ambiguous duplicate dates", output: `${births[0]!.output}${births[1]!.output}` },
  { name: "ambiguous identical dates", output: `${births[0]!.output}${births[0]!.output}` },
  { name: "bare fourteen digits", output: "CreationDate=20261009013045" },
  { name: "missing offset", output: "CreationDate=20261009013045.123456" },
  { name: "truncated offset", output: "CreationDate=20261009013045.123456+33" },
  { name: "unsupported four-digit offset", output: "CreationDate=20261009013045.123456+1000" },
  { name: "unsupported colon offset", output: "CreationDate=20261009013045.123456+05:30" },
  { name: "unsigned offset", output: "CreationDate=20261009013045.123456330" },
  { name: "unknown offset", output: "CreationDate=20261009013045.123456+***" },
  { name: "wildcard date", output: "CreationDate=2026****013045.123456+330" },
  { name: "truncated microseconds", output: "CreationDate=20261009013045.123+330" },
  { name: "truncated seconds", output: "CreationDate=2026100901304.123456+330" },
  { name: "trailing garbage", output: "CreationDate=20261009013045.123456+330junk" },
  { name: "non-leap February 29", output: "CreationDate=20260229013045.123456+330" },
  { name: "April 31", output: "CreationDate=20260431013045.123456+330" },
  { name: "zero year", output: "CreationDate=00001009013045.123456+330" },
  { name: "zero month", output: "CreationDate=20260009013045.123456+330" },
  { name: "month thirteen", output: "CreationDate=20261309013045.123456+330" },
  { name: "zero day", output: "CreationDate=20261000013045.123456+330" },
  { name: "hour twenty-four", output: "CreationDate=20261009243045.123456+330" },
  { name: "minute sixty", output: "CreationDate=20261009016045.123456+330" },
  { name: "unsupported leap second", output: "CreationDate=20261009013060.123456+330" },
];

const originalTZ = process.env.TZ;
const originalProbe = platformProbes.processStartedAt;
try {
  // Both Node zones differ from both WMIC offsets; expected UTC values are independent literals.
  for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
    process.env.TZ = tz;
    for (const birth of births) {
      check(`${tz}: ${birth.name}`, parseWindowsProcessStartedAt(birth.output), birth.utc);
      let queriedPid: number | undefined;
      platformProbes.processStartedAt = async (pid) => {
        queriedPid = pid;
        return birth.utc;
      };
      const record = { pid: process.pid, machine: machineName(), startedAt: birth.utc };
      check(`${tz}: same-record ${birth.name} owner remains alive`, await localLiveness(record), "alive");
      check(`${tz}: birth query targets the actual owner pid`, queriedPid, process.pid);
      check(`${tz}: genuinely different birth proves reused pid dead`, await localLiveness({
        ...record, startedAt: "2026-10-07T00:00:00.000Z",
      }), "dead");
    }
  }
  check("leap-day calendar is accepted", parseWindowsProcessStartedAt(
    "CreationDate=20240229235959.999999+000",
  ), "2024-02-29T23:59:59.999Z");
  check("small year is not remapped to 1901", parseWindowsProcessStartedAt(
    "CreationDate=00010101000000.000001-000",
  ), "0001-01-01T00:00:00.000Z");
  check("sub-millisecond precision is floored, not rounded into the next second", parseWindowsProcessStartedAt(
    "CreationDate=20261009013045.999999+330",
  ), "2026-10-08T20:00:45.999Z");

  const record = { pid: process.pid, machine: machineName(), startedAt: "2026-10-08T20:00:45.123Z" };
  for (const invalid of inconclusive) {
    check(`${invalid.name} supplies no birth evidence`, parseWindowsProcessStartedAt(invalid.output), undefined);
    platformProbes.processStartedAt = async () => undefined;
    check(`${invalid.name} cannot prove owner death`, await localLiveness(record), "alive");
  }
  platformProbes.processStartedAt = async () => undefined;
  check("unavailable WMIC birth probe keeps an existing pid alive", await localLiveness(record), "alive");

  // The independently specified records straddle the unchanged 15-second boundary by one ms.
  platformProbes.processStartedAt = async () => "2026-10-08T20:00:45.123Z";
  for (const [startedAt, expected] of [
    ["2026-10-08T20:00:30.123Z", "alive"],
    ["2026-10-08T20:00:30.122Z", "dead"],
    ["2026-10-08T20:01:00.123Z", "alive"],
    ["2026-10-08T20:01:00.124Z", "dead"],
  ] as const) {
    check(`literal tolerance boundary ${startedAt}`, await localLiveness({ ...record, startedAt }), expected);
  }
} finally {
  platformProbes.processStartedAt = originalProbe;
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
}
finish("Windows process identity");
