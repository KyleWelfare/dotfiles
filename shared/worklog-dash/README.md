# worklog-dash

Today's work log as a terminal pane: the plan, review requests and your open PRs. The dotfiles' dashboard tab (Cmd+Shift+B, Alt+Shift+B on Windows) runs it in its top split, and `--side` in its left one: the Claude sessions that match no plan item, then the recent log events. The repo README describes the log format.

- `bun index.tsx`: run it.
- `bun index.tsx --once [columns]`: print one frame and exit, for checking the layout without a TTY (add `--side` for the left pane).

Keys: up/down or j/k move, space or x toggles a checkbox, o opens the row's first link (a reviewed PR's session instead, with the review bot on), v reviews the selected review request now, a switches reviews between auto and manual, s syncs PRs now, r reloads, q quits. Clicking a ticket or PR link opens it.

It reads the same markdown and `.events` files as the worklog Claude Code mod (`../claude/mods/worklog`) and reuses its `parse.ts`. Both take their settings from `~/.config/dotfiles/local.json`, which `../setup.ts` writes; the dashboard reads it at start, so restart it after changing them.

PRs sync from gh every 5 minutes, rewriting the log's Reviews and My open PRs sections. A review request the log doesn't list yet raises a desktop notification (a WezTerm toast on Windows) and a `review` event. With a gh account set, every search uses that account's token, and without a login for it the sections are left alone rather than emptied.

## Sessions

Each plan row shows the live Claude sessions working on it: `◐` busy, `●` waiting on you (a permission prompt, or its last reply asks something), `○` idle, with the context left. Clicking one switches to its tab. A session belongs to the item whose ticket and PRs come up most in its last 20 prompts and replies, once one of its rows comes up in at least three of them; a sub-row takes it when it has most of those mentions, otherwise the parent does. Sessions that match no row are listed in the left pane, where up/down and `o` switch to one. The data comes from the `/sessions` skill's script (`~/.claude/skills/sessions/scripts/sessions.py --json`) and `wezterm cli list`.

## Review bot (Mac)

With `worklog.reviewBot.enabled` in `local.json` (setup.ts asks), each new review request is reviewed in the background with the `/review` skill, and its Reviews row shows how that's going: queued, reviewing, report ready (with the count under "Should address"), stale once commits land after it, or failed. Clicking a ready row's status, or `o` on it, resumes the review's session in a new tab so you can go through the findings and decide what to post; the bot itself never posts.

- The first sync with the bot on lists the requests already waiting as idle (`v` reviews one) rather than reviewing them all.
- `a` switches every dashboard to manual (the sync line says which): new requests and re-requests are listed idle for `v`, and queued ones go back to idle. Switching back to auto doesn't review what arrived meanwhile.
- Each row also shows everyone else's latest review by first name (`Qing ✓` approved, `✗` changes requested, `◌` commented only) and the title's ticket key, for picking what to `v` in manual mode.
- A PR is reviewed again only when you're re-requested on it. New commits only mark its report stale.
- Each run (`src/review-run.ts`) is detached, so it outlives the dashboard. It fetches the PR head into the dashboard's own blobless clone (`~/.cache/worklog-dash/repos`) and checks it out in a worktree per PR (`~/.cache/worklog-dash/wt`), sparse without `sparseExclude` (Unity YAML by default). Your own clones are never touched. A PR's worktree and report are deleted two hours after its request goes away, and any worktree no PR owns is deleted on the next sync. Deleting `~/.cache/worklog-dash` is always a safe reset.
- Runs are headless `claude -p` in `dontAsk` mode with hooks off and only read tools allowed: no edits, no `gh api` writes, nothing from the PR's own tooling. Set `tokenFile` to a file holding a fine-grained token with read-only Pull requests and Contents access to stop writes at GitHub too; without it the runs use the PR sync's account.
- State: `~/.local/state/worklog-dash/reviews` (`index.json`, plus each run's report, result and log under `runs/`). With several dash tabs open, only one of them runs reviews.
- Other options in `worklog.reviewBot`: `maxParallel` (3), `timeoutMinutes` (45), `model` (opus) and `sparseExclude`.

Dependencies install from the public npm registry (`.npmrc`), even where `~/.npmrc` points at a private one.
