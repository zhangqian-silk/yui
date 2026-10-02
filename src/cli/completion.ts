/** Resolve the current caller on every completion, never the installer's view.
 * Command names are local; target selectors use authenticated scoped reads. */
export function renderCompletion(shell: string | undefined): string {
  switch (shell) {
    case "bash": return `_yui() {
  local candidate current="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && COMPREPLY+=("$candidate")
  done < <(command yui config completion candidates "$current" -- "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)
}
complete -F _yui yui
`;
    case "zsh": return `#compdef yui
local output
local -a candidates
output="$(command yui config completion candidates "$words[CURRENT]" -- "\${(@)words[2,CURRENT-1]}" 2>/dev/null)"
candidates=("\${(@f)output}")
(( \${#candidates[@]} > 0 )) && compadd -- "$candidates[@]"
`;
    case "fish": return `function __yui_candidates
  set -l words (commandline -opc)
  set -l current (commandline -ct)
  command yui config completion candidates "$current" -- $words[2..-1] 2>/dev/null
end
complete -c yui -f -a '(__yui_candidates)'
`;
    default: throw new Error("Completion shell must be one of bash, zsh, fish.");
  }
}
