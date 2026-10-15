import { randomBytes } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { check, checkTrue, finish, requires } from "#checks/kit/harness.ts";
import { acceptsNativeBash, bashCommand, gnuTarCommand, nativeToolCandidates, selectNativeTool, type ToolHost } from "./native-tools.ts";

const literal = 'literal $DO_NOT_EXPAND_CF $(printf unexpected-substitution) "$@" $1';
const forward = (path: string): string => path.replaceAll("\\", "/");
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
interface ConsumerOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
}
function consume(binary: string, args: string[], options: ConsumerOptions): SpawnSyncReturns<string> {
  return spawnSync(binary, args, {
    ...options, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
    maxBuffer: 64 * 1024, shell: false, windowsHide: true,
  });
}
function cleanExit(label: string, result: SpawnSyncReturns<string>): void {
  check(`${label}: child completed`, [result.status, result.signal, result.error?.message], [0, null, undefined]);
}

const calls: string[] = [];
const accepted = await selectNativeTool({
  platform: "win32",
  candidates: ["C:/Windows/System32/bash.exe", "C:/Users/operator/AppData/Local/Microsoft/WindowsApps/bash.exe", "C:/Git/usr/bin/bash.exe"],
  accepts: (binary) => { calls.push(binary); return Promise.resolve(true); },
});
check("exit-zero WSL candidates never reach native acceptance", calls, ["C:/Git/usr/bin/bash.exe"]);
check("selection returns the accepted candidate unchanged", accepted, "C:/Git/usr/bin/bash.exe");
check("failed native acceptance has no PATH fallback", await selectNativeTool({
  platform: "win32", candidates: ["C:/Git/usr/bin/bash.exe"], accepts: () => Promise.resolve(false),
}), undefined);

await requires("windows-host", "native Bash rejects Windows WSL launchers", async () => {
  const windows = process.env.SystemRoot ?? "C:/Windows";
  check("System32 Bash is not a local native capability", await acceptsNativeBash(join(windows, "System32", "bash.exe")), false);
  check("Sysnative Bash is not a local native capability", await acceptsNativeBash(join(windows, "Sysnative", "bash.exe")), false);
});

