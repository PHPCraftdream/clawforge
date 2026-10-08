// The S1.4 independent literals (I11), moved out of advice-matrix.check.ts to keep that
// file under the layout limit: the case-4 selector, the unknown-root fallback and the
// changeDirectory alternatives, asserted against strings written by hand — the renderer
// is never read back.

import { resolve } from "node:path";
import { resolveInstalledEntry, type FsProbe } from "#framework/entry/resolve.ts";
import { parsePaste } from "#checks/kit/shells.ts";
import { changeDirectory, command } from "#framework/core/io/invocation/advice.ts";
import { CWD_CONFLICT_NOTE, renderAdviceRows, renderFrameAdvice } from "#framework/core/io/invocation/render.ts";
import { forShell, type Frame } from "#framework/core/io/invocation/frame.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

// --- S1.4 independent literals (I11): the case-4 selector, the unknown-root fallback and
// the changeDirectory alternatives, asserted against strings written by hand — the renderer
// is never read back.

/** A system launch in apps/Y on a Windows host that also pastes cmd and PowerShell, with
 *  the checkout root known: the exact case-4 shape (decision O2). */
const case4 = (checkout: string): Frame => ({
  launch: { kind: "system" },
  host: { kind: "operator", platform: "win32" },
  shells: ["cmd", "pwsh"],
  cwd: { kind: "dir", path: `${checkout}/apps/Y` },
  places: { checkoutRoot: checkout },
  app: { state: "selected", name: "Y", by: "cwd" },
  audience: "terminal",
});
check(
  "case 4 names the other deployment with --project-root",
  renderFrameAdvice(command(["destroy"], { app: "X" }), case4("/co")).split(" "),
  ["clawforge", "--project-root", "/co/apps/X", "destroy"],
);
check(
  "case 4 quotes the --project-root path for cmd/pwsh by the frame's shells rule",
  renderFrameAdvice(command(["destroy"], { app: "X" }), case4("/co with space")).split(" "),
  ["clawforge", "--project-root", '"/co', "with", 'space/apps/X"', "destroy"],
);
check(
  "case 4 under a posix-only frame single-quotes the --project-root path",
  renderFrameAdvice(command(["destroy"], { app: "X" }), { ...case4("/co with space"), shells: ["posix"] }).split(" "),
  ["clawforge", "--project-root", "'/co", "with", "space/apps/X'", "destroy"],
);
check(
  "case 4 carries no --app and no note",
  renderFrameAdvice(command(["destroy"], { app: "X" }), case4("/co")).includes("--app")
    || renderFrameAdvice(command(["destroy"], { app: "X" }), case4("/co")).includes(CWD_CONFLICT_NOTE),
  false,
);
check("R1-A-2 external cwd retains frame by-cwd selection", renderFrameAdvice(command(["destroy"], { app: "X" }), {
  ...case4("/co"), cwd: { kind: "dir", path: "/external/deployment" },
}).split(" "), ["clawforge", "--project-root", "/co/apps/X", "destroy"]);

const unknownRootFrame: Frame = { ...case4("/co"), places: {} };
check(
  "the unknown-root cwd-conflict fallback keeps the re-rooted row with the paste-conflict note",
  renderFrameAdvice(command(["destroy"], { app: "X" }), unknownRootFrame).split(" "),
  ["clawforge", "--app", "X", "destroy", "", "(from", "the", "checkout", "root)"],
);

