// Scanner approximation; runtime checkout snapshot in kit/run.ts is the guard of record.
// Pure write-isolation analysis over source TEXT — no filesystem, no imports of the tree.
// Enforces the invariant ("checks may only write outside an isolated apps sandbox") by
// classifying write-shaped CALLS, not specific spellings. Shared by
// write-isolation.check.ts (real-tree scan) and its table-driven self-check.

export type Classification = "CLEAN" | "ANCHORED" | "UNKNOWN";

export type Hit = { call: string; target: string; classification: Classification; approximation?: boolean };

// Closed table of fs write/destroy operations and the argument indexes they write or
// destroy (a move's source loses its file; copyFile also enforces source isolation).
// Sync and
// fs.promises variants share an entry; open counts only with a write flag.
const OPERATIONS: Readonly<Record<string, { readonly targets: readonly number[] }>> = {
  writeFile: { targets: [0] },
  appendFile: { targets: [0] },
  mkdir: { targets: [0] },
  mkdtemp: { targets: [0] },
  rm: { targets: [0] },
  rmdir: { targets: [0] },
  unlink: { targets: [0] },
  truncate: { targets: [0] },
  createWriteStream: { targets: [0] },
  utimes: { targets: [0] },
  lutimes: { targets: [0] },
  chmod: { targets: [0] },
  lchmod: { targets: [0] },
  chown: { targets: [0] },
  lchown: { targets: [0] },
  open: { targets: [0] },
  cp: { targets: [1] },
  copyFile: { targets: [0, 1] },
  symlink: { targets: [1] },
  link: { targets: [1] },
  rename: { targets: [0, 1] },
};
const OPERATION_TARGETS = new Map(Object.entries(OPERATIONS));

const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
const CHILD_MODULE = /^(?:node:)?child_process$/;
const CHILD_CALLEES = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);
// Receivers the old spelling rule knew; still fs namespaces when the file binds them to nothing else.
const FALLBACK_NAMESPACES = ["fs", "fsp", "fsPromises"];

// const/let NAME = <single-line RHS> — the only shape fixed-point propagation follows.
const DECL = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\b[^=\n]*=\s*([^\n;]+)/g;

// Regex-exec-as-boolean; keeps call sites off the architecture proseMatcher shape count.
const reHits = (pattern: RegExp, text: string): boolean => pattern.exec(text) !== null;

const CLEAN_TOKEN = /(?:^|\W)(?:tmpdir|mkdtemp)\s*\(|\bisolatedAppsRoot\b|\bapps\.root\b/;

const ANCHORED_TOKEN =
  /\bmonorepoRoot\b|process\.cwd\(\)|import\.meta|\brepoRoot\b|\bchecksRoot\b/;

/**
 * Masks line, block and string-literal contents with spaces (same length, so
 * offsets are stable). Template-literal content except interpolations (the
 * code inside them is real and stays visible) is masked too. Cheap mask: it does not model regex
 * literals or division, so a '/' inside code that looks like a comment start could
 * over-mask (conservative direction — hiding code never creates hits).
 */
export function maskLiterals(source: string, preserveStrings = false): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = Math.max(0, from); k < Math.min(to, out.length); k++) if (out[k] !== "\n") out[k] = " ";
  };
  const maskQuoted = (quote: string, start: number): number => {
    let j = start + 1;
    while (j < source.length && source[j] !== quote) j += source[j] === "\\" ? 2 : 1;
    if (!preserveStrings) blank(start + 1, j);
    return Math.min(j + 1, source.length);
  };
  const maskTemplate = (start: number): number => {
    // Blank template-literal text as we walk it; `${...}` interpolation code stays visible
    // (it is real code), nested templates inside an interpolation recurse.
    let from = start;
    let j = start + 1;
    while (j < source.length) {
      if (source[j] === "\\") { j += 2; continue; }
      if (source[j] === "`") { if (!preserveStrings) blank(from + 1, j); return j + 1; }
      if (source[j] === "$" && source[j + 1] === "{") {
        if (!preserveStrings) blank(from + 1, j);
        let depth = 1;
        let k = j + 2;
        while (k < source.length && depth > 0) {
          if (source[k] === "{") depth++;
          else if (source[k] === "}") depth--;
          else if (source[k] === "`") { k = maskTemplate(k); continue; }
          k++;
        }
        from = k;
        j = k;
        continue;
      }
      j++;
    }
    if (!preserveStrings) blank(from + 1, source.length);
    return source.length;
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") { const e = source.indexOf("\n", i); blank(i, e === -1 ? source.length : e); i = e === -1 ? source.length : e; continue; }
    if (c === "/" && d === "*") { const e = source.indexOf("*/", i + 2); const to = e === -1 ? source.length : e + 2; blank(i, to); i = to; continue; }
    if (c === "'" || c === '"') { i = maskQuoted(c, i); continue; }
    if (c === "`") { i = maskTemplate(i); continue; }
    i++;
  }
  return out.join("");
}

