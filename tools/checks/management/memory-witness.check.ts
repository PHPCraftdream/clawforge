import { mkdtemp, mkdir, readFile, writeFile, lstat, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nativeFs from "node:fs";
import { spawnSync } from "node:child_process";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { WITNESS_CREATE_SCRIPT, WITNESS_CLEANUP_SCRIPT, type WitnessReceipt } from "#framework/commands/management/configuration/memory/consumer.ts";
const root = nativeFs.realpathSync.native(await mkdtemp(join(tmpdir(), "cf-memory-witness-")));
interface ScriptResult { code: number; output: string; stderr: string }
function script(source: string, args: string[], modeFault?: "directory" | "file"): ScriptResult {
  const shim = `const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const fault=process.argv[1],args=process.argv.slice(2),source=fs.readFileSync(0,'utf8');
const root=fs.realpathSync.native(process.cwd()),identity=fs.lstatSync(root),leases=new Set();
const denied=()=>{throw Error('outside child allocation or unowned descriptor')};
const inside=p=>{const r=path.relative(root,p);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep))};
function canonical(p,follow=true,depth=0,base=root){
  if(typeof p!=='string'||depth>40)denied();
  const raw=path.sep==='/'?p:p.replaceAll('/',path.sep),anchor=path.parse(raw).root;
  let remaining=raw,at=base;
  if(anchor){
    if(!path.isAbsolute(raw))denied();
    const compare=s=>path.sep==='/'?s:s.toLowerCase(),prefix=root.endsWith(path.sep)?root:root+path.sep;
    if(compare(raw)===compare(root))remaining='';
    else if(compare(raw).startsWith(compare(prefix)))remaining=raw.slice(prefix.length);
    else denied();
    at=root;
  }
  if(!inside(at))denied();
  const current=fs.lstatSync(root);if(current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino)denied();
  const parts=remaining.split(path.sep).filter(Boolean);
  for(let i=0;i<parts.length;i++){
    const parent=at;at=path.join(at,parts[i]);
    if(!inside(at))denied();
    if(!follow&&i===parts.length-1&&!raw.endsWith(path.sep)&&parts[i]!=='.'&&parts[i]!=='..')break;
    let s;try{s=fs.lstatSync(at)}catch(e){if(e.code!=='ENOENT')throw e;continue}
    if(s.isSymbolicLink()){
      try{at=fs.realpathSync.native(at);if(!inside(at))denied()}catch(e){if(e.code!=='ENOENT')throw e;at=canonical(fs.readlinkSync(at),true,depth+1,parent)}
    }else{at=fs.realpathSync.native(at);if(!inside(at))denied()}
  }
  if(!inside(at))denied();return at;
}
function checked(p,follow=true){canonical(p,follow);return p}
const lease=fd=>{if(fd<=2||!leases.has(fd))denied();return fd};
function close(fd){lease(fd);try{return fs.closeSync(fd)}finally{leases.delete(fd)}}
function release(){for(const fd of leases){try{fs.closeSync(fd)}catch{}leases.delete(fd)}}
process.on('exit',release);
const metadata=(stat,fault)=>Object.assign(stat,{uid:1000,mode:(stat.mode&~0o077)|(fault?0o004:0)});
const fixture={
  realpathSync:(p,...options)=>fs.realpathSync.native(checked(p),...options),
  lstatSync:(p,...options)=>{const s=fs.lstatSync(checked(p,false),...options);return metadata(s,fault==='directory'&&s.isDirectory())},
  mkdirSync:(p,...options)=>fs.mkdirSync(checked(p),...options),
  openSync:(p,...options)=>{const fd=fs.openSync(checked(p),...options);if(fd<=2){fs.closeSync(fd);denied()}leases.add(fd);return fd},
  fstatSync:(fd,...options)=>metadata(fs.fstatSync(lease(fd),...options),fault==='file'),
  writeFileSync:(p,...options)=>fs.writeFileSync(typeof p==='number'?lease(p):checked(p),...options),
  closeSync:close,
  unlinkSync:(p,...options)=>fs.unlinkSync(checked(p,false),...options),
  rmdirSync:(p,...options)=>fs.rmdirSync(checked(p,false),...options)
};
try{vm.runInNewContext(source,{require:name=>{if(name==='node:fs')return fixture;if(name==='node:path')return {resolve:(...args)=>path.resolve(...args),join:(...args)=>path.join(...args),dirname:p=>path.dirname(p),sep:path.sep};throw Error('unsupported module')},console,process:{platform:'linux',argv:['node',...args],getuid:()=>1000,exit:code=>{release();process.exit(code)}}})}finally{release()}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["NODE_OPTIONS", "NODE_PATH"].includes(name.toUpperCase())));
  const child = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${root}`, `--allow-fs-write=${root}`, "-e", shim, modeFault ?? "", ...args], {
    cwd: root, env, input: source, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
  });
  if (child.error || child.signal || child.status === null || ![0, 2, 73, 74].includes(child.status)) {
    throw Object.assign(Error(`witness child failed: ${child.error?.message ?? child.signal ?? child.status}\n${child.stdout}\n${child.stderr}`), { cause: child.error, signal: child.signal, status: child.status, stdout: child.stdout, stderr: child.stderr });
  }
  return { code: child.status, output: child.stdout, stderr: child.stderr };
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function cleanup(file: string, receipt: WitnessReceipt): ScriptResult { return script(WITNESS_CLEANUP_SCRIPT, [file, String(receipt.dev), String(receipt.ino), JSON.stringify(receipt)]); }
try {
  for (const fault of ["directory", "file"] as const) {
    const workspace = join(root, `unsafe-${fault}`);
    const memory = join(workspace, "memory");
    const file = join(memory, "owned.md");
    await mkdir(workspace);
    const original = await lstat(workspace);
    check(`${fault} public permissions refuse witness creation`, script(WITNESS_CREATE_SCRIPT, [workspace, file, "owned"], fault).code, 74);
    check(`${fault} refusal removes only its owned partial witness`, [await exists(file), await exists(memory)], [false, false]);
    check(`${fault} refusal preserves original workspace identity`, (await lstat(workspace)).ino, original.ino);
  }
  for (const existing of [false, true]) {
    const workspace = join(root, existing ? "existing" : "missing");
    const memory = join(workspace, "memory");
    const file = join(memory, "owned.md");
    await mkdir(workspace); if (existing) await mkdir(memory);
    const previous = existing ? await lstat(memory) : undefined;
    const created = script(WITNESS_CREATE_SCRIPT, [workspace, file, "independent-marker"]);
    check("canonical workspace missing/existing directory create", created.code, 0);
    const receipt = JSON.parse(created.output) as WitnessReceipt;
    check("owned file receipt records uid1000", receipt.uid, 1000);
    check("directory ownership recorded", receipt.directory?.uid, 1000);
    check("directory receipt owned created flag", receipt.directory?.created, !existing);
    check("witness actual bytes", await readFile(file, "utf8"), "independent-marker\n");
    check("receipt directory inode matches", receipt.directory?.ino, (await lstat(memory)).ino);
    check("altered saved file owner refuses cleanup", cleanup(file, { ...receipt, uid: 1001 }).code, 2);
    check("owner refusal leaves witness intact", await readFile(file, "utf8"), "independent-marker\n");
    check("cleanup actual owned file succeeds", cleanup(file, receipt).code, 0);
    check("owned file removed", await exists(file), false);
    check("only newly-created empty directory removed", await exists(memory), existing);
    if (previous) check("existing directory original inode preserved", (await lstat(memory)).ino, previous.ino);
  }
  {
    const workspace = join(root, "concurrent");
    const memory = join(workspace, "memory");
    const file = join(memory, "owned.md");
    await mkdir(workspace);
    const receipt = JSON.parse(script(WITNESS_CREATE_SCRIPT, [workspace, file, "owned"]).output) as WitnessReceipt;
    const userFile = join(memory, "user.md");
    await writeFile(userFile, "concurrent user content");
    const preimage = await readFile(userFile);
    const inode = (await lstat(userFile)).ino;
    check("concurrent contents cleanup succeeds safely", cleanup(file, receipt).code, 0);
    check("nonempty created directory retained", await exists(memory), true);
    check("concurrent user file bytes retained", await readFile(userFile), preimage);
    check("concurrent user file inode retained", (await lstat(userFile)).ino, inode);
  }
  {
    const workspace = join(root, "replacement");
    const memory = join(workspace, "memory");
    const file = join(memory, "owned.md");
    const originalMemory = join(workspace, "original-memory");
    const originalFile = join(originalMemory, "owned.md");
    await mkdir(workspace);
    const receipt = JSON.parse(script(WITNESS_CREATE_SCRIPT, [workspace, file, "owned"]).output) as WitnessReceipt;
    await rename(memory, originalMemory); await mkdir(memory); await writeFile(file, "replacement user file");
    const preimage = await readFile(file);
    const inode = (await lstat(file)).ino;
    check("directory replacement cleanup refuses", cleanup(file, receipt).code, 2);
    check("replacement user file bytes untouched", await readFile(file), preimage);
    check("replacement user file inode untouched", (await lstat(file)).ino, inode);
    check("original owned file not blindly deleted", await readFile(originalFile, "utf8"), "owned\n");
  }
  {
    const workspace = join(root, "collision");
    const memory = join(workspace, "memory");
    const file = join(memory, "owned.md");
    await mkdir(memory, { recursive: true }); await writeFile(file, "preexisting user content");
    const inode = (await lstat(file)).ino;
    const preimage = await readFile(file);
    check("exclusive collision refuses", script(WITNESS_CREATE_SCRIPT, [workspace, file, "wrong"]).code, 73);
    check("collision original inode retained", (await lstat(file)).ino, inode);
    check("collision original bytes retained", await readFile(file), preimage);
  }
  {
    const workspace = join(root, "symlink");
    const target = join(root, "foreign");
    const memory = join(workspace, "memory");
    const file = join(memory, "owned.md");
    const targetFile = join(target, "owned.md");
    await mkdir(workspace); await mkdir(target);
    await symlink(target, memory, "junction");
    check("symlink memory directory refuses", script(WITNESS_CREATE_SCRIPT, [workspace, file, "wrong"]).code, 74);
    checkTrue("symlink target receives no witness", !(await exists(targetFile)));
  }
} finally { await rm(root, { recursive: true, force: true }); }
finish("memory witness filesystem ownership");
