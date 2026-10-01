// A PowerShell-subset evaluator that EXECUTES the emitted pwsh completer body, so the
// check tests its behaviour rather than substrings (R33-10: a mutation reintroducing the
// R32-02 bug passed every substring check). Covers what the generated script uses:
// assignments, if/elseif/else (one-line and block), `for`, `continue`/`break`/`return`,
// Where-Object/Sort-Object/ForEach-Object pipelines, strings with $var and $(expr)
// interpolation, @() arrays, .. ranges, [index] and [start..end] slicing, hashtable [key]
// and .ContainsKey(), .Count/.Keys, -eq -ne -lt -le -gt -ge -and -or -not, +. Three
// generated lines are shape-asserted and emulated (param, $tokens from $commandAst, the
// lazy `list --json` inside try/catch); anything the emitter adds that the evaluator
// cannot parse throws, so the check goes red instead of quietly drifting.

type Val = string | number | boolean | null | Val[] | Map<string, Val>;

export interface PwshTables {
  names: string[];
  flags: Map<string, string[]>;
  actions: Map<string, Map<string, string[]>>;
  choices: Map<string, string[]>;
  positional: Map<string, string[]>;
}

function literalValues(raw: string): string[] {
  return [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

export function parsePwshTables(script: string): PwshTables {
  const tables: PwshTables = {
    names: [],
    flags: new Map(),
    actions: new Map(),
    choices: new Map(),
    positional: new Map(),
  };
  let section = "";
  let actionCommand = "";
  for (const line of script.split("\n")) {
    const commandsMatch = /^\$clawforgeCommands = @\((.*)\)/.exec(line);
    if (commandsMatch !== null) {
      tables.names = literalValues(commandsMatch[1]!);
      continue;
    }
    const sectionMatch = /^\$(clawforge\w+) = @\{/.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1]!;
      continue;
    }
    if (section === "clawforgeActions") {
      const commandMatch = /^  "([^"]+)" = @\{$/.exec(line);
      if (commandMatch !== null) {
        actionCommand = commandMatch[1]!;
        tables.actions.set(actionCommand, new Map());
      } else if (/^  \}$/.test(line)) {
        actionCommand = "";
      } else {
        const entry = /^    "([^"]+)" = @\(([^)]*)\)/.exec(line);
        if (entry !== null && actionCommand !== "") tables.actions.get(actionCommand)!.set(entry[1]!, literalValues(entry[2]!));
      }
      continue;
    }
    const entry = /^  "([^"]+)" = @\(([^)]*)\)/.exec(line);
    if (entry === null) continue;
    if (section === "clawforgeFlags") tables.flags.set(entry[1]!, literalValues(entry[2]!));
    if (section === "clawforgeChoiceValues") tables.choices.set(entry[1]!, literalValues(entry[2]!));
    if (section === "clawforgePositional") tables.positional.set(entry[1]!, literalValues(entry[2]!));
  }
  return tables;
}

// --- expressions --------------------------------------------------------------------------------

const TOKEN = /-and|-or|-not|-eq|-ne|-lt|-le|-gt|-ge|\.\.|\$[A-Za-z_]\w*|"[^"]*"|'[^']*'|\d+|[A-Za-z_]\w*|[()[\]@+,.-]/g;
const COMPARISONS = ["-eq", "-ne", "-lt", "-le", "-gt", "-ge"];

