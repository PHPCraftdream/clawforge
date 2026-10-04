// The bash half of the generated completion (zsh sources the same text through bashcompinit —
// see index.ts), split the way pwsh.ts is: the interpreter below is fixed text and carries not
// one substitution from the command declarations. Every candidate list lives in
// `_clawforge_lookup`'s generated case arms, built from the same table completionCandidates()
// answers and the pwsh script renders, so a script and the table it was rendered from cannot
// quietly diverge.

import { commandLine } from "../../core/io/invocation/render.ts";
import type { CompletionData } from "./table.ts";

// Hidden directories (.r28) are not deployments.
const APP_VALUES_PIPELINE = "$(\"${COMP_WORDS[0]}\" list --json --no-status 2>/dev/null | grep -o '\"name\":\"[^\"]*\"' | cut -d'\"' -f4 | grep -v '^[.]')";

/** The `--app` pair the command scan steps over: `--app` leads the command line and takes the
 *  next word as its own value, so neither is read as the command (a value that looks like a
 *  command name does not shadow the real one); the `--app=<name>` form carries its own value
 *  in one token. Emitted only where the gate has an `--app`
 *  selector — an installed single-deployment gate must not mention it in its script either. */
export const APP_SKIP_PAIR: string =
  "if [[ $skip -eq 1 ]]; then skip=0; continue; fi\n" +
  "    if [[ \"$w\" == \"--app\" ]]; then skip=1; continue; fi\n" +
  "    if [[ \"$w\" == --app=* ]]; then continue; fi\n";
/** `--app`'s own value, offered only while no command word has been typed yet — past one it is
 *  positional and must come before the command, so the command's flags return (R33-10). The
 *  names are asked for lazily, through whichever of the system-wide command or the checkout
 *  shim was typed, and never baked into the generated text. */
export const APP_VALUES_BLOCK: string =
  "if [[ \"$prev\" == \"--app\" ]]; then\n" +
  "    COMPREPLY=( $(compgen -W \"" + APP_VALUES_PIPELINE + "\" -- \"$cur\") )\n" +
  "    return\n" +
  "  fi\n";

/** The fixed half of the bash/zsh script. `_clawforge_lookup` holds the declarations — one case
 *  arm per table row — and `_clawforge_complete` is the decision completionCandidates() makes,
 *  branch for branch, with not one substitution from them: `__CLAWFORGE_CASE_ARMS__` is the one
 *  data placeholder renderBash() fills with the generated arms, and the two `__CLAWFORGE_APP_`
 *  slots carry the `--app` handling a gate without an `--app` selector leaves empty.
 *  Plain double-quoted literals concatenated with `+`, never a template literal: one would eat
 *  `${COMP_WORDS[0]}`, `$cur` and `$prev` (design section 9, pitfall 9).
 *  bash 3.2 (`/bin/bash` on macOS) stays supported: no `declare -A`, no `mapfile`, no `${x,,}`. */
