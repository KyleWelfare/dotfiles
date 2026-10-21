# worklog-dash

Today's work log as a terminal pane: the plan, review requests, my open PRs and recent log events. It reads the same markdown and `.events` files as the worklog Claude Code mod (`../claude/mods/worklog`, linked to `~/.claude/mods/worklog`) and reuses its `parse.ts`. Both take the log folder, PR sync and ticket-link settings from `~/.config/dotfiles/local.json`, which `shared/setup.ts` writes.

- `bun index.tsx`: run it (WezTerm's Cmd+Shift+B dashboard tab, Alt+Shift+B on Windows, runs it in the top split).
- `bun index.tsx --once [columns]`: print one frame and exit.

Keys: up/down or j/k move, space or x toggles a checkbox, o opens the row's first link, s syncs PRs now, r reloads, q quits. Clicking a ticket or PR link opens it.

PRs sync from gh every 5 minutes. A review request the log doesn't list yet raises a desktop notification (a WezTerm toast on Windows) and a `review` event. Sync shows your own open PRs and review requests through gh's active account, unless local.json turns it off or narrows it: a specific gh account (needs a login for it; without one the sections are left alone), an org to search instead of all of GitHub, and a team whose review requests count as yours.

Dependencies install from the public npm registry (`.npmrc`), even where `~/.npmrc` points at a private one.