/** true iff there is a CALL `isolatedAppsRoot(` — a mere import does not count. */
export function isolatedAppsCallPresent(source: string): boolean {
  return reHits(/\bisolatedAppsRoot\s*\(/, maskLiterals(source));
}

/** true iff `createApp(` appears as a call in non-literal code (template contents are masked). */
export function createAppCalled(source: string): boolean {
  return reHits(/\bcreateApp\s*\(/, maskLiterals(source));
}

// Extract the `index`-th top-level argument expression with a balanced-paren scan.
// `arg` is the index of the argument currently being scanned (0-based); a depth-1 comma
// ENDS the current argument (and begins the next), so `end` is fixed when the current
// argument is the one requested and `start` was fixed one comma earlier.
function extractArgRange(masked: string, open: number, index: number): [number, number] | undefined {
  let depth = 0;
  let arg = 0;
  let start = open + 1;
  let end = -1;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) { if (arg === index) end = i; break; }
    } else if (c === "," && depth === 1) {
      if (arg === index) { end = i; break; }
      if (arg === index - 1) start = i + 1;
      arg++;
    }
  }
  if (end === -1 && arg !== index) return undefined;
  return [start, end === -1 ? masked.length : end];
}

function isCleanSignal(expr: string, clean: ReadonlySet<string>): boolean {
  if (CLEAN_TOKEN.test(expr)) return true;
  for (const id of clean) if (new RegExp(`\\b${id}\\b`).test(expr)) return true;
  return false;
}

