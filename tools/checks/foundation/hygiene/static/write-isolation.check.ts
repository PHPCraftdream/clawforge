// Write-isolation hygiene for the checks tree, enforced as an invariant: every write-shaped
// call must target an isolated sandbox (tmpdir/mkdtemp/isolatedAppsRoot/apps.root or a
// value propagated from one), never a path anchored at the physical checkout — and every
// createApp call must be sandboxed. The analysis lives in write-isolation-rules.ts; this
// file self-checks it on in-memory snippets, then scans the real tree. ALLOW is empty and
// must stay empty — a hit fails by name; legitimate shapes are handled by tightening the
// rule, never by allow-listing.

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, finish } from "#checks/kit/harness.ts";
import { analyze, type Hit } from "./write-isolation-rules.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const checksRoot = resolve(repoRoot, "tools", "checks");

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

// --- self-check: table-driven, in-memory, every case asserts the exact classification -----

const CREATE_APP = `import { createApp } from "#framework/integration/deployment/scaffold.ts";`;

type SelfCase = { name: string; source: string; createApp: boolean; writes: string[] };

// writes entries are "call[classification]" — the exact expected classification per hit.
const SELF_CASES: SelfCase[] = [
  {
    name: "3-argument resolve(monorepoRoot, apps, name) write",
    source: `await writeFile(resolve(monorepoRoot, "apps", "probe"), "x");`,
    createApp: false,
    writes: ["writeFile[ANCHORED]"],
  },
  {
    name: "mkdir under monorepoRoot",
    source: `await mkdir(resolve(monorepoRoot, "docs", "x"), { recursive: true });`,
    createApp: false,
    writes: ["mkdir[ANCHORED]"],
  },
  {
    name: "rm over the checkout apps dir",
    source: `await rm(join(monorepoRoot, "apps"));`,
    createApp: false,
    writes: ["rm[ANCHORED]"],
  },
  {
    name: "appendFile onto a repo-root log",
    source: `await appendFile(join(monorepoRoot, "log"), "x");`,
    createApp: false,
    writes: ["appendFile[ANCHORED]"],
  },
  {
    name: "copyFile with a bare relative destination",
    source: `await copyFile(resolve(monorepoRoot, "a"), "b");`,
    createApp: false,
    writes: ["copyFile[ANCHORED]"],
  },
  {
    name: "fs.writeFileSync anchored at process.cwd()",
    source: `fs.writeFileSync(path.resolve(process.cwd(), "o.txt"), "");`,
    createApp: false,
    writes: ["writeFileSync[ANCHORED]"],
  },
  {
    name: "bare relative string-literal target",
    source: `await writeFile("tools/clawforge.ts", "x");`,
    createApp: false,
    writes: ["writeFile[ANCHORED]"],
  },
  {
    name: "import.meta-derived root write (upward URL escape)",
    source: `await writeFile(new URL("../../probe.txt", import.meta.url), "x");`,
    createApp: false,
    writes: ["writeFile[ANCHORED]"],
  },
  {
    name: "createApp with no isolation anywhere",
    source: `${CREATE_APP}\nawait createApp("x");`,
    createApp: true,
    writes: [],
  },
  {
    name: "isolatedAppsRoot imported but never called + createApp",
    source: `${CREATE_APP}\nimport { isolatedAppsRoot } from "#checks/kit/harness.ts";\nawait createApp("x");`,
    createApp: true,
    writes: [],
  },
  {
    name: "isolatedAppsRoot variable + apps.root write",
    source: `const apps = await isolatedAppsRoot("probe");\nawait createApp("x");\nawait writeFile(resolve(apps.root, "f"), "x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "mkdtemp(tmpdir()) root + write under it",
    source: `const root = await mkdtemp(join(tmpdir(), "p-"));\nawait writeFile(join(root, "f"), "x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "three-line propagation sc -> scApps -> write",
    source: `const sc = await mkdtemp(join(tmpdir(), "sc-"));\nconst scApps = join(sc, "apps");\nawait writeFile(resolve(scApps, "f"), "x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "createApp alongside an isolatedAppsRoot CALL",
    source: `${CREATE_APP}\nconst apps = await isolatedAppsRoot("probe");\nawait createApp("x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "clean apps-dir env redirect + createApp",
    source: `const sc = await mkdtemp(join(tmpdir(), "sc-"));\nprocess.env["CLAWFORGE_CHECKS_APPS_DIR"] = join(sc, "apps");\nawait createApp("x");`,
    createApp: false,
    writes: [],
  },
  {
    name: "readdir is a read, not a write",
    source: `await readdir(resolve(monorepoRoot, "apps"));`,
    createApp: false,
    writes: [],
  },
  {
    name: "file-local new URL(./, import.meta.url) fixture write",
    source: `await writeFile(new URL("./fixtures/f.txt", import.meta.url), "x");`,
    createApp: false,
    writes: [],
  },
];

for (const selfCase of SELF_CASES) {
  const result = analyze(selfCase.source);
  const actual = {
    createAppWithoutIsolation: result.createAppWithoutIsolation,
    writes: result.writes.map((hit: Hit) => `${hit.call}[${hit.classification}]`),
  };
  check(`write-isolation self: ${selfCase.name}`, actual, {
    createAppWithoutIsolation: selfCase.createApp,
    writes: selfCase.writes,
  });
}

// --- real-tree scan -----------------------------------------------------------------------

// tools/checks/kit/self/** is skipped: those checks write apps/ decoys on purpose to test
// the run-guard.
const SKIP_SEGMENTS = new Set(["node_modules", "dist"]);
function isSkipped(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  if (segments.includes("kit") && segments.includes("self")) return true;
  return segments.some((segment) => SKIP_SEGMENTS.has(segment));
}

// Must stay empty — any hit fails the check by name; tighten the rule instead.
const ALLOW: readonly string[] = [];

const files = (await walk(checksRoot)).sort();
// The guard's own file is excluded from the real scan: its self-check table contains the
// anchored patterns by construction (that is exactly what SELF_CASES asserts the analyzer
// flags), so scanning it only re-reports the self-check snippets.
const GUARD_SELF = "tools/checks/foundation/hygiene/static/write-isolation.check.ts";
const writeHits: Array<{ file: string; hit: Hit }> = [];
const createAppOffenders: string[] = [];
let scanned = 0;
for (const file of files) {
  const rel = relative(repoRoot, file).replaceAll("\\", "/");
  if (isSkipped(rel) || rel === GUARD_SELF) continue;
  scanned++;
  const result = analyze(await readFile(file, "utf8"));
  for (const hit of result.writes) writeHits.push({ file: rel, hit });
  if (result.createAppWithoutIsolation) createAppOffenders.push(rel);
}

const unexpectedWrites = writeHits.filter((entry) => !ALLOW.includes(entry.file));

check(
  "write-isolation: no checkout-anchored write in tools/checks",
  unexpectedWrites.map((entry) => `${entry.file} [${entry.hit.call} ${entry.hit.target}]`),
  [],
);
check(
  "write-isolation: no createApp outside an isolated apps sandbox",
  createAppOffenders.filter((file) => !ALLOW.includes(file)),
  [],
);

console.log(
  `write-isolation: ${scanned} files scanned (${files.length} found, 1 guard self-check excluded), ${writeHits.length} anchored writes, ${createAppOffenders.length} unisolated createApp, ${ALLOW.length} allow entries (must stay 0)`,
);
finish("write-isolation");
