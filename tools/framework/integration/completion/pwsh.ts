// The PowerShell half of the generated completion, split so the fixed part is a constant:
// everything the declarations decide lives in the tables above, and the interpreter below
// carries not one substitution from them — the same interpreter body renders identically for
// two different command sets, so a check can diff renders and drive the two scripts against
// completionCandidates() differentially.

import { commandLine } from "../../core/io/invocation/render.ts";
import type { CompletionData } from "./table.ts";

/** The `$clawforgeCompleter = { … }` body — the decision completionCandidates() makes, branch
 *  for branch: skip `--app <value>`, take the command from the words before the cursor, let the
 *  word after the command scope an option's values, and fall back `first` → `after` (a
 *  `"<cmd> *" entry when the word after the command is not a known action). `$clawforgeApp`,
 *  `$clawforgeTop`, `$clawforgeFirst`, `$clawforgeAfter`, `$clawforgeVerbatim`, `$clawforgeValueOptions` and `$clawforgeValues` are the only
 *  things the data reaches the interpreter through.
 *  Plain double-quoted literals concatenated with `+`, never a template literal: one would eat
 *  `$wordToComplete`, `$commandAst`, `"$wordToComplete*"` and `$($between[0])` (design
 *  section 9, pitfall 9).
 *  Windows PowerShell 5.1: no `??`, no `?.`, no ternary, and every `if` that can yield one
 *  element wrapped in `@(...)` — unwrapped, a single result stops being an array and the
 *  `.Count` below it becomes a String's length (verified on powershell.exe 5.1). */
export const PWSH_COMPLETER: string =
  "  param($wordToComplete, $commandAst, $cursorPosition)\n" +
  "  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })\n" +
  "  $rest = @(if ($tokens.Count -gt 1) { @($tokens[1..($tokens.Count - 1)]) } else { @() })\n" +
  "  # Only the words BEFORE the word being completed pick the command — the partial word\n" +
  "  # itself is not a typed command (R32-02: 'clawforge sta<Tab>' saw the command \"sta\").\n" +
  "  $scan = $rest\n" +
  "  if ($wordToComplete -ne '') {\n" +
  "    $scan = @(if ($rest.Count -gt 1) { @($rest[0..($rest.Count - 2)]) } else { @() })\n" +
  "  }\n" +
  "  $prev = $null\n" +
  "  if ($scan.Count -ge 1) { $prev = $scan[$scan.Count - 1] }\n" +
  "  # --app is positional and takes a value: the pair is skipped, so it is never read as the\n" +
  "  # command (and a value that looks like a command name does not shadow the real one).\n" +
  "  # The '--app=<name>' form carries its own value in one token: it is skipped alone.\n" +
  "  $i = 0\n" +
  "  while ($clawforgeApp -and $i -lt $scan.Count -and ($scan[$i] -eq '--app' -or $scan[$i].StartsWith('--app='))) { $i = $i + $(if ($scan[$i] -eq '--app') { 2 } else { 1 }) }\n" +
  "  $candidates = @()\n" +
  "  if ($i -ge $scan.Count) {\n" +
  "    if ($clawforgeApp -and $prev -eq '--app') {\n" +
  "      # --app's own value, lazily: only while no command word has been typed — --app must\n" +
  "      # come before the command, so past one the command's flags return (R33-10). Whichever\n" +
  "      # of the system-wide command or the checkout shim was typed makes the call.\n" +
  "      $names = @(try { & $tokens[0] list --json --no-status 2>$null | ConvertFrom-Json | ForEach-Object { $_.name } | Where-Object { $_ -notlike '.*' } } catch { @() })\n" +
  "      $names | Where-Object { $_ -like \"$wordToComplete*\" } | ForEach-Object {\n" +
  "        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)\n" +
  "      }\n" +
  "      return\n" +
  "    }\n" +
  "    $candidates = @($clawforgeTop)\n" +
  "  } else {\n" +
  "    $cmd = $scan[$i]\n" +
  "    $between = @()\n" +
  "    if ($scan.Count - $i - 1 -gt 0) { $between = @($scan[($i + 1)..($scan.Count - 1)]) }\n" +
  "    # An option's values are keyed command + scope + option, where the scope is the word\n" +
  "    # after the command; the option itself (last of `between` after a trailing space) is\n" +
  "    # not a scope.\n" +
  "    $scope = ''\n" +
  "    if ($between.Count -gt 0 -and $between[0] -ne $prev) { $scope = $between[0] }\n" +
  "    $key = \"$cmd$scope$prev\"\n" +
  "    if ($prev -ne $null -and $prev.StartsWith('--') -and $clawforgeValues.ContainsKey($key)) {\n" +
  "      $candidates = @($clawforgeValues[$key])\n" +
  "    } elseif ($between.Count -eq 0) {\n" +
  "      # An unknown command reaches `first` with nothing under that key: the @() keeps the\n" +
  "      # type an array and the filter below drops the $null — nothing is offered.\n" +
  "      $candidates = @($clawforgeFirst[$cmd])\n" +
  "    } else {\n" +
  "      $afterKey = \"$cmd $($between[0])\"\n" +
  "      # A bare `--` is the parser's own options-end marker for ANY command: everything\n" +
  "      # from it on is literal text, so the command's flags stop. A `--` a pending\n" +
  "      # value-option swallows is not one — the parser's own consumption.\n" +
  "      $ended = $false\n" +
  "      $swallow = $false\n" +
  "      foreach ($w2 in $between) {\n" +
  "        if ($swallow) { $swallow = $false; continue }\n" +
  "        if ($w2 -eq '--') { $ended = $true; break }\n" +
  "        if ($clawforgeValueOptions[$cmd] -contains $w2) { $swallow = $true }\n" +
  "      }\n" +
  "      if ($ended) {\n" +
  "        $candidates = @()\n" +
  "      } elseif ($clawforgeVerbatim.ContainsKey($cmd)) {\n" +
  "        $free = 0\n" +
  "        foreach ($w2 in $between) { if (-not $w2.StartsWith('-')) { $free = $free + 1 } }\n" +
  "        if ($free -gt $clawforgeVerbatim[$cmd]) {\n" +
  "          $candidates = @()\n" +
  "        } elseif ($clawforgeAfter.ContainsKey($afterKey)) {\n" +
  "          $candidates = @($clawforgeAfter[$afterKey])\n" +
  "        } else {\n" +
  "          $candidates = @($clawforgeAfter[\"$cmd *\"])\n" +
  "        }\n" +
  "      } elseif ($clawforgeAfter.ContainsKey($afterKey)) {\n" +
  "        $candidates = @($clawforgeAfter[$afterKey])\n" +
  "      } else {\n" +
  "        $candidates = @($clawforgeAfter[\"$cmd *\"])\n" +
  "      }\n" +
  "    }\n" +
  "  }\n" +
  "  $candidates | Where-Object { $_ -like \"$wordToComplete*\" } | Sort-Object -Unique | ForEach-Object {\n" +
  "    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)\n" +
  "  }\n";