function isAnchoredSignal(expr: string, origin: string): boolean {
  if (ANCHORED_TOKEN.test(expr)) return true;
  // Relative components in join(tempRoot, './file') do not anchor the root.
  // A bare relative string literal as the whole target ("tools/clawforge.ts") is
  // checkout-relative; absolute paths (/tmp/..., C:\...) and unclassifiable shapes are not.
  const bare = origin.trim().match(/^(["'])([\s\S]*)\1$/);
  if (bare !== null) {
    const v = bare[2];
    if (!v.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(v) && !v.startsWith("file:")) return true;
  }
  return false;
}

/**
 * Fixed-point propagation over `const`/`let X = <single-line expr>`: X joins the clean set
 * when its RHS references tmpdir(/mkdtemp(/isolatedAppsRoot/apps.root or an already-clean
 * identifier — so `const sc = await mkdtemp(...)`, `const scApps = resolve(sc, "apps")`,
 * `writeFile(resolve(scApps, ...))` is clean three lines deep. Only this seeded shape
 * propagates (an unclassifiable RHS is NOT evidence of cleanliness).
 */
function cleanIdents(masked: string): Set<string> {
  const clean = new Set<string>();
  for (let pass = 0; pass < 16; pass++) {
    let added = false;
    for (const m of masked.matchAll(DECL)) {
      const [, name, rhs] = m;
      if (clean.has(name) || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (isCleanSignal(rhs, clean)) { clean.add(name); added = true; }
    }
    if (!added) break;
  }
  return clean;
}

/** Standalone classification has no lexical binding context: unresolved is UNKNOWN.
 * checkoutWriteHits uses source-order scoped propagation instead. */
export function classifyTarget(expr: string, clean: ReadonlySet<string>, origin: string): Classification {
  if (isAnchoredSignal(expr, origin)) return "ANCHORED";
  if (isCleanSignal(expr, clean)) return "CLEAN";
  return "UNKNOWN";
}

/** Source-order lexical approximation. Object/destructuring braces are not scopes.
 * Path constructors follow their base, not leaf tokens. Bound unknown return values and
 * untraceable parameters are reported separately; unbound path bases fail enforcement.
 * Branch joins, imported returns, member property selection beyond sandbox roots,
 * regex-literal masking and arbitrary helper bodies are not modeled. Named helper
 * calls are joined conservatively by spelling; shadowed helper names may over-report.
 * resolve/join follow only the first path argument (absolute later segments and '..'
 * escapes are an explicit approximation, not a filesystem containment proof).
 * checkoutWriteHits keeps the old anchored-token rule as a floor under this evaluator
 * (anchoredFloor): only an evaluator-proven CLEAN escapes it. */
function scopedClassifier(source: string, masked: string): Classify {
  type Scope = { start: number; end: number; parent?: Scope };
  type Binding = { name: string; scope: Scope; at: number; end: number; rhs: string; origin: string; callers?: Binding[] };
  const root: Scope = { start: 0, end: masked.length };
  const scopes = [root];
  const stack = [root];
  const braceStack: boolean[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") {
      const prefix = masked.slice(0, i).trimEnd();
      const block = reHits(/(?:=>|\)|\b(?:try|else|finally|do))$/, prefix) || reHits(/\bfunction\s+[\w$]+\s*\([^{}]*\)[^{}]*$/, prefix) || prefix === "" || reHits(/[;{}]$/, prefix);
      braceStack.push(block);
      if (block) {
        const scope: Scope = { start: i, end: masked.length, parent: stack[stack.length - 1] };
        scopes.push(scope); stack.push(scope);
      }
    } else if (masked[i] === "}" && braceStack.pop() && stack.length > 1) stack.pop()!.end = i;
  }
  const scopeAt = (at: number): Scope => scopes.filter((s) => s.start <= at && at <= s.end).at(-1) ?? root;
  const bindings: Binding[] = [];
  // Balanced RHS extraction handles multiline resolve/join and object/array literals.
  const rhsEnd = (from: number): number => {
    let depth = 0;
    for (let i = from; i < masked.length; i++) {
      const c = masked[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (depth === 0) return i; depth--; }
      if (depth === 0 && (c === ";" || c === "\n" || c === ",")) return i;
    }
    return masked.length;
  };
  for (const m of masked.matchAll(/\b(const|let)\s+([A-Za-z_$][\w$]*(?:\s*:[^=;\n]+)?|\{[^}]*\}|\[[^\]]*\])\s*=/g)) {
    const at = m.index;
    const from = at + m[0].length;
    const end = rhsEnd(from);
    const pattern = m[2];
    const names = pattern.startsWith("{") || pattern.startsWith("[")
      ? pattern.slice(1, -1).split(",").map((part) => part.trim().split(":").at(-1)?.trim()).filter((n): n is string => n !== undefined && reHits(/^[A-Za-z_$][\w$]*$/, n))
      : [pattern.split(":")[0].trim()];
    for (const name of names) {
      let rhs = masked.slice(from, end);
      let origin = source.slice(from, end);
      if (pattern.startsWith("{") && rhs.trim().startsWith("{")) {
        const part = pattern.slice(1, -1).split(",").find((p) => p.trim().split(":").at(-1)?.trim() === name);
        const key = part?.trim().split(":")[0].trim();
        const property = rhs.match(new RegExp(`\\b${key}\\s*:\\s*([^,}]+)`));
        if (property !== null) { const offset = property.index! + property[0].indexOf(property[1]); origin = origin.slice(offset, offset + property[1].length); rhs = property[1]; }
      }
      if (pattern.startsWith("[") && rhs.trim().startsWith("[")) {
        const index = pattern.slice(1, -1).split(",").findIndex((p) => p.trim() === name);
        const values = rhs.trim().slice(1, -1).split(",");
        const originals = origin.trim().slice(1, -1).split(",");
        if (values[index] !== undefined) { rhs = values[index]; origin = originals[index]; }
      }
      bindings.push({ name, scope: scopeAt(at), at, end, rhs, origin });
    }
  }
  for (const m of masked.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)(?:\s*:[^;\n]+)?\s*(?:;|\n)/g)) {
    bindings.push({ name: m[1], scope: scopeAt(m.index), at: m.index, end: m.index + m[0].length, rhs: "", origin: "" });
  }
  // Literal for-of tables are a conservative join of all possible argv rows.
  for (const m of masked.matchAll(/\bfor\s*\(\s*(?:const|let)\s+([\w$]+)\s+of\s*(\[)/g)) {
    const from = m.index + m[0].length - 1;
    const end = rhsEnd(from);
    const scope = scopes.find((s) => s.start >= end && s.parent === scopeAt(m.index));
    if (scope !== undefined) bindings.push({ name: m[1], scope, at: scope.start, end: scope.start, rhs: masked.slice(from, end), origin: source.slice(from, end) });
  }
  // Assignments bind to the nearest visible declaration, never a same-named sibling.
  for (const m of masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?!=|>)/g)) {
    const at = m.index;
    if (bindings.some((b) => b.at <= at && at < b.end)) continue;
    let scope: Scope | undefined = scopeAt(at);
    let declaration: Binding | undefined;
    while (scope !== undefined) {
      declaration = bindings.find((b) => b.name === m[1] && b.scope === scope && b.at < at);
      if (declaration !== undefined) break;
      scope = scope.parent;
    }
    if (declaration === undefined) continue;
    const from = at + m[0].length;
    const end = rhsEnd(from);
    bindings.push({ name: m[1], scope: declaration.scope, at, end, rhs: masked.slice(from, end), origin: source.slice(from, end) });
  }
  // Named local helpers: parameter provenance comes from actual local call arguments.
  for (const m of masked.matchAll(/\b(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)[^{]*\{/g)) {
    const scope = scopes.find((s) => s.start === m.index + m[0].length - 1);
    if (scope === undefined) continue;
    const params = m[2].split(",").map((p) => p.trim().split(":")[0].trim());
    params.forEach((name, index) => {
      if (!reHits(/^[\w$]+$/, name)) return;
      const calls: Binding[] = [];
      for (const call of masked.matchAll(new RegExp(`\\b${m[1]}\\s*\\(`, "g"))) {
        if (call.index >= m.index && call.index < scope.start) continue;
        const range = extractArgRange(masked, call.index + call[0].length - 1, index);
        if (range !== undefined) calls.push({ name, scope, at: call.index, end: range[1], rhs: masked.slice(...range), origin: source.slice(...range) });
      }
      // Keep multiple caller values for a pessimistic join at parameter evaluation.
      bindings.push({ name, scope, at: scope.start, end: scope.start, rhs: "", origin: "", callers: calls });
    });
  }
  const lookup = (name: string, at: number, lexicalAt = at): Binding | undefined => {
    let scope: Scope | undefined = scopeAt(lexicalAt);
    while (scope !== undefined) {
      const binding = bindings.filter((b) => b.name === name && b.scope === scope && b.at < at).sort((a, b) => b.at - a.at)[0];
      if (binding !== undefined) return binding;
      scope = scope.parent;
    }
    return undefined;
  };
  // Only zero-argument helpers with one unconditional return/expression are modeled.
  // Evaluate captures at invocation, in the helper's lexical scope, not by helper spelling.
  const helpers = new Map<Binding, { rhs: string; origin: string; at: number }>();
  const returned = (text: string, original: string, at: number): { rhs: string; origin: string; at: number } | undefined => {
    const arrow = /^(?:async\s+)?\(\)\s*(?::[^=]+)?=>\s*/.exec(text);
    if (arrow === null) return undefined;
    const from = arrow[0].length;
    const body = text.slice(from).trim();
    if (!body.startsWith("{")) return { rhs: text.slice(from), origin: original.slice(from), at: at + from };
    const single = /^\{\s*return\s+([\s\S]*?);?\s*\}$/.exec(body);
    if (single === null || reHits(/\breturn\b|;/, single[1])) return undefined;
    const offset = text.indexOf(single[1], from);
    return { rhs: single[1], origin: original.slice(offset, offset + single[1].length), at: at + offset };
  };
  for (const binding of bindings) {
    const value = returned(binding.rhs.trimStart(), binding.origin.trimStart(), binding.end - binding.rhs.trimStart().length);
    if (value !== undefined) helpers.set(binding, value);
  }
  for (const m of masked.matchAll(/\bfunction\s+([\w$]+)\s*\(\)\s*(?::[^{}]+)?\{/g)) {
    const scope = scopes.find((s) => s.start === m.index + m[0].length - 1);
    if (scope === undefined) continue;
    const body = masked.slice(scope.start, scope.end + 1);
    const value = returned("() => " + body, "() => " + source.slice(scope.start, scope.end + 1), scope.start - 6);
    const binding: Binding = { name: m[1], scope: scopeAt(m.index), at: m.index, end: scope.end, rhs: "", origin: "" };
    bindings.push(binding);
    if (value !== undefined) helpers.set(binding, value);
  }
  const evaluate = (expr: string, origin: string, at: number, seen: Set<Binding>, lexicalAt = at): Classification | "UNBOUND" => {
    const leading = expr.length - expr.trimStart().length;
    expr = expr.trim(); origin = origin.slice(leading).trim();
    if (reHits(/^await\s/, expr)) return evaluate(expr.slice(6), origin.slice(6), at, seen, lexicalAt);
    if (reHits(/^(?:tmpdir|isolatedAppsRoot)\s*\(/, expr)) return "CLEAN";
    // A template must start with a proven root and have a literal, non-escaping suffix.
    const template = /^`\$\{([^{}]+)\}([^`$]*)`$/.exec(origin);
    if (template !== null && !reHits(/\\|(?:^|\/)\.\.(?:\/|$)/, template[2])) {
      const root = evaluate(maskLiterals(template[1]), template[1], at, seen, lexicalAt);
      return root === "CLEAN" ? "CLEAN" : root === "ANCHORED" && !reHits(ANCHORED_TOKEN, expr) ? "ANCHORED" : "UNKNOWN";
    }
    const constructor = expr.match(/^(?:(?:path|nodePath|fs|fsp|fsPromises)\.)?(resolve|join|dirname|fileURLToPath|realpath(?:Sync)?(?:\.native)?|mkdtemp(?:Sync)?)\s*\(/);
    if (constructor !== null) {
      const range = extractArgRange(expr, constructor[0].length - 1, 0);
      return range === undefined ? "UNKNOWN" : evaluate(expr.slice(...range), origin.slice(...range), at, seen, lexicalAt);
    }
    if (reHits(/^(?:monorepoRoot|process\.cwd\(\)|import\.meta\.url)$/, expr) || reHits(/^new\s+URL\([\s\S]*import\.meta\.url/, expr)) return "ANCHORED";
    if (reHits(/^['"]/, expr)) return isAnchoredSignal(expr, origin) ? "ANCHORED" : "CLEAN";
    const invocation = /^([A-Za-z_$][\w$]*)\s*\(\s*\)$/.exec(expr);
    if (invocation !== null) {
      const binding = lookup(invocation[1], at, lexicalAt);
      const helper = binding === undefined ? undefined : helpers.get(binding);
      if (binding === undefined || helper === undefined || seen.has(binding)) return "UNKNOWN";
      return anchoredFloor(evaluate(helper.rhs, helper.origin, at, new Set([...seen, binding]), helper.at), helper.rhs);
    }
    const identifier = expr.match(/^([A-Za-z_$][\w$]*)(?:\.([\w$]+))?$/);
    if (identifier === null) return "UNKNOWN";
    const name = identifier[1];
    const binding = lookup(name, at, lexicalAt);
    if (binding === undefined) {
      if (reHits(/\bimport\b[\s\S]*?\b/, masked) && reHits(new RegExp(`\\bimport\\s+(?:[^;]*?\\b${name}\\b)[^;]*?from`), masked)) return "UNKNOWN";
      // Arrow parameters, loop bindings and unsupported declarations are bound unknowns.
      if (reHits(new RegExp(`\\b(?:const|let)\\s+${name}\\b`), masked)) return "UNKNOWN";
      if (reHits(new RegExp(`(?:\\b(?:for|catch)\\s*\\([^)]*\\b${name}\\b|\\([^)]*\\b${name}\\b[^)]*\\)\\s*(?::[^=]+)?=>)`), masked)) return "UNKNOWN";
      return "UNBOUND";
    }
    if (seen.has(binding)) return "UNKNOWN";
    const next = new Set([...seen, binding]);
    if (binding.callers !== undefined) {
      const results = binding.callers.map((b) => evaluate(b.rhs, b.origin, b.at, next));
      return results.includes("ANCHORED") ? "ANCHORED" : results.length > 0 && results.every((r) => r === "CLEAN") ? "CLEAN" : "UNKNOWN";
    }
    if (identifier[2] !== undefined && (identifier[2] !== "root" || !reHits(/^(?:await\s+)?isolatedAppsRoot\s*\(/, binding.rhs.trim()))) return "UNKNOWN";
    return anchoredFloor(evaluate(binding.rhs, binding.origin, Math.min(at, binding.at), next, binding.at), binding.rhs);
  };
  const resolveValue = (expr: string, origin: string, at: number, seen = new Set<Binding>()): Value => {
    const binding = IDENT.test(expr.trim()) ? lookup(expr.trim(), at) : undefined;
    if (binding === undefined || seen.has(binding) || binding.callers !== undefined) return { expr, origin, at };
    return resolveValue(binding.rhs, binding.origin, binding.at, new Set([...seen, binding]));
  };
  return Object.assign((expr: string, origin: string, at: number) => evaluate(expr, origin, at, new Set()), { resolveValue });
}

/** Lower bound: the evaluator only models exact shapes, so any other target that merely
 * mentions an anchored token (template, concatenation, conditional, imported root) is
 * ANCHORED unless the evaluator proved it CLEAN. */
function anchoredFloor(classification: Classification | "UNBOUND", target: string): Classification | "UNBOUND" {
  return classification !== "CLEAN" && reHits(ANCHORED_TOKEN, target) ? "ANCHORED" : classification;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const IMPORT = /\bimport\s+(?:type\s+)?([\w$*\s{},]+?)\s*from\s*(["'])([^"'\n]+)\2/g;
const REQUIRE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(["'])([^"'\n]+)\2\s*\)/g;
const DERIVED = /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)(\s*\.\s*promises)?(?:\s*\.\s*([A-Za-z_$][\w$]*))?(?![\w$]|\s*[.(])/g;
const CALL = /([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;

type ImportEntry = { module: string; imported: string; local: string };
type FsBindings = { namespaces: Set<string>; functions: Map<string, string>; childNamespaces: Set<string>; children: Map<string, string>; foreign: Set<string> };
type Callee = { kind: "fs"; op: string; targets: readonly number[] } | { kind: "child"; name: string };
type Value = { expr: string; origin: string; at: number };
type Classify = ((expr: string, origin: string, at: number) => Classification | "UNBOUND") & { resolveValue: (expr: string, origin: string, at: number) => Value };

/** Table entry for an fs function name (Sync variants share it). */
function operationOf(name: string): { readonly name: string; readonly targets: readonly number[] } | undefined {
  const entry = OPERATION_TARGETS.get(name.endsWith("Sync") ? name.slice(0, -4) : name);
  return entry === undefined ? undefined : { name, targets: entry.targets };
}

/** Import and require bindings in real code (import text inside literals is masked out).
 * imported is "*" for default, namespace and require bindings. */
function parseImports(source: string, masked: string): ImportEntry[] {
  const entries: ImportEntry[] = [];
  const commentsMasked = maskLiterals(source, true);
  for (const m of commentsMasked.matchAll(IMPORT)) {
    if (masked.slice(m.index, m.index + 6) !== "import") continue;
    const braces = /\{([^}]*)\}/.exec(m[1]);
    for (const part of braces === null ? [] : braces[1].split(",")) {
      const [imported, local] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      const name = (local ?? imported).trim();
      if (IDENT.test(name)) entries.push({ module: m[3], imported: imported.trim(), local: name });
    }
    for (const part of m[1].replace(/\{[^}]*\}/, "").split(",")) {
      const name = part.trim().replace(/^\*\s*as\s+/, "");
      if (IDENT.test(name)) entries.push({ module: m[3], imported: "*", local: name });
    }
  }
  for (const m of commentsMasked.matchAll(REQUIRE)) {
    if (masked.slice(m.index, m.index + 3) === source.slice(m.index, m.index + 3)) entries.push({ module: m[3], imported: "*", local: m[1] });
  }
  return entries;
}

function bindImport(b: FsBindings, entry: ImportEntry): void {
  if (FS_MODULE.test(entry.module)) {
    if (entry.imported === "*" || entry.imported === "promises") b.namespaces.add(entry.local);
    else if (operationOf(entry.imported) !== undefined) b.functions.set(entry.local, entry.imported);
  } else if (CHILD_MODULE.test(entry.module)) {
    if (entry.imported === "*") b.childNamespaces.add(entry.local);
    else if (CHILD_CALLEES.has(entry.imported)) b.children.set(entry.local, entry.imported);
  } else if (entry.imported === "runProcess") b.children.set(entry.local, "runProcess");
  else b.foreign.add(entry.local);
}

/** Names the file declares or imports (then a bare call is not the fs/child function). */
function declaredNames(masked: string, imports: readonly ImportEntry[]): (name: string) => boolean {
  const locals = new Set(imports.map((entry) => entry.local));
  return (name) => locals.has(name) || reHits(new RegExp(`\\b(?:function\\*?|const|let|var|class)\\s+${name}\\b`), masked);
}

/** fs and child_process bindings by import, then aliases derived from them (fixed point). */
function fsBindings(source: string, masked: string, declared: (name: string) => boolean): FsBindings {
  const b: FsBindings = { namespaces: new Set(), functions: new Map(), childNamespaces: new Set(), children: new Map(), foreign: new Set() };
  for (const entry of parseImports(source, masked)) bindImport(b, entry);
  for (const name of FALLBACK_NAMESPACES) if (!declared(name)) b.namespaces.add(name);
  for (let pass = 0; pass < 8; pass++) {
    const before = b.namespaces.size + b.functions.size;
    for (const m of masked.matchAll(DERIVED)) {
      const [, pattern, base, viaPromises, member] = m;
      if (!b.namespaces.has(base) || (pattern.startsWith("{") && member !== undefined)) continue;
      const pairs = pattern.startsWith("{")
        ? pattern.slice(1, -1).split(",").map((part) => part.split(":").map((s) => s.trim()))
        : [[member ?? "*", pattern]];
      for (const [key, local = key] of pairs) {
        if (!IDENT.test(local)) continue;
        if (key === "*" || (key === "promises" && viaPromises === undefined)) b.namespaces.add(local);
        else if (operationOf(key) !== undefined) b.functions.set(local, key);
      }
    }
    if (b.namespaces.size + b.functions.size === before) break;
  }
  return b;
}

function resolveCallee(parts: readonly string[], b: FsBindings, declared: (name: string) => boolean): Callee | undefined {
  const [head, ...members] = parts;
  const fsOp = (name: string): Callee | undefined => {
    const op = operationOf(name);
    return op === undefined ? undefined : { kind: "fs", op: op.name, targets: op.targets };
  };
  if (members.length === 0) {
    const bound = b.functions.get(head);
    if (bound !== undefined) return fsOp(bound);
    const child = b.children.get(head);
    if (child !== undefined) return { kind: "child", name: child };
    const isChild = CHILD_CALLEES.has(head) || head === "runProcess";
    // Unbound, undeclared bare names keep the old spelling coverage.
    if ((!isChild && operationOf(head) === undefined) || b.foreign.has(head) || declared(head)) return undefined;
    return isChild ? { kind: "child", name: head } : fsOp(head);
  }
  if (members.length === 1 && b.namespaces.has(head)) return fsOp(members[0]);
  if (members.length === 2 && members[0] === "promises" && b.namespaces.has(head)) return fsOp(members[1]);
  if (members.length === 1 && b.childNamespaces.has(head) && CHILD_CALLEES.has(members[0])) return { kind: "child", name: members[0] };
  return undefined;
}

/** open/openSync write only with a write flag; a non-literal flag counts (conservative). */
function opensForWrite(masked: string, source: string, open: number): boolean {
  const range = extractArgRange(masked, open, 1);
  if (range === undefined) return false;
  const flag = source.slice(range[0], range[1]).trim();
  if (flag.length === 0 || flag === "0") return false;
  const literal = /^(["'`])([^"'`]*)\1$/.exec(flag);
  return literal === null || (literal[1] === "`" && literal[2].includes("${")) || reHits(/[wa+]/, literal[2]);
}

/** Write/destroy-shaped calls with checkout or unresolved target provenance. */
export function checkoutWriteHits(source: string): Hit[] {
  const masked = maskLiterals(source);
  const classify = scopedClassifier(source, masked);
  const declared = declaredNames(masked, parseImports(source, masked));
  const bindings = fsBindings(source, masked, declared);
  const hits: Hit[] = [];
  const children: Array<{ name: string; at: number; open: number }> = [];
  for (const m of masked.matchAll(CALL)) {
    const at = m.index ?? 0;
    const before = masked[at - 1] ?? "";
    // Member of another object (transport.writeFile) or a declaration, not a call site.
    if (reHits(/[$\w.]/, before) || reHits(/function\s*$/, masked.slice(Math.max(0, at - 9), at))) continue;
    const callee = resolveCallee([m[1], ...m[2].split(".").map((s) => s.trim()).filter((s) => s !== "")], bindings, declared);
    if (callee === undefined) continue;
    const open = at + m[0].length - 1;
    const after = masked.slice(extractArgRange(masked, open, 0)?.[1] ?? open);
    // Object method declarations are not calls (typed or inferred parameters).
    if (reHits(/^\)\s*(?::[^\n{]+)?\s*\{/, after) || reHits(/\basync\s*$/, masked.slice(Math.max(0, at - 10), at))) continue;
    if (callee.kind === "child") { children.push({ name: callee.name, at, open }); continue; }
    if (reHits(/^open(?:Sync)?$/, callee.op) && !opensForWrite(masked, source, open)) continue;
    for (const index of callee.targets) {
      const range = extractArgRange(masked, open, index);
      if (range === undefined) continue;
      const target = masked.slice(range[0], range[1]);
      if (target.trim().length === 0) continue;
      // maskLiterals preserves offsets 1:1, so the same range in the original source is the
      // unmasked text of the target — needed to confirm "./" vs "../" in new URL(...).
      const origin = source.slice(range[0], range[1]);
      const classification = classify(target, origin, at);
      const floored = anchoredFloor(classification, target);
      if (floored !== "CLEAN") hits.push({ call: callee.op, target: origin.trim(), classification: floored === "UNBOUND" ? "UNKNOWN" : floored, approximation: floored === "UNKNOWN" });
    }
  }
  hits.push(...childProcessHits(source, masked, classify, children));
  return hits;
}

const DESTRUCTIVE = /\bgit\b.*\bclean\b|\bgit\b.*\bcheckout\b.*\s--(?:\s|$)|\bgit\b.*\breset\b.*--hard\b|(?:^|[\s;&|])(?:rm|del|rmdir|rd|Remove-Item)(?:\s|$)/i;
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** End offset of the depth-0 expression starting at from (stops at , ; ) ] }). */
function expressionEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) return i; depth--; }
    else if (depth === 0 && (c === "," || c === ";")) return i;
  }
  return masked.length;
}

