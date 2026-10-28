# worklog-dash improvements

Plan from the 2026-10-28 dashboard review. Three steps, in order; steps 2 and 3 get a short design pass before building.

## Where things are

- The review bot is built and uncommitted in `~/dotfiles`, mixed in with earlier uncommitted edits to `sync.ts`, `view.tsx`
  and `wezterm.lua`. New files: `src/reviews.ts`, `src/review-run.ts`, `src/reviews.test.ts`. Also edited: `app.tsx`,
  `index.tsx`, `setup.ts`, README.
- Reviews are in manual mode (`a` toggles; `~/.local/state/worklog-dash/reviews/settings.json`).
- `/review` now runs one Opus reviewer instead of Fable + Opus, which cost about half a day's usage on 2026-10-28
  (`~/.claude/skills/review/SKILL.md`).
- Still open: a fine-grained read-only GitHub token for the review runs (`worklog.reviewBot.tokenFile`); without it they
  use the KyleProdigy token, so only the permission rules stop a write.

## Step 1 - small fixes (one pass)

1. **PR row layout.** In My Open PRs, a long repo label pushes into the title and wraps
   (`arcadia-unity-packageIS-2804: ...` with `s#31` on its own line; the same for `Arcadia-Prototypes#73` and
   `app-prototype#64`). Give the label a fixed width, truncate the title after it, never wrap. Wrapped lines are also
   what pushes Recent off the pane.
2. **Inline markdown in plan rows.** Show code spans without the backticks, in their own color; bold and italics the
   same way if they appear.
3. **Other reviewers on Reviews rows.** Each row shows who else has reviewed, by first name with their state, for
   example `Qing ✓` (approved), `Qing ✗` (changes requested), `Qing ◌` (commented only). This matters most in manual mode,
   for choosing which idle PRs to `v`. Take the first names from the GitHub profile name, falling back to the login.
   Fetch the reviews in the 5-minute sync, only for requested PRs whose `updatedAt` changed.
4. **Ticket prefix on Reviews rows.** Strip a leading `[IS-1234]` from the title and show the key on the right as a
   ticket link, before the bot status (`IS-2817 · v to review`).

My Open PRs stays as it is otherwise. Its job is also to remind you of older unresolved PRs that aren't on the day's
plan, so it doesn't drop the PRs the plan links.

## Step 2 - sessions beside plan items, and a new left pane

**Session markers on plan rows.** Each plan row whose ticket or PR a live Claude session is working on gets a marker:
busy, waiting on you, or idle, plus context left (for example `◐ busy · 64%`, `● waiting`).

- Data: `python3 -I ~/.claude/skills/sessions/scripts/sessions.py --json` gives each live session's `state`, `since`,
  `keys` (ticket keys from its branches, folders and last prompt), `works_in` (folders and branches) and `left_pct`.
  Poll it on the 30-second reload.
- Matching: a session's `keys` against the row's ticket links. PR links are matched through the PR's head branch.
  Sub-items inherit their parent's ticket.
- Open: how reliably "waiting on you" can be told from idle (`sessions.py` has the last reply; a question or approval
  request in it means waiting). Clicking a marker should switch to that session's WezTerm tab; check whether
  `sessions.py` can map a session to a pane.

**Left pane: replace the broot file tree** (it's rarely used) with a second worklog-dash view, split 50/50 by height:

- Top: **Other sessions**, the live sessions that match no plan item, with the same state and context markers, so every
  session still shows somewhere.
- Bottom: **Recent**, the event list moved from the top pane's right column, which then has more room for Reviews and
  My Open PRs.
- Probably `bun index.tsx --side` in `open_dashboard` (`wezterm.lua`) in place of broot. Cmd+Shift+O (re-root the tree)
  is then dropped, or kept for re-rooting the Claude pane.

## Step 3 - move the mechanical half of /sync-day into the dashboard

The dashboard tab runs `claude "/loop 10m /sync-day"`. That takes over the Claude pane with its transcript and costs a
model turn every 10 minutes (about 2% of usage on 2026-10-28). Split it:

- **In the dashboard, as code on the 5-minute sync:** tick Plan and Reviews rows whose PRs merged or whose review you
  submitted; log PRs merged outside a Claude session as events. worklog-dash already fetches all of this.
- **Left to Claude, run less often or on demand:** the judgement calls, such as moving a Jira ticket whose status lags
  the work, or flagging unclear items. Decide whether this stays a slower `/loop` (for example hourly) or becomes a key in
  the dashboard.
- Read `~/.claude/skills/sync-day/SKILL.md` first to list exactly what it does today and sort each part into the two
  halves above.
- Then `open_dashboard` no longer needs to send the `/loop` prompt, and the Claude pane starts empty.
