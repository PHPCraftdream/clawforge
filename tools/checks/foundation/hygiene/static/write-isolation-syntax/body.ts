import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokensOf } from "../../../../architecture/prose-held.ts";
import { analyzeCalleeSyntax } from "./index.ts";

export type SourceContext = { root: string; file: string; readSource?: (path: string) => string | undefined };
export type BodyVerdict = "readonly" | "writer" | "unknown";
export function inspectBody(body: string): BodyVerdict {
  const syntax = analyzeCalleeSyntax(body);
  const tokens = tokensOf(syntax.source);
  const code = tokens.filter(t => t.kind !== "str" && t.kind !== "regex").map(t => t.text).join(" ");
  const writers = new Set("writeFile appendFile createWriteStream unlink rm rmdir truncate mkdir rename chmod chown copyFile cp symlink link utimes mkdtemp".split(" "));
  if (tokens.some((token, i) => token.kind === "id" && writers.has(token.text.replace(/Sync$/, "")) && tokens[i + 1]?.text === "(")) return "writer";
  if (syntax.diagnostics.length > 0) return "unknown";
  if (/\b(?:eval|Function|require|import|spawn|spawnSync|exec|execSync|execFile|execFileSync|runProcess|open|openSync)\b/.test(code)) return "unknown";
  const calls = [...code.matchAll(/([\w$]+)\s*\(/g)].map(m => m[1]);
  return calls.every(name => /^(?:log|error|write|exit|readFile|readFileSync|readdir|readdirSync|stat|statSync|lstat|lstatSync|access|accessSync|existsSync|realpath|realpathSync|resolve|join|dirname|fileURLToPath|JSON|parse|stringify|String|Number|repeat|toString)$/.test(name)) ? "readonly" : "unknown";
}
export function sourcePath(origin: string, context: SourceContext): string | undefined {
  origin = origin.trim();
  const literal = /^(["'`])([^"'`]*?)\1$/.exec(origin);
  if (literal && !literal[2].includes("${")) return resolve(context.root, literal[2]);
  if (/^(?:monorepoRoot|repoRoot|checksRoot)$/.test(origin)) return origin === "checksRoot" ? resolve(context.root,"tools/checks") : context.root;
  if (origin === "import.meta.url") return context.file;
  if (origin === "process.cwd()") return context.root;
  const call = /^(?:path\.)?(resolve|join|dirname|fileURLToPath)\s*\(([\s\S]*)\)$/.exec(origin);
  if (!call) {
    const url = /^new URL\(\s*(["'][^"']+["'])\s*,\s*import.meta.url\s*\)$/.exec(origin);
    if (url) return fileURLToPath(new URL(url[1].slice(1,-1), new URL(`file:///${context.file.replaceAll("\\", "/")}`)));
    return undefined;
  }
  const parts: string[] = []; let start = 0; let depth = 0; let quote = "";
  for (let i=0;i<call[2].length;i++) {
    const c=call[2][i];
    if (quote) { if(c === "\\") i++; else if(c===quote)quote=""; continue; }
    if ("\"'`".includes(c))quote=c;
    else if("([{".includes(c))depth++;
    else if(")]}".includes(c))depth--;
    else if(c==="," && depth===0){parts.push(call[2].slice(start,i));start=i+1;}
  }
  parts.push(call[2].slice(start));
  const base=sourcePath(parts[0],context); if(!base)return undefined;
  if(call[1]==="dirname")return dirname(base);
  if(call[1]==="fileURLToPath")return base;
  const tail=parts.slice(1).map(p=>/^(["'`])([^"'`]*?)\1$/.exec(p.trim())?.[2]);
  return tail.every((p):p is string=>p!==undefined) ? resolve(base,...tail) : undefined;
}
export function readScript(path: string | undefined): string | undefined {
  if(path===undefined)return undefined;
  try{return readFileSync(path,"utf8");}catch{return undefined;}
}