function truthy(value: Val): boolean {
  if (value === null || value === false || value === "" || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function compare(op: string, left: Val, right: Val): boolean {
  const delta = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
  return { "-eq": delta === 0, "-ne": delta !== 0, "-lt": delta < 0, "-le": delta <= 0, "-gt": delta > 0, "-ge": delta >= 0 }[op]!;
}

class Expr {
  private readonly tokens: string[];
  private readonly vars: Map<string, Val>;
  private pos = 0;

  constructor(tokens: string[], vars: Map<string, Val>) {
    this.tokens = tokens;
    this.vars = vars;
  }
  static eval(source: string, vars: Map<string, Val>): Val {
    try {
      return new Expr(source.match(TOKEN) ?? [], vars).parse();
    } catch (error) {
      throw new Error(`pwsh evaluator: in expression \`${source}\`: ${(error as Error).message}`);
    }
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new Error("pwsh evaluator: unexpected end of expression");
    return token;
  }

  private parse(): Val {
    const value = this.or();
    if (this.pos !== this.tokens.length) throw new Error(`pwsh evaluator: trailing tokens near ${this.peek()}`);
    return value;
  }

  private or(): Val {
    let left = this.and();
    while (this.peek() === "-or") {
      this.next();
      const right = this.and();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private and(): Val {
    let left = this.cmp();
    while (this.peek() === "-and") {
      this.next();
      const right = this.cmp();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private cmp(): Val {
    const left = this.add();
    const op = this.peek();
    if (op !== undefined && COMPARISONS.includes(op)) {
      this.next();
      return compare(op, left, this.add());
    }
    return left;
  }

  private add(): Val {
    let left = this.range();
    for (;;) {
      const op = this.peek();
      if (op !== "+" && op !== "-") return left;
      this.next();
      const right = this.range();
      left =
        Array.isArray(left) || Array.isArray(right)
          ? [...(Array.isArray(left) ? left : [left]), ...(Array.isArray(right) ? right : [right])]
          : typeof left === "number" && typeof right === "number"
            ? op === "+"
              ? left + right
              : left - right
            : `${String(left)}${String(right)}`;
    }
  }

  private range(): Val {
    const left = this.unary();
    if (this.peek() === "..") {
      this.next();
      const start = Number(left);
      const stop = Number(this.unary());
      const step = start <= stop ? 1 : -1;
      const out: number[] = [];
      for (let value = start; step > 0 ? value <= stop : value >= stop; value += step) out.push(value);
      return out;
    }
    return left;
  }

  private unary(): Val {
    if (this.peek() === "-not") {
      this.next();
      return !truthy(this.unary());
    }
    if (this.peek() === "-") {
      this.next();
      return -Number(this.unary());
    }
    return this.postfix();
  }

  private postfix(): Val {
    let value = this.primary();
    for (;;) {
      const token = this.peek();
      if (token === ".") {
        this.next();
        const member = this.next();
        if (member === "Count") value = Array.isArray(value) ? value.length : value instanceof Map ? value.size : String(value ?? "").length;
        else if (member === "Keys") {
          if (!(value instanceof Map)) throw new Error("pwsh evaluator: .Keys on a non-hashtable");
          value = [...value.keys()];
        } else if (member === "ContainsKey") {
          if (this.next() !== "(") throw new Error("pwsh evaluator: expected ( after .ContainsKey");
          const key = this.or();
          if (this.next() !== ")") throw new Error("pwsh evaluator: expected ) after .ContainsKey");
          if (!(value instanceof Map)) throw new Error("pwsh evaluator: .ContainsKey on a non-hashtable");
          value = value.has(String(key));
        } else throw new Error(`pwsh evaluator: unknown member .${member}`);
      } else if (token === "[") {
        this.next();
        const index = this.or();
        if (this.next() !== "]") throw new Error("pwsh evaluator: expected ]");
        if (Array.isArray(index)) {
          if (!Array.isArray(value)) throw new Error("pwsh evaluator: range index on a non-array");
          const first = Number(index[0]);
          const last = Number(index[index.length - 1]);
          value = value.slice(first, last + 1);
        } else if (value instanceof Map) value = value.get(String(index)) ?? null;
        else if (Array.isArray(value)) value = value[Number(index)] ?? null;
        else value = String(value ?? "")[Number(index)] ?? "";
      } else return value;
    }
  }

  private primary(): Val {
    const token = this.next();
    if (token === "(") {
      const value = this.or();
      if (this.next() !== ")") throw new Error("pwsh evaluator: expected )");
      return value;
    }
    if (token === "@") {
      if (this.next() !== "(") throw new Error("pwsh evaluator: expected @(");
      const items: Val[] = [];
      while (this.peek() !== ")") {
        const item = this.or();
        items.push(...(Array.isArray(item) ? item : [item]));
        if (this.peek() === ",") this.next();
      }
      this.next();
      return items;
    }
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token.startsWith('"')) {
      return token.slice(1, -1).replace(/\$[A-Za-z_]\w*|\$\([^)]*\)/g, (match) => {
        const value = match.startsWith("$(") ? Expr.eval(match.slice(2, -1), this.vars) : (this.vars.get(match.slice(1)) ?? null);
        return String(value);
      });
    }
    if (token.startsWith("$")) {
      if (token === "$true") return true;
      if (token === "$false") return false;
      if (token === "$null") return null;
      return this.vars.get(token.slice(1)) ?? null;
    }
    if (/^\d+$/.test(token)) return Number(token);
    throw new Error(`pwsh evaluator: unexpected token ${token}`);
  }
}


// --- statements ---------------------------------------------------------------------------------

type Flow = undefined | "break" | "continue" | "return";

interface Branch {
  cond: string | null;
  from: number;
  to: number;
}

/** Prefix filter for `-like "$wordToComplete*"`, unique-sorted for `Sort-Object -Unique`. */
function emitted(candidates: Val[], wordToComplete: string, unique: boolean): string[] {
  const matched = candidates.map(String).filter((value) => value.startsWith(wordToComplete));
  return unique ? [...new Set(matched)].sort() : matched;
}

// Conditions may contain one level of nested parentheses (ContainsKey($key), slices).
const CONDITION = "((?:[^()]|\\([^()]*\\))*)";
const ONE_LINE_IF = new RegExp(`^if \\(${CONDITION}\\) \\{ (.+) \\}$`);
const ONE_LINE_IF_ELSE = new RegExp(`^if \\(${CONDITION}\\) \\{ (.+) \\} else \\{ (.+)\\}$`);
const BLOCK_IF = /^if \((.+)\) \{$/;
const FOR_LOOP = /^for \(\$i = 0; (.+); \$i\+\+\) \{$/;
const PIPELINE = /^\$([A-Za-z_]\w*) \| Where-Object \{ \$_ -like "\$wordToComplete\*" \}( \| Sort-Object -Unique)? \| ForEach-Object \{$/;
const ASSIGNMENT = /^\$([A-Za-z_]\w*) = (.+)$/;
const IF_EXPRESSION = new RegExp(`^if \\(${CONDITION}\\) \\{ (.+) \\} else \\{ (.+) \\}$`);

function braceDelta(line: string): number {
  return (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
}

export function runPwshCompleter(script: string, rest: readonly string[], wordToComplete: string, appNames: readonly string[]): string[] {
  const tables = parsePwshTables(script);
  const vars = new Map<string, Val>([
    ["wordToComplete", wordToComplete],
    ["tokens", ["clawforge", ...rest]],
    ["clawforgeCommands", [...tables.names]],
    ["clawforgeFlags", tables.flags],
    ["clawforgeActions", tables.actions],
    ["clawforgeChoiceValues", tables.choices],
    ["clawforgePositional", tables.positional],
  ]);
  let result: string[] = [];
  let flowMarker = -1;
  const lines = script.split("\n").filter((line) => !line.trimStart().startsWith("#"));
  const start = lines.findIndex((line) => line.startsWith("  $tokens = @($commandAst"));
  if (start < 0) throw new Error("pwsh evaluator: $tokens pipeline line not found");

  const execInline = (body: string): Flow => {
    for (const statement of body.split("; ")) {
      if (statement === "continue") return "continue";
      if (statement === "break") return "break";
      const inline = ASSIGNMENT.exec(statement);
      if (inline === null) throw new Error(`pwsh evaluator: cannot parse inline statement: ${statement}`);
      vars.set(inline[1]!, Expr.eval(inline[2]!, vars));
    }
    return undefined;
  };

  const execStatement = (line: string, i: number): Flow => {
    if (line === "" || line === "{" || line === "}") return undefined;
    if (line === "continue") return "continue";
    if (line === "break") return "break";
    if (line === "return") return "return";
    const pipeline = PIPELINE.exec(line);
    if (pipeline !== null) {
      const subject = vars.get(pipeline[1]!);
      if (subject !== null && !Array.isArray(subject)) throw new Error(`pwsh evaluator: pipeline subject $${pipeline[1]} is not an array`);
      result = emitted(subject ?? [], wordToComplete, pipeline[2] !== undefined);
      flowMarker = blockEnd(lines, i) + 1;
      return undefined;
    }
    const blockIf = BLOCK_IF.exec(line);
    if (blockIf !== null) {
      const branches = chainBranches(lines, i);
      for (const branch of branches) {
        if (branch.cond === null || truthy(Expr.eval(branch.cond, vars))) {
          const flow = execRange(branch.from, branch.to);
          if (flow !== undefined) return flow;
          break;
        }
      }
      flowMarker = branches[branches.length - 1]!.to + 1;
      return undefined;
    }
    const ifElse = ONE_LINE_IF_ELSE.exec(line) ?? ONE_LINE_IF.exec(line);
    if (ifElse !== null) {
      let body = ifElse[2]!;
      if (!truthy(Expr.eval(ifElse[1]!, vars))) {
        if (ifElse.length === 4) body = ifElse[3]!;
        else return undefined;
      }
      return execInline(body);
    }
    const forLoop = FOR_LOOP.exec(line);
    if (forLoop !== null) {
      const bodyEnd = blockEnd(lines, i);
      for (let value = 0; value < 1000; value++) {
        vars.set("i", value);
        if (!truthy(Expr.eval(forLoop[1]!, vars))) break;
        const flow = execRange(i + 1, bodyEnd);
        if (flow === "break") break;
        if (flow === "return") return flow;
      }
      flowMarker = bodyEnd + 1;
      return undefined;
    }
    const assignment = ASSIGNMENT.exec(line);
    if (assignment !== null) {
      const [, name, rhs] = assignment;
      if (rhs!.startsWith("try {")) vars.set(name!, [...appNames]);
      else if (name === "tokens" && rhs!.startsWith("@($commandAst")) throw new Error("pwsh evaluator: $tokens line moved");
      else {
        const ifExpr = IF_EXPRESSION.exec(rhs!);
        vars.set(name!, ifExpr === null ? Expr.eval(rhs!, vars) : truthy(Expr.eval(ifExpr[1]!, vars)) ? Expr.eval(ifExpr[2]!, vars) : Expr.eval(ifExpr[3]!, vars));
      }
      return undefined;
    }
    throw new Error(`pwsh evaluator: cannot parse statement: ${line}`);
  };

  const execRange = (from: number, to: number): Flow => {
    let i = from;
    while (i < to) {
      const line = (lines[i] ?? "").trim();
      flowMarker = -1;
      let flow: Flow;
      try {
        flow = execStatement(line, i);
      } catch (error) {
        throw new Error(`${(error as Error).message} | at: ${lines[i] ?? ""}`);
      }
      if (flow !== undefined) return flow;
      i = flowMarker === -1 ? i + 1 : flowMarker;
    }
    return undefined;
  };

  execRange(start + 1, lines.length);
  return result;
}

/** Line index of the `}` closing the block opened on `open` (whose line ends with `{`). */
function blockEnd(lines: string[], open: number): number {
  let depth = 0;
  for (let i = open; i < lines.length; i++) {
    depth += braceDelta(lines[i]!);
    if (depth === 0) return i;
  }
  throw new Error("pwsh evaluator: unterminated block");
}

/** The if/elseif/else chain started on `open`: each branch's condition, body from..to. */
function chainBranches(lines: string[], open: number): Branch[] {
  const first = BLOCK_IF.exec((lines[open] ?? "").trim())!;
  const branches: Branch[] = [{ cond: first[1]!, from: open + 1, to: -1 }];
  let depth = 0;
  for (let i = open; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const delta = braceDelta(line);
    if (i > open && depth === 1) {
      const elseif = /^} elseif \((.+)\) \{$/.exec(trimmed);
      const head = branches[branches.length - 1]!;
      if (elseif !== null) {
        head.to = i;
        branches.push({ cond: elseif[1]!, from: i + 1, to: -1 });
      } else if (trimmed === "} else {") {
        head.to = i;
        branches.push({ cond: null, from: i + 1, to: -1 });
      } else if (trimmed === "}" && delta === -1) {
        head.to = i;
        return branches;
      }
    }
    depth += delta;
  }
  throw new Error("pwsh evaluator: unterminated if chain");
}
