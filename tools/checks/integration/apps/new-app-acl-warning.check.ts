// check:requires windows-host
//
// new-app used to print the Windows-ACL/WSL-boundary warning — two ~700-char lines — before
// its "created … next:" block, burying the useful part (docs/internal/review-2026-09-29-round-13.md,
// U8). It must now come after, condensed to one line pointing at the full explanation.
// A real WSL distribution is not needed: wsl.exe is scripted via withToolRunner, the same
// seam private-file.check.ts's own dedupeChecks uses, to force the "exposed" finding.

import { randomBytes } from "node:crypto";
import { createName } from "#framework/core/values/names.ts";
import { resolve } from "node:path";
import { createApp } from "#framework/integration/deployment/scaffold.ts";
import { resetWslBoundaryDedupe, withToolRunner } from "#framework/security/privacy/private-file.ts";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, checkTrue, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";

const utf16ish = (text: string): string => text.split("").join("\0");

/** Answers every wsl.exe call as one distribution that can open the file (the "exposed" case);
 *  everything else (icacls, whoami — the real ACL grant) reaches the real tool. */
const scriptedWsl = async (command: string, args: string[], timeoutMs: number) => {
  if (command.endsWith("wsl.exe")) {
    if (args[0] === "-l") return { code: 0, output: utf16ish("Ubuntu-24.04\r\n") };
    if (args[5] === "cat") return { code: 1, output: "cat: /etc/wsl.conf: No such file or directory" };
    if (args[5] === "sh") return { code: 0, output: "OPEN\n" };
  }
  const result = await spawnLocal(command, args, { allowFailure: true, timeoutMs });
  return { code: result.code, output: `${result.stdout}${result.stderr}` };
};

const name = `new-app-acl-check-${randomBytes(4).toString("hex")}`;
const apps = await isolatedAppsRoot("new-app-acl-warning");
try {
  resetWslBoundaryDedupe();
  let output = "";
  await withToolRunner(scriptedWsl, () =>
    withOutputSink((chunk) => {
      output += chunk;
    }, () => createApp(createName("deployment", name))));

  const createdIndex = output.indexOf(`created ${resolve(apps.root, name)}`);
  const nextIndex = output.indexOf("next:");
  const boundaryIndex = output.indexOf("https://github.com/PHPCraftdream/clawforge/blob/main/docs/guide/requirements.md#windows-acl-and-the-wsl-boundary");

  check("new-app's output names what it created", createdIndex !== -1, true);
  check("...and prints a next: block", nextIndex !== -1, true);
  check("...and reports the WSL boundary, scripted as exposed", boundaryIndex !== -1, true);
  checkTrue("created … comes before next:", createdIndex < nextIndex);
  checkTrue("the ACL/WSL-boundary note comes after next:, not before created", nextIndex < boundaryIndex);
  checkTrue("the note is condensed — one line, not the old two-paragraph warning", !output.includes("optional hardening:"));
} finally {
  await apps.dispose();
}

finish("new-app-acl-warning");