// R1-A-2 / O2: the prior --project-root selected aux by flag, but a fresh paste
// still starts in demo. Both explicit and inherited app advice must bypass that cwd.
const replayRoot = resolve("/co space $ O'Brien").replaceAll("\\", "/");
const replayFrame: Frame = {
  ...case4(replayRoot),
  cwd: { kind: "dir", path: `${replayRoot}/apps/demo/nested` },
  app: { state: "selected", name: "aux", by: "flag" },
};
const replayFiles = new Set([`${replayRoot}/apps/demo/app.ts`, `${replayRoot}/apps/aux/app.ts`].map((p) => resolve(p)));
const replayFs: FsProbe = {
  exists: (p) => replayFiles.has(resolve(p)),
  isDirectory: () => false,
  readdir: () => [],
  readFile: (p) => replayFiles.has(resolve(p)) ? "export default {};" : undefined,
  realpath: (p) => p,
};
for (const shell of ["cmd", "pwsh", "posix"] as const) {
  for (const advice of [command(["set", "build"], { app: "aux" }), command(["set", "build"])]) {
    const line = renderFrameAdvice(advice, forShell(replayFrame, shell));
    const words = parsePaste(line, shell).words;
    check(`R1-A-2 ${shell}: fresh explicit/inherited aux advice uses O2, not --app`, words,
      ["clawforge", "--project-root", `${replayRoot}/apps/aux`, "set", "build"]);
    const fresh = resolveInstalledEntry({
      cwd: replayFrame.cwd.kind === "dir" ? replayFrame.cwd.path : "",
      rawArgv: words.slice(1), platform: "win32", fs: replayFs,
      frame: { ...forShell(replayFrame, shell), app: { state: "none" } },
    });
    checkTrue(`R1-A-2 ${shell}: real fresh resolver reaches aux/set build`,
      fresh.kind === "run" && fresh.appRoot === resolve(replayRoot, "apps", "aux")
      && JSON.stringify(fresh.argv) === JSON.stringify(["set", "build"]));
  }
}
check("R1-A-2 same-cwd aux still uses --app", renderFrameAdvice(command(["set", "build"]), {
  ...replayFrame, cwd: { kind: "dir", path: `${replayRoot}/apps/aux` },
}).split(" "), ["clawforge", "--app", "aux", "set", "build"]);
check("R1-A-2 checkout-root cwd still uses --app", renderFrameAdvice(command(["set", "build"]), {
  ...replayFrame, cwd: { kind: "dir", path: replayRoot },
}).split(" "), ["clawforge", "--app", "aux", "set", "build"]);

// changeDirectory: the POSIX text quotes by shellQuote (always single quotes), cmd/pwsh
// take pushd unless the path carries `"`, `%`, `$` or a backtick — then cmd has NO safe
// spelling and pwsh falls back to the literal Set-Location.
const cdAdvice = changeDirectory("/co/dir with space");
check("changeDirectory spells the posix cd with single quotes", cdAdvice.text.split(" "), ["cd", "'/co/dir", "with", "space'"]);
check("changeDirectory spells pushd for cmd", cdAdvice.alternatives?.cmd?.split(" "), ["pushd", '"/co/dir', "with", 'space"']);
check("changeDirectory spells pushd for pwsh", cdAdvice.alternatives?.pwsh?.split(" "), ["pushd", '"/co/dir', "with", 'space"']);
const cdDollar = changeDirectory("/co/dir$with space");
checkTrue("changeDirectory gives cmd no alternative for a $ path", cdDollar.alternatives?.cmd === undefined);
check("changeDirectory falls back to Set-Location for pwsh on a $ path", cdDollar.alternatives?.pwsh?.split(" "), ["Set-Location", "-LiteralPath", "'/co/dir$with", "space'"]);

