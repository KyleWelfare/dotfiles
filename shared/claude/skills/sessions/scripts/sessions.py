#!/usr/bin/env python3
"""Every live Claude Code session on this machine: name, state, where it works, its ticket's work note, last prompt and
context left. Reads ~/.claude/sessions/<pid>.json (name, status, sessionId), each session's transcript (folders its tool
calls touch, git branch, last prompt, the last request's token usage), ~/.claude/work/<KEY>.md (Status line) and
~/.claude/cache/context-window/<sessionId> (window size, written by the status line; only it is told the size).
--json also gives each session's pid and the ticket keys and PRs its recent prompts, replies and tool calls mention,
which the worklog dashboard matches against the day's plan.

Usage: python3 -I ~/.claude/skills/sessions/scripts/sessions.py [--json]
"""
import collections, glob, json, os, re, sys, time

HOME = os.path.expanduser("~")
TAIL_BYTES = 4_000_000  # enough of a transcript for the last prompt, recent folders and the last usage
KEY = re.compile(r"\b([A-Z]{2,5}-\d{2,6})\b")
# Ticket keys and PRs a session works with: a pull URL, repo#123 as the worklog writes PR labels, or a `gh pr` command's
# number (reported as #123).
MENTION = re.compile(r"github\.com/[\w.-]+/([\w.-]+)/pull/(\d+)|\b([A-Za-z][\w.-]*#\d+)\b|\b([A-Z]{2,5}-\d{2,6})\b"
                     r"|\bpr (?:view|diff|checks|comment|review|edit|merge|ready|checkout) (\d+)")
MENTION_ITEMS = 200  # how many recent prompts, replies and tool calls the mentions come from


def ancestors():
    seen, pid = set(), os.getppid()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        out = os.popen(f"ps -o ppid= -p {pid}").read().strip()
        pid = int(out) if out.isdigit() else 0
    return seen


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, TypeError):
        return False


def tail_lines(path):
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - TAIL_BYTES))
        data = f.read().decode("utf-8", errors="ignore")
    lines = data.splitlines()
    return lines[1:] if size > TAIL_BYTES else lines  # the first may be cut


