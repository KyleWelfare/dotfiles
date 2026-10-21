# dotfiles

WezTerm + shell setup shared across Windows and Mac machines.

```
shared/   used on every OS: wezterm.lua, gitconfig, git-ignore, ssh-config, claude/statusline.sh,
          claude/mods/worklog (Claude Code mod), worklog-dash (dashboard app)
windows/  PowerShell profile, oh-my-posh theme, winget list, bootstrap.ps1
mac/      zshrc, p10k theme, Claude wezterm-flag hook, install.sh
```

Configs are symlinked into place, so editing one on any machine edits the repo. Commit and pull to sync.

## Windows

Turn on Developer Mode first (Settings > System > For developers), or symlinks fall back to copies.

```powershell
winget install --id Git.Git -e; winget install --id GitHub.cli -e
# open a new shell so git/gh are on PATH
gh auth login
gh repo clone dotfiles $HOME\dotfiles
powershell -ExecutionPolicy Bypass -File $HOME\dotfiles\windows\bootstrap.ps1
```

Existing files are moved to `<name>.bak-<timestamp>` before anything gets linked. The script is safe to rerun.

## Mac

```bash
gh repo clone KyleWelfare/dotfiles ~/dotfiles
~/dotfiles/mac/install.sh
```

Expects the tools from `windows/winget.txt` already installed via Homebrew (plus `powerlevel10k`, `zsh-autosuggestions`, `zsh-syntax-highlighting`, `font-hack-nerd-font`). Existing files are moved to `<name>.bak-<timestamp>` before linking; safe to rerun. `ssh-config` isn't linked on Mac.

## Keybinds

WezTerm (`shared/wezterm.lua`). Keys sit in the same physical spot on both: Mac Cmd is Windows Alt.

| Action | Mac | Windows |
|---|---|---|
| New tab | Cmd+T | Alt+T |
| Go to tab 1-8 / last tab | Cmd+1-8 / Cmd+9 | Alt+1-8 / Alt+9 |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Move tab left / right | Cmd+Shift+Left / Right | Alt+Shift+Left / Right |
| Close tab | Cmd+Shift+W | Alt+Shift+W |
| Split right / below | Cmd+D / Cmd+Shift+D | Alt+D / Alt+Shift+D |
| Close pane | Cmd+W | Alt+W |
| Zoom pane (toggle) | Cmd+Shift+Enter | Alt+Shift+Enter |
| Move between panes | Cmd+Opt+Arrows | Ctrl+Shift+Arrows |
| Resize pane | Cmd+Ctrl+Arrows | Alt+Ctrl+Arrows |
| Move pane into another tab (prompts for a tab index, -1 = last) | Cmd+Ctrl+M | Alt+Ctrl+M |
| New tab running Claude here | Cmd+Shift+T | Alt+Shift+T |
| Start Claude in this pane | Cmd+Shift+C | Alt+Shift+C |
| Dashboard tab | Cmd+Shift+B | Alt+Shift+B |
| Re-root the dashboard's file tree at another repo | Cmd+Shift+O | Alt+Shift+O |
| Command palette | Cmd+Shift+P | Alt+Shift+P |
| Workspace switcher (Windows: also shells) | Cmd+Shift+S | Alt+Shift+S |
| Save session / restore a saved one | Cmd+Ctrl+S / Cmd+Ctrl+R | Alt+Ctrl+S / Alt+Ctrl+R |
| Re-maximize the window | Cmd+Shift+M | Alt+Shift+M |
| Search scrollback | Cmd+F | Ctrl+Shift+F |
| Clear scrollback | Cmd+K | Ctrl+Shift+K |
| New window | Cmd+N | Ctrl+Shift+N |
| Font size bigger / smaller / reset | Cmd+= / Cmd+- / Cmd+0 | Ctrl+= / Ctrl+- / Ctrl+0 |
| Open a link | Click (Shift+click where an app takes the mouse) | Same |

A zoomed pane gets a pink border and a `PANE ZOOMED` badge, so the hidden panes aren't forgotten. On Mac, background tabs running Claude show a wave while it works, then a red dot when it needs you (dimmed once you've looked), with a toast if WezTerm isn't focused. The layout is saved every 15 minutes and on focus loss, and restored on launch.

In the shell: `f` fuzzy-opens a file, `rgf` searches file contents live, `z <dir>` jumps to a directory, `lg` opens lazygit, `gc <message>` adds, commits and pushes, and on Mac `ghSwitch` swaps gh (and git's GitHub login) between two accounts.

## Dashboard

Cmd+Shift+B (Alt+Shift+B on Windows) opens a dashboard tab: `shared/worklog-dash` across the top, a broot file tree on the left and Claude in the rest. Cmd+Shift+O re-roots the tree at another repo. The worklog mod, linked to `~/.claude/mods/worklog`, logs commits, PRs, session summaries and, with the Atlassian connector, Jira moves to the same work log and shows today's plan progress in Claude's status line. Both take the log folder, PR sync and ticket-link settings from setup (below), and the picker takes its repo folders from there too. The install scripts link the mod and run `bun install` for the dashboard.

## Per-machine setup

Nothing personal or machine-specific is in the repo. On first install the scripts run `shared/setup.ts`, a short set of questions whose answers go to untracked files:

| File | Holds |
|---|---|
| `~/.config/dotfiles/local.json` | Work log folder; PR sync (on by default for your own PRs, optionally a specific gh account, an org and a team); ticket links (a URL with `{id}`, off by default); repo folders for the file-tree picker |
| `~/.gitconfig.local` | `user.name`, `user.email` |
| `~/.ssh/config.local` (Windows) | One SSH host; `ssh-config` only includes this file |

Rerun it any time with `mac/install.sh --configure`, `bootstrap.ps1 -Configure` or `bun ~/dotfiles/shared/setup.ts`. Enter keeps the current answer and `-` clears it. Anything else machine-specific goes in `~/.gitconfig.local` or, on Mac, `~/.zshrc.local` (sourced last).