async function independentBash(binary: string): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "clawwright-independent-native-"));
  try {
    const printer = join(root, "native.cjs");
    await writeFile(printer, "const fs=require('node:fs');fs.writeFileSync('native-owned',process.argv[2]);process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    await writeFile(join(root, "source"), "original");
    await writeFile(join(root, "target"), "occupied");
    const script = [
      'PATH="/usr/bin:/bin:$PATH"; export PATH',
      'mv -nT source target || exit',
      'test -f source && test "$(cat target)" = occupied || exit 91',
      'rm target && mv -nT source target || exit',
      `node=${quote(forward(process.execPath))}`,
      'if command -v cygpath >/dev/null 2>&1; then node=$(cygpath -u "$node") || exit; fi',
      `exec "$node" ${quote(forward(printer))} "$1"`,
    ].join("\n");
    const result = consume(binary, ["-c", script, "independent", literal], { cwd: root });
    return result.status === 0 && result.error === undefined
      && result.stdout === JSON.stringify([literal])
      && await readFile(join(root, "native-owned"), "utf8") === literal
      && await readFile(join(root, "target"), "utf8") === "original"
      && !(await stat(join(root, "source")).then(() => true, () => false));
  } catch { return false; }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function knownBashFiles(): Promise<string[]> {
  const env = { ...process.env };
  const get = (key: string): string | undefined => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  const dirs = (get("PATH") ?? "").split(delimiter).slice(0, 128).map((dir) => dir.replace(/^"(.*)"$/, "$1"));
  const windows = process.platform === "win32";
  const files = dirs.map((dir) => resolve(dir || process.cwd(), windows ? "bash.exe" : "bash"));
  if (windows) {
    const roots = dirs.filter(Boolean).flatMap((dir) => [resolve(dir, ".."), resolve(dir, "..", "..")]);
    for (const key of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
      const base = get(key);
      if (base !== undefined) roots.push(join(base, "Git"));
    }
    const local = get("LOCALAPPDATA");
    if (local !== undefined) roots.push(join(local, "Programs", "Git"));
    const home = get("USERPROFILE");
    if (home !== undefined) roots.push(join(home, "scoop", "apps", "git", "current"));
    const drive = get("SystemDrive") ?? "C:";
    roots.push(`${drive}/Program Files/Git`, `${drive}/cygwin64`, `${drive}/cygwin`);
    for (const root of roots) for (const bin of ["usr/bin", "bin"]) files.push(join(root, bin, "bash.exe"));
  }
  const found = new Set<string>();
  for (const file of files) {
    if (/\/(?:system32|sysnative|syswow64|windowsapps)(?:\/|$)/i.test(forward(file))) continue;
    try {
      const binary = await realpath(file);
      if (!/\/(?:system32|sysnative|syswow64|windowsapps)(?:\/|$)/i.test(forward(binary)) && (await stat(binary)).isFile()) found.add(binary);
    } catch {}
  }
  return [...found].slice(0, 16);
}
let workingBash: string | undefined;
for (const candidate of await knownBashFiles()) {
  if (await independentBash(candidate)) { workingBash = candidate; break; }
}
const positiveBash = await bashCommand();
if (workingBash !== undefined) checkTrue("independently working native Bash must be selected", positiveBash !== undefined);

await requires("windows-host", "Windows native consumer", () => requires("bash", "selected Bash native consumer witnesses", async () => {
  const binary = await bashCommand();
  checkTrue("consumer receives an absolute Bash executable", binary !== undefined && isAbsolute(binary));
  if (binary === undefined) return;
  const root = await mkdtemp(join(tmpdir(), "clawwright native consumer $ quote'-"));
  try {
    const printer = join(root, "argv.cjs");
    await writeFile(printer, "process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));");
    await mkdir(join(root, "work"));
    await writeFile(join(root, "work", "source"), "source-payload");
    await writeFile(join(root, "work", "target"), "occupied-target");
    const script = [
      'PATH="/usr/bin:/bin:$PATH"; export PATH',
      `root=${quote(forward(root))}; node=${quote(forward(process.execPath))}`,
      'if command -v cygpath >/dev/null 2>&1; then root=$(cygpath -u "$root") || exit; node=$(cygpath -u "$node") || exit; fi',
      'cd "$root" || exit',
      'mv -nT work/source work/target || exit',
      'test -f work/source && test "$(cat work/target)" = "occupied-target" || exit 81',
      'rm work/target || exit',
      'mv -nT work/source work/target || exit',
      'test ! -e work/source && test -f work/target || exit 82',
      `exec "$node" ${quote(forward(printer))}`,
    ].join("\n");
    const native = consume(binary, ["-s"], { cwd: root, input: script });
    cleanExit("native filesystem transition", native);
    const answer = JSON.parse(native.stdout || "null") as { argv: string[]; cwd: string } | null;
    check("native Node runs in the consumer filesystem", answer === null ? undefined : await realpath(answer.cwd), await realpath(root));
    check("mv -nT moved the original file into the absent target", await readFile(join(root, "work", "target"), "utf8"), "source-payload");
    check("mv -nT removed only the moved source", await stat(join(root, "work", "source")).then(() => true, () => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}));

await requires("windows-host", "Windows GNU archive consumer", async () => {
const tar = await gnuTarCommand();
checkTrue("Windows regression host supplies verified GNU tar", tar !== undefined);
if (tar !== undefined) {
  checkTrue("GNU tar consumer receives an absolute executable", isAbsolute(tar));
  const root = await mkdtemp(join(tmpdir(), "clawwright tar consumer $ quote'-"));
  try {
    const source = join(root, "source");
    const output = join(root, "output");
    await mkdir(source);
    await mkdir(output);
    const payload = randomBytes(64);
    payload[0] = 0;
    await writeFile(join(source, "payload"), payload);
    const archive = forward(join(root, "artifact.tar.gz"));
    const flags = process.platform === "win32" ? ["--force-local"] : [];
    const identity = consume(tar, ["--version"], { cwd: root });
    cleanExit("GNU tar identity", identity);
    check("assembler receives GNU rather than BSD tar", identity.stdout.split(/\r?\n/)[0]?.split(" ").slice(0, 3), ["tar", "(GNU", "tar)"]);
    cleanExit("GNU tar create", consume(tar, [...flags, "-czf", archive, "-C", forward(source), "."], { cwd: root }));
    const list = consume(tar, [...flags, "-tzf", archive], { cwd: root });
    cleanExit("GNU tar list", list);
    checkTrue("artifact inventories the payload", list.stdout.split(/\r?\n/).includes("./payload"));
    cleanExit("GNU tar extract", consume(tar, [...flags, "-xzf", archive, "-C", forward(output)], { cwd: root }));
    check("artifact roundtrip preserves consumer bytes", await readFile(join(output, "payload")), payload);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

});

await requires("windows-host", "cache follows real noninteractive Bash environment", async () => {
  if (workingBash === undefined) {
    await requires("bash", "cache requires an independently working native Bash", async () => {
      checkTrue("cache witness independently resolves native Bash", false);
    });
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "clawwright-bash-env-cache-"));
  try {
    const startup = join(root, "reject.sh");
    await writeFile(startup, "exit 97\n");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === "BASH_ENV") delete env[key];
    const snapshot: ToolHost = { platform: process.platform, env, cwd: root };
    const first = await bashCommand(snapshot);
    checkTrue("cache witness starts with positive native selection", first !== undefined);
    const rejected: ToolHost = { ...snapshot, env: { ...env, BASH_ENV: forward(startup) } };
    const direct = consume(workingBash, ["-c", 'printf "%s" "$1"', "cache", literal], { cwd: root, env: rejected.env });
    check("BASH_ENV independently prevents native consumer execution", [direct.status, direct.error?.message, direct.stdout], [97, undefined, ""]);
    check("BASH_ENV rejection invalidates cached native selection", await bashCommand(rejected), undefined);
    const restored = await bashCommand(snapshot);
    checkTrue("restored child environment selects native Bash again", restored !== undefined);
    if (restored !== undefined) {
      const consumer = consume(restored, ["-c", 'printf "%s" "$1"', "cache", literal], { cwd: root, env });
      cleanExit("restored native cache consumer", consumer);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

await requires("posix-host", "empty PATH components use captured cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawwright-posix-candidates-"));
  try {
    const other = join(root, "other");
    await mkdir(other);
    const fixture = join(root, "bash");
    const secondFixture = join(root, "other", "bash");
    const ownedExecutable = `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync('executed',process.cwd());\n`;
    await writeFile(fixture, ownedExecutable);
    await chmod(fixture, 0o755);
    await writeFile(secondFixture, ownedExecutable);
    await chmod(secondFixture, 0o755);
    const defaults: string[] = [];
    for (const dir of ["/usr/bin", "/bin"]) {
      try {
        const binary = await realpath(join(dir, "bash"));
        if ((await stat(binary)).isFile() && !defaults.includes(binary)) defaults.push(binary);
      } catch {}
    }
    const absent: ToolHost = { platform: process.platform, env: {}, cwd: root };
    check("absent POSIX PATH discovers native default files, not cwd", await nativeToolCandidates("bash", absent), defaults);
    let independentlyUsableDefault = false;
    for (const binary of defaults) {
      const direct = consume(binary, ["-c", 'printf "%s" "$1"', "independent-default", literal], { cwd: root, env: {} });
      if (direct.status === 0 && direct.error === undefined && direct.stdout === literal) independentlyUsableDefault = true;
    }
    const defaultSelection = await bashCommand(absent);
    if (independentlyUsableDefault) checkTrue("independently usable default POSIX Bash must be selected", defaultSelection !== undefined);
    if (defaultSelection !== undefined) {
      checkTrue("absent PATH selection belongs to native default filesystem", defaults.includes(defaultSelection));
      const result = consume(defaultSelection, ["-c", 'printf "%s" "$1"', "default", literal], { cwd: root, env: {} });
      cleanExit("default POSIX Bash consumer", result);
    }
    const emptySelection = await bashCommand({ platform: process.platform, env: { PATH: "" }, cwd: root });
    check("explicit empty POSIX PATH selects owned cwd executable", emptySelection, await realpath(join(root, "bash")));
    if (emptySelection !== undefined) {
      const result = consume(emptySelection, [literal], { cwd: root, env: { PATH: "" } });
      cleanExit("empty PATH owned consumer", result);
      check("owned executable runs in captured filesystem", await realpath(await readFile(join(root, "executed"), "utf8")), await realpath(root));
    }
    const host = { platform: process.platform, env: { PATH: ":/missing:" }, cwd: root };
    const pending = bashCommand(host);
    host.env.PATH = "/missing";
    host.cwd = other;
    const original = await pending;
    check("selection keeps discovery's captured empty-component cwd", original, await realpath(join(root, "bash")));
    if (original !== undefined) {
      const result = consume(original, [literal], { cwd: root });
      cleanExit("owned POSIX executable", result);
    }
    const next = await bashCommand({ platform: process.platform, env: { PATH: "" }, cwd: other });
    check("cwd changes invalidate selection", next, await realpath(join(other, "bash")));
    check("PATH changes invalidate positive selection", await bashCommand({ platform: process.platform, env: { PATH: "/missing" }, cwd: root }), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
const candidates = await nativeToolCandidates("bash");
checkTrue("discovery returns resolved files rather than PATH words", candidates.every(isAbsolute));
finish("native tool selection");