/** The data tables, emitted in `data`'s own order: the table module sorts as it builds, so a
 *  second sort here would be a second, divergent rule. */
export function renderPwsh(data: CompletionData): string {
  const quoted = (values: readonly string[]): string => values.map((value) => `"${value}"`).join(", ");
  const entries = (source: ReadonlyMap<string, readonly string[]>): string[] =>
    [...source].map(([key, values]) => `  "${key}" = @(${quoted(values)})`);
  const block = (name: string, lines: readonly string[]): string =>
    `$${name} = @{\n${lines.length === 0 ? "" : `${lines.join("\n")}\n`}}`;
  const values = data.values.map((entry) => `  "${entry.command}${entry.scope}${entry.option}" = @(${quoted(entry.values)})`);
  return (
    "# clawforge PowerShell completion — generated from the command declarations.\n" +
    `# Install: ${commandLine(["completion", "pwsh"])} | Out-String | Invoke-Expression\n` +
    (data.appFlag ? "$clawforgeApp = $true\n" : "$clawforgeApp = $false\n") +
    `$clawforgeTop = @(${quoted(data.top)})\n` +
    block("clawforgeFirst", entries(data.first)) +
    "\n" +
    block("clawforgeAfter", entries(data.after)) +
    "\n" +
    block("clawforgeVerbatim", [...data.verbatim].map(([command, positionals]) => `  "${command}" = ${positionals}`)) +
    "\n" +
    block("clawforgeValueOptions", [...data.valueOptions].map(([command, options]) => `  "${command}" = @(${quoted(options)})`)) +
    "\n" +
    block("clawforgeValues", values) +
    "\n" +
    "$clawforgeCompleter = {\n" +
    PWSH_COMPLETER +
    "}\n" +
    "Register-ArgumentCompleter -Native -CommandName clawforge, ./clawforge -ScriptBlock $clawforgeCompleter\n"
  );
}