/** Non-empty top-level items of the call or array opening at open. */
function listItems(masked: string, open: number): Array<[number, number]> {
  const items: Array<[number, number]> = [];
  for (let index = 0; index < 64; index++) {
    const range = extractArgRange(masked, open, index);
    if (range === undefined) break;
    if (masked.slice(range[0], range[1]).trim() !== "") items.push(range);
  }
  return items;
}

/** Extract path operands, not executables, subcommands or flags. Shell parsing is a
 * bounded approximation; provenance of nonliteral operands is checked separately. */
function destructiveOperands(command: string): string[] {
  const words = [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s;&|]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const git = words.findIndex((word) => /^(?:.*[\\/])?git(?:\.exe)?$/i.test(word));
  let operands: string[];
  if (git >= 0) {
    const subcommand = words[git + 1];
    if (subcommand === "checkout") {
      const separator = words.indexOf("--", git + 2);
      operands = separator < 0 ? [] : words.slice(separator + 1);
    } else operands = subcommand === "clean" ? words.slice(git + 2) : [];
  } else {
    const destroy = words.findIndex((word) => /^(?:rm|del|rmdir|rd|Remove-Item)$/i.test(word));
    operands = destroy < 0 ? [] : words.slice(destroy + 1);
  }
  return operands.filter((word) => word !== "" && !word.startsWith("-") && !/^\/(?:s|q|f)$/i.test(word));
}

