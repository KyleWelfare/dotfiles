import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PlanItem } from '@worklog-types'

import { run } from './sync.ts'

const SESSIONS_SCRIPT = join(homedir(), '.claude/skills/sessions/scripts/sessions.py')
const WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'

// A session belongs to a plan item only when one of its rows' ticket or PRs comes up in at least this many of its
// recent prompts and replies; a few passing mentions (a review, a status report) shouldn't move it onto the plan.
const MIN_TEXTS = 3
// Within an item, a sub-item takes the session when it has this share of the item's mentions; otherwise the parent.
const CHILD_SHARE = 0.6

export type SessionState = 'busy' | 'waiting' | 'idle'

export type LiveSession = {
  name: string
  pid: number
  state: SessionState
  since: string
  leftPct: number | null
  /** The session's title as WezTerm shows it on the pane, without the leading status glyph. */
  title: string | null
  paneId: number | null
  isThis: boolean
  mentions: Array<{ ref: string; texts: number }>
}

type RawSession = {
  name: string
  pid: number
  this: boolean
  state: string
  since: string
  kind: string
  said: string
  left_pct: number | null
  mentions?: Array<{ ref: string; texts: number }>
}

type Pane = { pane_id: number; tty_name?: string; title: string }

async function json<T>(argv: string[]): Promise<T | null> {
  const result = await run(argv).catch(() => null)
  if (result === null || result.exitCode !== 0) return null
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    return null
  }
}

/** Each pid's controlling tty, as WezTerm names it (/dev/ttys005). */
async function ttys(pids: number[]): Promise<Map<number, string>> {
  const result = await run(['ps', '-o', 'pid=,tty=', '-p', pids.join(',')]).catch(() => null)
  const map = new Map<number, string>()
  for (const line of result?.stdout.split('\n') ?? []) {
    const [pid, tty] = line.trim().split(/\s+/)
    if (pid && tty && tty !== '??') map.set(Number(pid), `/dev/${tty}`)
  }
  return map
}

/** Every live interactive Claude session (the review bot's headless runs are left out), with its WezTerm pane. */
export async function loadSessions(): Promise<LiveSession[]> {
  const raw = (await json<RawSession[]>(['python3', '-I', SESSIONS_SCRIPT, '--json'])) ?? []
  const live = raw.filter(session => session.kind === 'interactive')
  if (live.length === 0) return []
  const [panes, byPid] = await Promise.all([json<Pane[]>([WEZTERM, 'cli', 'list', '--format', 'json']), ttys(live.map(s => s.pid))])
  const byTty = new Map((panes ?? []).map(pane => [pane.tty_name ?? '', pane]))
  return live.map(session => {
    const pane = byTty.get(byPid.get(session.pid) ?? '')
    // Any status besides busy and idle is Claude waiting on a prompt, such as a permission request; an idle session
    // whose last reply asks something is waiting on you too.
    const state: SessionState =
      session.state === 'busy' ? 'busy' : session.state !== 'idle' || session.said.trim().endsWith('?') ? 'waiting' : 'idle'
    return {
      name: session.name,
      pid: session.pid,
      state,
      since: session.since,
      leftPct: session.left_pct,
      title: pane ? pane.title.replace(/^[^\p{L}\p{N}]+/u, '').trim() || null : null,
      paneId: pane?.pane_id ?? null,
      isThis: session.this,
      mentions: session.mentions ?? [],
    }
  })
}

/** The plan item each session works on (keyed by line), and the sessions that match none. */
export function matchSessions(
  items: PlanItem[],
  sessions: LiveSession[],
): { byLine: Map<number, LiveSession[]>; other: LiveSession[] } {
  // Top-level items with their sub-items, each row with the lowercased labels of its links.
  const groups: Array<Array<{ item: PlanItem; labels: Set<string> }>> = []
  for (const item of items) {
    if (item.section !== 'Plan' && item.section !== 'Nice to have') continue
    const row = { item, labels: new Set(Object.keys(item.links).map(label => label.toLowerCase())) }
    if (item.depth === 0 || groups.length === 0) groups.push([row])
    else groups.at(-1)?.push(row)
  }
  const byLine = new Map<number, LiveSession[]>()
  const other: LiveSession[] = []
  for (const session of sessions) {
    const texts = new Map(session.mentions.map(m => [m.ref.toLowerCase(), m.texts]))
    const score = (labels: Set<string>) => [...labels].reduce((sum, label) => sum + (texts.get(label) ?? 0), 0)
    let best: { rows: Array<{ item: PlanItem; score: number }>; total: number } | null = null
    for (const group of groups) {
      const rows = group.map(row => ({ item: row.item, score: score(row.labels) }))
      const total = rows.reduce((sum, row) => sum + row.score, 0)
      const strongest = Math.max(...rows.map(row => row.score))
      if (strongest >= MIN_TEXTS && (best === null || total > best.total)) best = { rows, total }
    }
    if (best === null) {
      other.push(session)
      continue
    }
    const [parent, ...children] = best.rows
    const child = children.reduce<{ item: PlanItem; score: number } | null>((top, row) => (top && top.score >= row.score ? top : row), null)
    const target = child && child.score >= best.total * CHILD_SHARE ? child.item : (parent?.item ?? child?.item)
    if (target === undefined) continue
    byLine.set(target.line, [...(byLine.get(target.line) ?? []), session])
  }
  return { byLine, other }
}

/** Switches WezTerm to the session's tab and pane. */
export function activateSession(session: LiveSession): void {
  if (session.paneId === null) return
  Bun.spawn([WEZTERM, 'cli', 'activate-pane', '--pane-id', String(session.paneId)], { stdout: 'ignore', stderr: 'ignore' })
}
