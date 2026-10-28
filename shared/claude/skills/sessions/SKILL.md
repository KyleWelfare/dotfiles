---
name: sessions
description: Report every live Claude Code session on this machine in one table - what each is working on, its state, its ticket's work note and how much context it has left. Use when I say "what are my sessions doing", "session report", "I'm losing track of my sessions", or "/sessions".
user-invocable: true
---

Read-only: report, don't message or change any session.

## Steps

1. Run `python3 -I ~/.claude/skills/sessions/scripts/sessions.py --json`. Per live session it gives:
   - `name` and `this` (the session running the skill)
   - `state`: busy or idle, and `since` how long
   - `works_in`: the folders its recent tool calls touch, each with the branch checked out there, or `null` when the folder is gone
   - `keys`: ticket keys from those branches, folders and its last prompt
   - `note`: the matching `~/.claude/work/<KEY>.md` title and Status line
   - `prompt`: my last message to it, and `said`: its last reply to me
   - `used`, `window` and `left_pct`: context tokens on its last request, the window size, and the percentage left

   `window` is null until that session's status line has run since the window-size cache was added. Say "window unknown"
   then; don't guess a size.
2. Write one table, a row per session, this one last:

   | Session | State | Working on | Summary | Context left |
   |---|---|---|---|---|

   - **Working on:** the ticket key with a few words on what it is (from the note's title, else from the session's
     prompts and replies; never the key alone), then the main worktree folder and its branch.
   - **Summary:** one plain sentence on where it is and what it's waiting on, drawn from the note's Status, its last reply
     and my last prompt. Say "waiting on you: ..." when its last reply asks me something or needs my approval.
   - **Context left:** `left_pct`%, with the tokens used.
3. Under the table, only when they apply, one line each:
   - sessions under 25% context left: they should rewrite their notes and clear soon;
   - sessions waiting on me;
   - two sessions working in the same folder or on the same branch, since they can collide;
   - work notes in `~/.claude/work/` with no live session working on them (`ls ~/.claude/work/`), with their Status line.

Keep it to the table and those lines; no preamble.
