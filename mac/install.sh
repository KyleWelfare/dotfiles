#!/bin/bash
# Links this repo's configs into place. Safe to rerun.
#   ~/dotfiles/mac/install.sh [--configure]   (--configure reruns the setup questions)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stamp="$(date +%Y%m%d-%H%M%S)"

link() {
  local source="$repo/$1" target="$2"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    echo "linked  $target"; return
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    mv "$target" "$target.bak-$stamp"
    echo "backup  $target.bak-$stamp"
  fi
  mkdir -p "$(dirname "$target")"
  ln -s "$source" "$target"
  echo "link    $target"
}

link shared/wezterm.lua               ~/.config/wezterm/wezterm.lua
link shared/gitconfig                 ~/.gitconfig
link shared/git-ignore                ~/.config/git/ignore
link shared/claude/statusline.sh      ~/.claude/statusline.sh
link mac/zshrc                        ~/.zshrc
link mac/p10k.zsh                     ~/.p10k.zsh
link mac/claude/hooks/wezterm-flag.sh ~/.claude/hooks/wezterm-flag.sh
link shared/claude/mods/worklog       ~/.claude/mods/worklog
link shared/claude/skills/sessions    ~/.claude/skills/sessions
link shared/claude/skills/sync-day    ~/.claude/skills/sync-day

# settings.json also holds per-machine state (plugins, other hooks, permissions),
# so merge in statusLine and the wezterm-flag hooks rather than linking the whole
# file. A hook is only added to an event that doesn't already run that command.
settings=~/.claude/settings.json
[ -f "$settings" ] || echo '{}' > "$settings"
merged="$(jq '
  def flag(ev; matcher; v):
    ("bash ~/.claude/hooks/wezterm-flag.sh " + v) as $cmd
    | if [.hooks[ev][]?.hooks[]?.command] | index($cmd) then .
      else .hooks[ev] += [{hooks: [{type: "command", command: $cmd, timeout: 5}]}
                          + (if matcher then {matcher: matcher} else {} end)]
      end;
  .statusLine = {type: "command", command: "~/.claude/statusline.sh", padding: 0}
  | flag("Notification"; "idle_prompt|permission_prompt"; "1")
  | flag("Stop"; null; "1")
  | flag("UserPromptSubmit"; null; "2")
  | flag("PostToolUse"; null; "2")
  | flag("SessionEnd"; null; "0")
' "$settings")"
if [ "$merged" != "$(jq . "$settings")" ]; then
  printf '%s\n' "$merged" > "$settings"
  echo "set     statusLine + wezterm-flag hooks in $settings"
fi

# worklog-dash (the Cmd+Shift+B dashboard tab) runs from this repo, and setup.ts asks for the
# per-machine values the repo leaves out: git identity, work log, PR sync, review bot.
bun="$(command -v bun || { [ -x ~/.bun/bin/bun ] && echo ~/.bun/bin/bun; } || true)"
if [ -n "$bun" ]; then
  (cd "$repo/shared/worklog-dash" && "$bun" install --silent)
  echo "bun     installed worklog-dash dependencies"
  if [ ! -f ~/.config/dotfiles/local.json ] || [ "${1:-}" = "--configure" ]; then
    if [ -t 0 ]; then "$bun" "$repo/shared/setup.ts"
    else echo "note    not a terminal, so setup was skipped; run: bun ~/dotfiles/shared/setup.ts"; fi
  fi
else
  echo "note    no bun; install it (brew install bun) and rerun for setup and the dashboard tab"
fi
echo
echo "Done. Open a new shell and restart WezTerm to pick everything up."