def read_transcript(session_id):
    found = glob.glob(f"{HOME}/.claude/projects/*/{session_id}.jsonl")
    info = {"prompt": "", "said": "", "dirs": [], "model": "", "used": None, "last": None, "mentions": []}
    if not found:
        return info
    dirs = collections.Counter()
    texts = []  # the user's prompts, the session's replies and its tool calls' inputs, oldest first
    for line in tail_lines(found[0]):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("isSidechain"):
            continue
        msg = e.get("message") or {}
        c = msg.get("content")
        if e.get("timestamp"):
            info["last"] = e["timestamp"]
        if e.get("type") == "user" and isinstance(c, str) and not c.startswith("<"):
            info["prompt"] = " ".join(c.split())[:140]
            texts.append(c)
        if e.get("type") == "assistant":
            u = msg.get("usage")
            if u:
                info["used"] = (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + \
                               (u.get("cache_read_input_tokens") or 0)
                info["model"] = msg.get("model") or info["model"]
            if isinstance(c, list):
                text = " ".join(b.get("text", "") for b in c if b.get("type") == "text").strip()
                if text:
                    info["said"] = " ".join(text.split())[:300]  # its last words to the user
                    texts.append(text)
                for b in c:
                    if b.get("type") == "tool_use":
                        texts.append(json.dumps(b.get("input")))
                        for w in re.findall(r"(/Users/[\w.-]+/Documents/[\w-]+/[\w.-]+)", json.dumps(b.get("input"))):
                            dirs[w.rstrip(".")] += 1
    info["dirs"] = [k for k, _ in dirs.most_common(3)]  # full paths
    counts = {}  # ref -> how many of the recent items mention it; insertion order is most recent first
    for text in reversed(texts[-MENTION_ITEMS:]):
        for ref in {f"{m[1]}#{m[2]}" if m[1] else m[3] or m[4] or f"#{m[5]}" for m in MENTION.finditer(text)}:
            counts[ref] = counts.get(ref, 0) + 1
    info["mentions"] = [{"ref": ref, "count": n} for ref, n in counts.items()]
    return info


def branch(path):
    """The branch checked out in a worktree folder (the transcript's gitBranch is the session's start checkout)."""
    if not os.path.isdir(path):
        return None
    return os.popen(f"git -C '{path}' branch --show-current 2>/dev/null").read().strip()


def work_note(keys):
    for k in keys:
        p = f"{HOME}/.claude/work/{k}.md"
        if os.path.exists(p):
            title, status = "", ""
            for line in open(p, errors="ignore"):
                if line.startswith("# ") and not title:
                    title = line[2:].strip()
                if line.startswith("Status:"):
                    status = line[len("Status:"):].strip()
                    break
            return {"key": k, "title": title, "status": status}
    return None


def window(session_id):
    try:
        return int(open(f"{HOME}/.claude/cache/context-window/{session_id}").read().strip())
    except (OSError, ValueError):
        return None


def ago(ms):
    if not ms:
        return ""
    s = max(0, int(time.time() - ms / 1000))
    return f"{s // 3600}h{(s % 3600) // 60:02d}m" if s >= 3600 else f"{s // 60}m"


def k(n):
    return f"{n / 1000:.0f}k" if n < 1_000_000 else f"{n / 1_000_000:.2f}M"


def main():
    mine = ancestors()
    rows = []
    for path in sorted(glob.glob(f"{HOME}/.claude/sessions/*.json")):
        try:
            d = json.load(open(path))
        except (OSError, ValueError):
            continue
        if not alive(d.get("pid")):
            continue
        t = read_transcript(d.get("sessionId"))
        cwd = d.get("cwd", "")
        where = []  # (folder, branch or None when the folder is gone)
        for p in t["dirs"][:2] or [cwd]:
            where.append((os.path.basename(p), branch(p)))
        keys = []
        for text in [*(b or "" for _, b in where), *(f for f, _ in where), t["prompt"]]:
            keys += [m for m in KEY.findall(text or "") if m not in keys]
        win = window(d.get("sessionId"))
        rows.append({
            "name": d.get("name"),
            "pid": d.get("pid"),
            "this": d.get("pid") in mine,
            "state": d.get("status") or "?",
            "since": ago(d.get("statusUpdatedAt") or d.get("updatedAt")),
            "started": ago(d.get("startedAt")),
            "kind": d.get("kind"),
            "cwd": os.path.basename(cwd),
            "works_in": [{"folder": f, "branch": b} for f, b in where],
            "keys": keys,
            "note": work_note(keys),
            "prompt": t["prompt"],
            "said": t["said"],
            "mentions": t["mentions"],  # ticket keys and PRs, most recent first, with how many recent items name each
            "model": t["model"],
            "used": t["used"],
            "window": win,
            "left_pct": None if t["used"] is None or not win else max(0, round(100 - 100 * t["used"] / win)),
        })
    if "--json" in sys.argv:
        print(json.dumps(rows, indent=2))
        return
    print("| Session | State | Working in | Ticket / note | Last prompt | Context left |")
    print("|---|---|---|---|---|---|")
    for r in rows:
        name = r["name"] + (" (this one)" if r["this"] else "")
        state = f"{r['state']} {r['since']}".strip()
        where = ", ".join(w["folder"] + (" (gone)" if w["branch"] is None else f" @ {w['branch']}" if w["branch"] else "")
                          for w in r["works_in"])
        note = r["note"]
        ticket = f"{note['key']}: {note['status']}" if note else ", ".join(r["keys"][:2])
        if r["used"] is None:
            ctx = "?"
        elif r["window"]:
            ctx = f"{r['left_pct']}% ({k(r['used'])} of {k(r['window'])})"
        else:
            ctx = f"{k(r['used'])} used, window unknown"
        cells = [name, state, where, ticket, r["prompt"].replace("|", "/"), ctx]
        print("| " + " | ".join(c.replace("\n", " ") for c in cells) + " |")


if __name__ == "__main__":
    main()
