# worklog-dash

Today's work log as a terminal pane: the plan, review requests, your open PRs and recent log events. The dotfiles' dashboard tab (Cmd+Shift+B, Alt+Shift+B on Windows) runs it in its top split. The repo README describes the log format.

- `bun index.tsx`: run it.
- `bun index.tsx --once [columns]`: print one frame and exit, for checking the layout without a TTY.

Keys: up/down or j/k move, space or x toggles a checkbox, o opens the row's first link, s syncs PRs now, r reloads, q quits. Clicking a ticket or PR link opens it.

It reads the same markdown and `.events` files as the worklog Claude Code mod (`../claude/mods/worklog`) and reuses its `parse.ts`. Both take their settings from `~/.config/dotfiles/local.json`, which `../setup.ts` writes; the dashboard reads it at start, so restart it after changing them.

PRs sync from gh every 5 minutes, rewriting the log's Reviews and My open PRs sections. A review request the log doesn't list yet raises a desktop notification (a WezTerm toast on Windows) and a `review` event. With a gh account set, every search uses that account's token, and without a login for it the sections are left alone rather than emptied.

Dependencies install from the public npm registry (`.npmrc`), even where `~/.npmrc` points at a private one.
