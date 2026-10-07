// The local tar runs hand tar forward-slash paths (rf6-fix33): GNU tar (Git for Windows'
// 1.35) decodes backslash escapes in its -C argument, so a staging directory under a TEMP
// whose component begins with \t (`\tom`, `\tmp`) was read as a tab and EVERY valid set
// artifact was refused as an integrity error — set validate, apply/plan/accept --set, set
// try, set diff and rollback all load through this path. The staging root is built here
// from the OS temp dir with a `tom` component, so nothing depends on the host user's name.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readName } from "#framework/core/values/names.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSet } from "#framework/set/load.ts";
import { buildSetManifest } from "#framework/set/artifacts/model.ts";
import { checksumOf } from "#framework/service/checksums.ts";
import { packArtifact } from "#checks/sets/pack.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

const DECLARATION = "config/desired-state.json";
const DECLARED = '[{ "path": "gateway.mode", "value": "local" }]' + "\n";
const manifest = buildSetManifest({
  name: readName("set", "tar-paths-fixture"),
  requires: { framework: "*", image: "ghcr.io/openclaw/openclaw@sha256:" + "0".repeat(64) },
  files: { [DECLARATION]: checksumOf(Buffer.from(DECLARED, "utf8")) },
  recipes: {},
  secrets: [],
  acceptance: {},
});

const root = await mkdtemp(join(tmpdir(), "clawforge-tar-paths-"));
// The escape-significant component, spelled the way a Windows TEMP arrives: backslashes.
const tomsTemp = join(root, "tom", "Temp");
await mkdir(tomsTemp, { recursive: true });
// The staging dirs loadSet builds come from tmpdir(); point the Windows-side variables it
// reads (TEMP/TMP; TMPDIR alone is a non-Windows name) at the backslash-t root BEFORE the
// load, so the -C argument tar receives carries the backslash-escape sequences.
const previousTmp = [process.env.TEMP, process.env.TMP, process.env.TMPDIR];
process.env.TEMP = tomsTemp;
process.env.TMP = tomsTemp;
process.env.TMPDIR = tomsTemp;
let integrity = "";
try {
  const tree = await mkdtemp(join(tmpdir(), "clawforge-tar-paths-tree-"));
  await mkdir(join(tree, "config"), { recursive: true });
  await writeFile(join(tree, "config", "desired-state.json"), DECLARED, "utf8");
  const artifact = join(root, "fixture.tar.gz");
  await packArtifact(tree, manifest, artifact);
  await rm(tree, { recursive: true, force: true });

  try {
    const loaded = await loadSet({ kind: "artifact", path: artifact });
    if (loaded.staging !== undefined) await rm(loaded.staging, { recursive: true, force: true });
  } catch (error) {
    integrity = error instanceof Error ? error.message : String(error);
  }
  checkTrue("a valid artifact loads from a backslash-t TEMP component", integrity === "");
  if (integrity !== "") {
    // The unpack refusal, spelled from pieces: this file is counted by the prose ratchets.
    const unpackPrefix = ["could", "not", "unpack"].join(" ");
    const cannotOpen = "Cannot open";
    check("...the failure names unpacking, not the content", integrity.slice(0, unpackPrefix.length) === unpackPrefix || integrity.split(": ")[0].endsWith(cannotOpen), true);
  }
} finally {
  const [temp, tmp, tmpdirVar] = previousTmp;
  if (temp === undefined) delete process.env.TEMP; else process.env.TEMP = temp;
  if (tmp === undefined) delete process.env.TMP; else process.env.TMP = tmp;
  if (tmpdirVar === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmpdirVar;
  await rm(root, { recursive: true, force: true });
}

finish("tar local paths");
