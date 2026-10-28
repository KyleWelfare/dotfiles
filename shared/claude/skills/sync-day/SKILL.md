---
name: sync-day
description: Bring today's work log and my Jira tickets up to date with what actually happened - tick Plan and Reviews items that are done, log PRs merged outside a Claude session, move tickets whose status lags the work, and flag anything unclear. Runs unattended when I start it; the worklog dashboard already does the mechanical part every 5 minutes. Use when I say "sync my day", "sync the worklog", or "/sync-day".
user-invocable: true
---

Reconcile today's log and Jira with the evidence, without asking me anything. Act only where the evidence is clear;
everything else becomes a flag that `/wrap-day` and I pick up.

While the worklog dashboard runs, its 5-minute sync already logs my merged PRs, ticks Plan rows that are a merged PR
(and parents whose sub-items are all ticked), and keeps Reviews rows I reviewed ticked. So most of steps 2 and 3 will
already be done; the work left here is the judgement: lines done by a ticket or an event, Jira moves and flags.

## Settings and paths

`~/.config/dotfiles/local.json` (written by `~/dotfiles/shared/setup.ts`) holds the per-machine values under `worklog`:
`root` (the log folder, `~` expanded), `github.user` (my gh account), `github.org` (the org my PRs live in) and
`tickets.pattern` (a ticket key's regex). Read it first. Run every `gh` command with
`GH_TOKEN=$(gh auth token --user <github.user>)` when `github.user` is set, since another active account may see none
of the org's PRs; pass `--owner <github.org>` to searches when `github.org` is set.

- Log root: `<root>/`
- Today's file: `<root>/YYYY/YYYY-MM/YYYY-MM-DD.md`
- Events: `<root>/.events/YYYY-MM-DD.jsonl`
- Work notes: `~/.claude/work/<KEY>.md`

## Steps

1. **Gather in parallel** (don't show raw output). Today is the local date.
   - Today's file and today's events. If the file doesn't exist, do only step 2 and stop.
   - The tickets in play: every key linked in today's Plan, plus every key in today's events (`ticket` field).
     Their status, assignee and issue type in one JQL query, and which of them changed status today:
     `key in (...) AND status CHANGED DURING (startOfDay(), now())`. Pass
     `responseFields: ["key", "fields.status.name", "fields.assignee.displayName", "fields.issuetype.name"]`; without
     it each result runs to tens of thousands of characters.
   - My PRs updated today: `gh search prs --author @me --owner <org> --updated ">=<today>" --json number,title,url,repository,state,isDraft`
     (`state` is `open`, `closed` or `merged`), plus every PR linked in the Plan that isn't in that list
     (`gh pr view <url> --json state,title,url`).
   - Each unticked Reviews row: `gh pr view <url> --json state,latestReviews`; I'm `<github.user>`.

2. **Log merges the hooks missed.** For each of my PRs that merged today with no `done` event carrying its URL (an "Opened" event
   doesn't count), append a
   `done` event: `Merged [<repo>#<n>: <title>]`, with its ticket key and URL.

3. **Tick what's done.** Change `- [ ]` to `- [x]` with the Edit tool, one line per edit, re-reading the file first
   (the dashboard rewrites the Reviews and My open PRs sections every few minutes). Never untick, reword or remove
   anything.
   - A Plan or Nice to have line is done when the work its text describes is done: every PR linked on it merged, or
     its ticket Done when the line is that ticket's whole job (not one step of it), or a `done` event that plainly
     matches it. A line naming several steps ("merge X, then push Y") needs all of them.
   - A parent is done when all its sub-items are.
   - A Reviews row is done when I've submitted a review on it, or it merged or closed.
   - Not sure is not done: flag it (step 5).

4. **Move tickets whose status lags the work.** Only these two moves, only on tickets assigned to me or unassigned,
   never on an Epic, and never on a ticket whose status changed today (I may have put it there):
   - **Started:** in a To Do status (Backlog, TODO, Refined, Ready For Refinement) with my work on it today: a commit or PR
     event of mine for it, or an open PR of mine with its key. A review request is someone else's work, not mine. Move to In Progress, and assign it to me if unassigned.
   - **Finished:** In Progress, at least one of my PRs for it merged, none open
     (`gh search prs --author @me --owner <org> "<KEY>" --json state`), and nothing in today's file, its events
     or its work note names work still to do on it. Move to Done.
   Look up the transition (`listJiraIssueTransitions` through `executeRead`) and use the one leading to the target
   status. A failed or denied move becomes a flag; don't retry or pick another status. The worklog hook logs each
   move, so don't add an event for it.

5. **Flag the rest.** For anything that looks out of date but didn't meet a rule above (a merged PR on a ticket with
   work left, a ticket I moved backwards that now has work, a line I couldn't judge), append a `note` event starting
   `Check:` that says what's off and what you'd do. Skip any flag whose text is already in today's events.

6. **Record the run** when it changed anything: one `note` event listing what it did, eg. `Synced: logged 2 merges; ticked <lines>; moved <tickets>`.

7. **Reply in one line:** what changed and how many flags, or `no changes`.

## Rules

- Events are appended with `jq -nc` as in `/log`, with `"source": "sync-day"`:
  `{"ts": "<ISO 8601 local>", "source": "sync-day", "kind": "...", "text": "...", "ticket": "<KEY>" | null, "pr": "<url>" | null}`
- A ticket in event text or the reply is written `[<KEY>: <two to five words>]`, a PR `[<repo>#<n>: <two to five words>]`.
- Never post comments, open or close PRs, push, or touch tickets outside the ones in play.
- Hyphens only, no em dashes.