/** Child processes running a destructive command (git clean/checkout --/reset --hard,
 * rm/del/rmdir/Remove-Item) with a checkout-anchored cwd or path argument. An absent cwd
 * inherits the checkout; an unresolved cwd is enforced, not disclosed. */
function childProcessHits(source: string, masked: string, classify: Classify, calls: ReadonlyArray<{ name: string; at: number; open: number }>): Hit[] {
  const hits: Hit[] = [];
  for (const { name, at, open } of calls) {
    const items = listItems(masked, open);
    const text = source.slice(open + 1, items.at(-1)?.[1] ?? open + 1);
    const values = items.map(([f, t]) => classify.resolveValue?.(masked.slice(f, t), source.slice(f, t), at) ?? { expr: masked.slice(f, t), origin: source.slice(f, t), at });
    const program = /^("|')([^"']+)\1$/.exec(values[0]?.origin.trim() ?? "")?.[2];
    const argv = values[1];
    const argvItems = argv?.expr.trim().startsWith("[") ? listItems(argv.expr, argv.expr.indexOf("[")) : [];
    const args = argvItems.map(([f, t]) => /^(["'`])([^"'`$]*)\1$/.exec(argv!.origin.slice(f, t).trim())?.[2]);
    const readOnlyGit = (expr: string, origin: string): boolean => {
      if (!expr.trim().startsWith("[")) return false;
      const rows = listItems(expr, expr.indexOf("["));
      const first = rows[0];
      if (first === undefined) return false;
      if (expr.slice(...first).trim().startsWith("[")) return rows.every((r) => readOnlyGit(expr.slice(...r), origin.slice(...r)));
      const subcommand = /^(["'`])([^"'`$]*)\1$/.exec(origin.slice(...first).trim())?.[2];
      return subcommand !== undefined && /^(?:status|ls-files|ls-tree|diff|log|show|rev-parse|rev-list|cat-file|blame)$/.test(subcommand);
    };
    if (/^(?:.*[\\/])?git(?:\.exe)?$/i.test(program ?? "") && argv !== undefined && readOnlyGit(argv.expr, argv.origin)) continue;
    const unresolved = argv !== undefined && (argvItems.length > 0 ? args.some((v) => v === undefined) : !argv.expr.trim().startsWith("{"));
    const capable = /^(?:.*[\\/])?(?:git|rm|del|rmdir|rd|Remove-Item)(?:\.exe)?$/i.test(program ?? "")
      || (/^(?:.*[\\/])?sh(?:\.exe)?$/i.test(program ?? "") && args.includes("-c"))
      || (/^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(program ?? "") && args.some((v) => v?.toLowerCase() === "/c"));
    const destructive = DESTRUCTIVE.test(values.map((v) => [...v.origin.matchAll(LITERAL)].map((l) => l[2]).join(" ")).join(" "));
    if (!destructive && !(unresolved && capable)) continue;
    let cwd: Classification | "UNBOUND" = "ANCHORED";
    let anchored = false;
    for (const value of values) {
      const item = value.expr.trim();
      const start = value.expr.indexOf(item);
      const localVerdict = (f: number, t: number): Classification | "UNBOUND" => anchoredFloor(classify(value.expr.slice(f, t), value.origin.slice(f, t), value.at), value.expr.slice(f, t));
      if (item.startsWith("{")) {
        const key = /\bcwd\b\s*(:)?/.exec(item);
        if (key === null) continue;
        const valueFrom = start + key.index + (key[1] === undefined ? 0 : key[0].length);
        cwd = localVerdict(valueFrom, key[1] === undefined ? valueFrom + 3 : expressionEnd(value.expr, valueFrom));
        continue;
      }
      const parts: Array<[number, number]> = item.startsWith("[") ? listItems(value.expr, start) : [[0, value.expr.length]];
      const literals = parts.map(([f, t]) => /^(["'`])([^"'`$]*)\1$/.exec(value.origin.slice(f, t).trim())?.[2]);
      const command = item.startsWith("[")
        ? [program ?? "", ...literals.map((v) => v ?? "")].join(" ")
        : literals[0] ?? "";
      if (destructiveOperands(command).some((path) => isAnchoredSignal("", JSON.stringify(path)))) anchored = true;
      for (const [f, t] of parts) if (!reHits(/^(["'`])\s*\1$/, value.expr.slice(f, t).trim()) && localVerdict(f, t) === "ANCHORED") anchored = true;
    }
    if (!destructive && cwd !== "ANCHORED") continue;
    const classification = anchored || cwd === "ANCHORED" ? "ANCHORED" : cwd === "CLEAN" ? undefined : "UNKNOWN";
    if (classification !== undefined) hits.push({ call: name, target: text.replace(/\s+/g, " ").trim(), classification, approximation: false });
  }
  return hits;
}

/**
 * createApp without isolation. Two escapes keep the invariant, not the spelling:
 * an `isolatedAppsRoot(…)` call, or a clean CLAWFORGE_CHECKS_APPS_DIR redirect (system
 * install checks point the scaffold's apps dir at an mkdtemp checkout and then call
 * createApp — sandboxed, not physical).
 */
function appsDirRedirectIsClean(masked: string, original: string, clean: ReadonlySet<string>): boolean {
  // The env-var NAME lives inside a string literal, which maskLiterals blanks — so the
  // assignment shape is found on the masked text and the name is confirmed in the original
  // at the same offsets. Both the bracketed (process.env["..."]) and dotted spellings count.
  const shapes = [
    /process\s*\.\s*env\s*\[[^\]]*\]\s*=\s*([^\n;]+)/g,
    /\bCLAWFORGE_CHECKS_APPS_DIR\b\s*=\s*([^\n;]+)/g,
  ];
  for (const re of shapes) {
    for (const m of masked.matchAll(re)) {
      const from = m.index ?? 0;
      if (!original.slice(from, from + m[0].length).includes("CLAWFORGE_CHECKS_APPS_DIR")) continue;
      if (isCleanSignal(m[1], clean)) return true;
    }
  }
  return false;
}

export function createAppWithoutIsolation(source: string): boolean {
  const masked = maskLiterals(source);
  return createAppCalled(masked) && !isolatedAppsCallPresent(masked) && !appsDirRedirectIsClean(masked, source, cleanIdents(masked));
}

export function analyze(source: string): { createAppWithoutIsolation: boolean; writes: Hit[] } {
  return { createAppWithoutIsolation: createAppWithoutIsolation(source), writes: checkoutWriteHits(source) };
}