export const BASH_COMPLETER: string =
  "_clawforge_lookup() {\n" +
  "  case \"$1\" in\n" +
  "    __CLAWFORGE_CASE_ARMS__" +
  "    *) return 1 ;;\n" +
  "  esac\n" +
  "  printf '%s' \"$_clawforge_reply\"\n" +
  "}\n" +
  "\n" +
  "_clawforge_complete() {\n" +
  "  local cur=\"${COMP_WORDS[COMP_CWORD]}\"\n" +
  "  local prev=\"${COMP_WORDS[COMP_CWORD-1]}\"\n" +
  "  local words=(\"${COMP_WORDS[@]}\")\n" +
  "  local cword=$COMP_CWORD\n" +
  "  local cmd=\"\" idx=0 skip=0\n" +
  "  local between=() scope=\"\" reply=\"\"\n" +
  "  for ((i = 1; i < cword; i++)); do\n" +
  "    local w=\"${words[i]}\"\n" +
  "    __CLAWFORGE_APP_SKIP__" +
  "    cmd=\"$w\"; idx=$i; break\n" +
  "  done\n" +
  "  if [[ -z \"$cmd\" ]]; then\n" +
  "    __CLAWFORGE_APP_VALUES__" +
  "    if reply=\"$(_clawforge_lookup \"top\")\"; then COMPREPLY=( $(compgen -W \"$reply\" -- \"$cur\") ); else COMPREPLY=(); fi\n" +
  "    return\n" +
  "  fi\n" +
  "  if (( cword - idx - 1 > 0 )); then between=(\"${words[@]:$((idx + 1)):$((cword - idx - 1))}\"); fi\n" +
  "  # The word after the command scopes an option's values; the option itself, last of\n" +
  "  # `between`, is not a scope.\n" +
  "  if (( ${#between[@]} > 0 )) && [[ \"${between[0]}\" != \"$prev\" ]]; then scope=\"${between[0]}\"; fi\n" +
  "  # The command's own first candidates; a command the table does not carry completes to\n" +
  "  # nothing at all.\n" +
  "  if reply=\"$(_clawforge_lookup \"first $cmd\")\"; then COMPREPLY=( $(compgen -W \"$reply\" -- \"$cur\") ); else COMPREPLY=(); return; fi\n" +
  "  # An option's own values, keyed command + scope + option, take the value position.\n" +
  "  if [[ \"$prev\" == --* ]] && reply=\"$(_clawforge_lookup \"values ${cmd}${scope}${prev}\")\"; then\n" +
  "    COMPREPLY=( $(compgen -W \"$reply\" -- \"$cur\") )\n" +
  "    return\n" +
  "  fi\n" +
  "  # Nothing after the command: the word being completed IS its own first position, which\n" +
  "  # the lookup above already answered.\n" +
  "  if (( ${#between[@]} == 0 )); then return; fi\n" +
  "  # A pass-through command: past its declared positionals the tail is literal child text,\n" +
  "  # so the command's own flags stop being offered.\n" +
  "  if (( ${#between[@]} > 0 )) && reply=\"$(_clawforge_lookup \"verbatim $cmd\")\"; then\n" +
  "    local free=0 token\n" +
  "    for token in \"${between[@]}\"; do\n" +
  "      if [[ \"$token\" != -* ]]; then free=$((free + 1)); fi\n" +
  "    done\n" +
  "    if (( free > reply )); then COMPREPLY=(); return; fi\n" +
  "  fi\n" +
  "  # Past a word after the command: that word's own list, else the command's fallback.\n" +
  "  if reply=\"$(_clawforge_lookup \"after $cmd ${between[0]}\")\"; then\n" +
  "    COMPREPLY=( $(compgen -W \"$reply\" -- \"$cur\") )\n" +
  "  elif reply=\"$(_clawforge_lookup \"after $cmd *\")\"; then\n" +
  "    COMPREPLY=( $(compgen -W \"$reply\" -- \"$cur\") )\n" +
  "  else\n" +
  "    COMPREPLY=()\n" +
  "  fi\n" +
  "}\n";

/** One arm: the key the interpreter looks up, and the space-joined candidates it answers with.
 *  `top` sits at the `case`'s own indent, the rows keyed under a command inside it. */
function caseArm(indent: string, key: string, words: readonly string[]): string {
  return `${indent}"${key}") _clawforge_reply="${words.join(" ")}" ;;\n`;
}

/** The declarations as case arms, in the table's own order: what to offer before a command
 *  name, at the word right after it, past its action word, and at a choice-valued option's own
 *  value. table.ts sorts as it builds, so a second sort here would be a second, divergent rule. */
function caseArms(data: CompletionData): string {
  return [
    caseArm("  ", "top", data.top),
    ...[...data.first].map(([command, words]) => caseArm("    ", `first ${command}`, words)),
    ...[...data.after].map(([key, words]) => caseArm("    ", `after ${key}`, words)),
    ...[...data.verbatim].map(([command, positionals]) => caseArm("    ", `verbatim ${command}`, [String(positionals)])),
    ...data.values.map((row) => caseArm("    ", `values ${row.command}${row.scope}${row.option}`, row.values)),
  ].join("");
}

/** The two registrations: the same completer under the system-wide command and the checkout
 *  shim. Shared with zsh (index.ts), which loads this body through bashcompinit. */
export const bashCompletionLines: string =
  "complete -F _clawforge_complete clawforge\n" +
  "complete -F _clawforge_complete ./clawforge\n";

/** The bash script: the two header lines, the interpreter with the generated arms in place of
 *  `__CLAWFORGE_CASE_ARMS__` (and the `--app` slots filled only where the gate has one), then
 *  the registrations. Nothing else — no command name is written anywhere in this file. */
export function renderBash(data: CompletionData): string {
  return (
    "# clawforge bash completion — generated from the command declarations.\n" +
    `# Install: source <(${commandLine(["completion", "bash"])})\n` +
    BASH_COMPLETER.replaceAll("__CLAWFORGE_CASE_ARMS__", caseArms(data))
      .replaceAll("__CLAWFORGE_APP_SKIP__", data.appFlag ? APP_SKIP_PAIR : "")
      .replaceAll("__CLAWFORGE_APP_VALUES__", data.appFlag ? APP_VALUES_BLOCK : "") +
    bashCompletionLines
  );
}