// renderAdviceRows: one row per DISTINCT text among the frame's shells (design §2.3 rule 5).
// changeDirectory's cmd and pwsh alternatives are the same pushd line, so under a frame
// that also pastes cmd/pwsh the row collapses to ONE pushd line (the posix text is not
// primary there); a posix-only frame takes the cd line alone. The for-shell note suffix is
// pinned on a hand-built advice whose two alternatives differ — the shape the renderer's
// distinct-text rule exists for.
const mixedFrame: Frame = {
  launch: { kind: "system" },
  host: { kind: "operator", platform: "win32" },
  shells: ["cmd", "pwsh"],
  cwd: { kind: "dir", path: "/co" },
  places: {},
  app: { state: "none" },
  audience: "terminal",
};
const cdRows = renderAdviceRows(cdAdvice, mixedFrame);
check("the cd advice collapses to one pushd row under [cmd, pwsh]", cdRows.length, 1);
check("the collapsed cd row is the pushd line, no note", cdRows[0]?.split(" "), ["pushd", '"/co/dir', "with", 'space"']);
const posixOnlyRows = renderAdviceRows(cdAdvice, forShell(mixedFrame, "posix"));
check("the cd advice renders exactly 1 row under [posix]", posixOnlyRows.length, 1);
check("the posix-only cd row is the cd line without a note", posixOnlyRows[0]?.split(" "), ["cd", "'/co/dir", "with", "space'"]);
const twoAlternatives = { kind: "shell", shell: "posix", text: "cd '/co/dir with space'", alternatives: { cmd: 'pushd "/co/dir with space"', pwsh: "Set-Location -LiteralPath '/co/dir with space'" } } as const;
const distinctRows = renderAdviceRows(twoAlternatives, mixedFrame);
check("two distinct alternatives render exactly 2 rows under [cmd, pwsh]", distinctRows.length, 2);
check("the first distinct row is the cmd alternative, named for cmd", distinctRows[0]?.split(" "), ["pushd", '"/co/dir', "with", 'space"', "", "(for", "cmd)"]);
check("the second distinct row is the pwsh alternative with the for-shell note", distinctRows[1]?.split(" "), ["Set-Location", "-LiteralPath", "'/co/dir", "with", "space'", "", "(for", "pwsh)"]);
// A path with `$`: cmd has NO alternative and pwsh a Set-Location one — no shell of a
// cmd-only frame yields a line (the POSIX fallback with the bash note), and under
// [cmd, pwsh] the single pwsh row is shell-specific (the for-shell note).
const cmdOnlyRows = renderAdviceRows(cdDollar, forShell(mixedFrame, "cmd"));
check("$-path advice under a cmd-only frame falls back to one bash row", cmdOnlyRows.length, 1);
check("the cmd-only fallback row is the posix line with the bash note", cmdOnlyRows[0]?.split(" "), ["cd", "'/co/dir$with", "space'", "", "(in", "bash)"]);
const dollarRows = renderAdviceRows(cdDollar, mixedFrame);
check("$-path advice under [cmd, pwsh] renders one pwsh row", dollarRows.length, 1);
check("the $-path row is the pwsh alternative with the for-shell note", dollarRows[0]?.split(" "), ["Set-Location", "-LiteralPath", "'/co/dir$with", "space'", "", "(for", "pwsh)"]);
// The review's coverage case: an advice whose ONLY alternative is the frame's PRIMARY shell
// (cmd) — the row's spelling shells are not the frame's full shell set, so the row names its
// shell exactly like a pwsh-only row does.
const cmdPrimaryOnly = { kind: "shell", shell: "posix", text: "cd '/co/dir with space'", alternatives: { cmd: 'pushd "/co/dir with space"' } } as const;
const cmdPrimaryRows = renderAdviceRows(cmdPrimaryOnly, mixedFrame);
check("cmd-only coverage under [cmd, pwsh] renders one row", cmdPrimaryRows.length, 1);
check("the cmd-only row is the cmd line with the for-shell note", cmdPrimaryRows[0]?.split(" "), ["pushd", '"/co/dir', "with", 'space"', "", "(for", "cmd)"]);
// An explicit advice note COMBINES with the shell label (label first) — it never replaces it.
const cmdPrimaryWithNote = { kind: "shell", shell: "posix", text: "cd '/co/dir with space'", note: "after the change", alternatives: { cmd: 'pushd "/co/dir with space"' } } as const;
const noteRows = renderAdviceRows(cmdPrimaryWithNote, mixedFrame);
check("cmd-only coverage with an advice note keeps the shell label first", noteRows[0]?.split(" "), ["pushd", '"/co/dir', "with", 'space"', "", "(for", "cmd;", "after", "the", "change)"]);

finish("advice anchor");
