import { Box, Text } from 'ink'

import type { LogEvent, PlanItem } from '@worklog-types'
import { splitPr, splitRefs, ticketFrom, ticketUrl } from '@worklog/parse.ts'

import { CONFIG, type Day } from './log.ts'
import { REVIEW_BOT, type ReviewEntry, type ReviewerState, isStale, resumeUrl } from './reviews.ts'
import type { LiveSession, SessionState } from './sessions.ts'

// Catppuccin Mocha, to match the WezTerm theme.
const C = {
  accent: '#cba6f7',
  text: '#cdd6f4',
  muted: '#7f849c',
  green: '#a6e3a1',
  red: '#f38ba8',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  peach: '#fab387',
  teal: '#94e2d5',
  cursor: '#45475a',
}

const PR_STATE_COLORS: Record<string, string> = {
  approved: C.green,
  merged: C.accent,
  'CI failing': C.red,
  'changes requested': C.yellow,
  'awaiting review': C.blue,
  draft: C.muted,
}

const EVENT_ICONS: Record<string, { glyph: string; color: string }> = {
  done: { glyph: '✓', color: C.green },
  progress: { glyph: '↑', color: C.blue },
  session: { glyph: '◆', color: C.peach },
  decision: { glyph: '!', color: C.yellow },
  review: { glyph: '◎', color: C.accent },
  'review-ready': { glyph: '●', color: C.green },
  unblock: { glyph: '→', color: C.green },
  investigation: { glyph: '?', color: C.teal },
}

const SECTION_TITLES: Record<string, string> = { Reviews: 'Reviews', 'My open PRs': 'My Open PRs' }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Parsed at UTC noon so the weekday never shifts with the timezone.
function formatDate(date: string): string {
  const day = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(day.getTime())) return date
  return `${DAYS[day.getUTCDay()]}, ${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`
}

/** OSC 8 hyperlink; WezTerm opens it on click. ST-terminated: Ink strips BEL and then mismeasures the row. */
const link = (label: string, href: string | undefined) => (href ? `\u001b]8;;${href}\u001b\\${label}\u001b]8;;\u001b\\` : label)

// Side by side from here, each column wide enough that refs stay beside their titles.
const WIDE_FROM = 120

/** Dots filling the gap between a title and its refs; basis 0 so it only takes space the title leaves. */
const Leader = () => (
  <Box flexGrow={1} flexBasis={0} height={1} overflow="hidden">
    <Text color={C.cursor} wrap="hard">
      {'·'.repeat(300)}
    </Text>
  </Box>
)

export type SyncState ={ isOff: boolean; isRunning: boolean; lastAt: string | null; error: string | null }

/** The rows the cursor walks: every checkbox in Plan, Nice to have and Reviews, in file order. */
export function selectable(day: Day): PlanItem[] {
  return day.items.filter(item => item.isCheckbox)
}

const REVIEWER_MARKS: Record<ReviewerState, { glyph: string; color: string }> = {
  approved: { glyph: '✓', color: C.green },
  changes: { glyph: '✗', color: C.red },
  commented: { glyph: '◌', color: C.muted },
}
const MAX_REVIEWERS = 3

const SESSION_MARKS: Record<SessionState, { glyph: string; color: string }> = {
  busy: { glyph: '◐', color: C.yellow },
  waiting: { glyph: '●', color: C.peach },
  idle: { glyph: '○', color: C.blue },
}

/**
 * A session's state spelled out with its context left (`◐ busy 59%`), in full color so it stands apart from the gray
 * refs, and linked so a click switches to its tab (wezterm.lua's open-uri handler).
 */
export function SessionMark({ session }: { session: LiveSession }) {
  const mark = SESSION_MARKS[session.state]
  const href = session.paneId === null ? undefined : `prsession://activate?pane=${session.paneId}`
  const label = `${mark.glyph} ${session.state}${session.leftPct === null ? '' : ` ${session.leftPct}%`}`
  return <Text color={mark.color}>{link(label, href)}</Text>
}

/** The latest log events, newest first. */
export function Recent({ events, count }: { events: LogEvent[]; count: number }) {
  return events
    .slice(-count)
    .reverse()
    .map((event, index) => {
      const icon = EVENT_ICONS[event.kind] ?? { glyph: '•', color: C.muted }
      const ticket = CONFIG.tickets && event.ticket ? link(event.ticket, ticketUrl(CONFIG.tickets, event.ticket)) : null
      return (
        <Text key={`event-${index}`} color={C.text} wrap="truncate-end">
          <Text color={C.muted}>{event.ts.slice(11, 16)}</Text> <Text color={icon.color}>{icon.glyph}</Text> {event.text}
          {ticket && <Text color={C.muted}> · {ticket}</Text>}
        </Text>
      )
    })
}

/** Plan text with inline code shown without its backticks, in its own color, and **bold** as bold. */
function Inline({ text, isMuted }: { text: string; isMuted: boolean }) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, index) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <Text key={index} color={isMuted ? C.muted : C.peach}>
          {part.slice(1, -1)}
        </Text>
      )
    }
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return (
        <Text key={index} bold>
          {part.slice(2, -2)}
        </Text>
      )
    }
    return part
  })
}

/** What the review bot is doing with a Reviews row; a ready one links to its session. */
function reviewStatus(entry: ReviewEntry | undefined): { text: string; color: string; href?: string } | null {
  if (entry === undefined) return null
  switch (entry.status) {
    case 'idle':
      return { text: 'v to review', color: C.muted }
    case 'queued':
      return { text: entry.error ? 'retrying' : 'queued', color: C.muted }
    case 'reviewing':
      return { text: `reviewing ${Math.max(0, Math.floor((Date.now() - Date.parse(entry.startedAt ?? '')) / 60_000))}m`, color: C.yellow }
    case 'failed':
      return { text: 'failed · v to retry', color: C.red }
    case 'ready': {
      const parts = ['report ready']
      if (entry.toAddress !== null) parts.push(entry.toAddress === 0 ? 'nothing to address' : `${entry.toAddress} to address`)
      const stale = isStale(entry)
      if (stale) parts.push(entry.commitsSince ? `stale (${entry.commitsSince} commit${entry.commitsSince === 1 ? '' : 's'})` : 'stale')
      return { text: parts.join(' · '), color: stale ? C.peach : C.green, href: resumeUrl(entry) }
    }
  }
}

type Props = {
  day: Day
  width: number
  height: number
  cursorLine: number | null
  sync: SyncState
  reviews: Record<string, ReviewEntry>
  autoReview: boolean
  /** The live sessions working on each plan item, keyed by its line. */
  sessions: Map<number, LiveSession[]>
}

export function Dashboard({ day, width, height, cursorLine, sync, reviews, autoReview, sessions }: Props) {
  if (!day.hasFile) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={C.accent}>{formatDate(day.date)}</Text>
        <Text color={C.muted}>No log for today yet: {day.path}</Text>
      </Box>
    )
  }

  const isWide = width >= WIDE_FROM
  const columnWidth = isWide ? Math.floor((width - 3) / 2) : width - 2
  const plan = day.items.filter(item => item.section === 'Plan')
  const nice = day.items.filter(item => item.section === 'Nice to have')
  const top = plan.filter(item => item.depth === 0)
  const done = top.filter(item => item.isDone).length
  const barWidth = Math.max(10, Math.min(40, columnWidth - 30))
  const filled = top.length === 0 ? 0 : Math.round((done / top.length) * barWidth)
  const secondary = ['Reviews', 'My open PRs'].filter(section => day.items.some(item => item.section === section))

  const mark = (item: PlanItem) => (
    <Text color={item.isDone ? C.green : C.muted} backgroundColor={item.line === cursorLine ? C.cursor : undefined}>
      {item.isDone ? '✓' : '○'}
    </Text>
  )

  const planRow = (item: PlanItem, index: number, list: PlanItem[], isMuted: boolean) => {
    const { title, refs } = splitRefs(item.text, item.links)
    const next = list[index + 1]
    const branch = item.depth === 0 ? '' : next !== undefined && next.depth >= item.depth ? '├─ ' : '└─ '
    const isCursor = item.line === cursorLine
    const working = sessions.get(item.line) ?? []
    return (
      <Box key={`row-${item.line}`} columnGap={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={C.muted}>
              {'   '.repeat(Math.max(0, item.depth - 1))}
              {item.depth > 0 ? '  ' : ''}
              {branch}
            </Text>
            {mark(item)}{' '}
            <Text
              bold={!item.isDone && !isMuted && item.depth === 0}
              color={item.isDone || isMuted ? C.muted : C.text}
              backgroundColor={isCursor ? C.cursor : undefined}
              strikethrough={item.isDone}
            >
              <Inline text={title} isMuted={item.isDone || isMuted} />
            </Text>
          </Text>
        </Box>
        {(refs !== '' || working.length > 0) && <Leader />}
        {working.length > 0 && (
          <Box flexShrink={0} columnGap={1}>
            {working.map(session => (
              <SessionMark key={session.pid} session={session} />
            ))}
            {refs !== '' && <Text color={C.muted}>│</Text>}
          </Box>
        )}
        {refs !== '' && (
          <Box flexShrink={0}>
            <Text color={C.muted}>
              {refs
                .split(' · ')
                .map(ref => link(ref, item.links[ref]))
                .join(' · ')}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  const prRow = (item: PlanItem) => {
    if (item.isCheckbox) {
      const { title } = splitRefs(item.text, item.links)
      const [number = '', ...rest] = title.split(' ')
      // The ticket in a review title's leading [KEY] moves to the right, beside the bot status.
      const prefix = /^\[([^\]]+)\]$/.exec(rest[0] ?? '')?.[1]
      const ticket = prefix && CONFIG.tickets ? ticketFrom(prefix, CONFIG.tickets) : null
      const words = ticket ? rest.slice(1) : rest
      const review = item.section === 'Reviews' ? reviews[item.links[number] ?? ''] : undefined
      const status = reviewStatus(review)
      const others = review?.reviewers ?? []
      const right = [
        ...others.slice(0, MAX_REVIEWERS).map(reviewer => {
          const state = REVIEWER_MARKS[reviewer.state]
          return (
            <Text key={reviewer.name}>
              {reviewer.name} <Text color={state.color}>{state.glyph}</Text>
            </Text>
          )
        }),
        ...(others.length > MAX_REVIEWERS ? [<Text key="more">+{others.length - MAX_REVIEWERS}</Text>] : []),
        ...(ticket && CONFIG.tickets ? [<Text key="ticket">{link(ticket, ticketUrl(CONFIG.tickets, ticket))}</Text>] : []),
        ...(status ? [<Text key="status" color={status.color}>{link(status.text, status.href)}</Text>] : []),
      ]
      // One Text per row: Ink drops a gap beside a colored symbol glyph and adds a blank line.
      return (
        <Box key={`row-${item.line}`} justifyContent="space-between" columnGap={2}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              {mark(item)}{' '}
              <Text
                color={item.isDone ? C.muted : C.text}
                backgroundColor={item.line === cursorLine ? C.cursor : undefined}
                strikethrough={item.isDone}
              >
                {link(number, item.links[number])} {words.join(' ')}
              </Text>
            </Text>
          </Box>
          {right.length > 0 && (
            <Box flexShrink={0}>
              <Text color={C.muted}>{right.flatMap((part, index) => (index === 0 ? [part] : [' · ', part]))}</Text>
            </Box>
          )}
        </Box>
      )
    }
    const pr = splitPr(item.text)
    return (
      <Box key={`row-${item.line}`} justifyContent="space-between" columnGap={2}>
        {/* One Text, so a long repo label truncates along with the title instead of wrapping in its own column. */}
        <Box flexShrink={1}>
          <Text color={C.text} wrap="truncate-end">
            <Text color={C.blue}>{link(pr.number, item.links[pr.number])}</Text> {pr.title}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={PR_STATE_COLORS[pr.state] ?? C.muted}>{pr.state}</Text>
        </Box>
      </Box>
    )
  }

  const syncState = sync.isOff ? 'PR sync off' : sync.isRunning ? 'syncing…' : sync.lastAt ? `synced ${sync.lastAt}` : 'not synced'
  const syncLine = REVIEW_BOT ? `${syncState} · reviews ${autoReview ? 'auto' : 'manual'}` : syncState

  const left = (
    <Box flexDirection="column" width={columnWidth} flexShrink={0}>
      <Box justifyContent="space-between">
        <Box columnGap={1}>
          <Text bold color={C.accent}>
            {formatDate(day.date)}
          </Text>
          <Text>
            <Text color={C.green}>{'━'.repeat(filled)}</Text>
            <Text color={C.cursor}>{'━'.repeat(barWidth - filled)}</Text>
          </Text>
          <Text color={done === top.length && top.length > 0 ? C.green : C.muted}>
            {done}/{top.length}
          </Text>
        </Box>
        <Text color={sync.error ? C.red : C.muted}>{sync.error ? `sync failed: ${sync.error}` : syncLine}</Text>
      </Box>
      {plan.map((item, index) => planRow(item, index, plan, false))}
      {nice.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={C.muted} italic>
            Nice to have
          </Text>
          {nice.map((item, index) => planRow(item, index, nice, true))}
        </Box>
      )}
    </Box>
  )

  const right = (
    <Box flexDirection="column" width={columnWidth} flexShrink={0}>
      {secondary.map((section, index) => (
        <Box key={section} flexDirection="column" marginTop={index === 0 && isWide ? 0 : 1}>
          <Text bold color={C.text}>
            {SECTION_TITLES[section] ?? section}
          </Text>
          {day.items.filter(item => item.section === section).map(prRow)}
        </Box>
      ))}
    </Box>
  )

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" paddingX={1}>
      {/* flex-start keeps each column at its own height: stretched to the pane, its rows would shrink to
          nothing and draw over each other instead of being cut off at the bottom. */}
      <Box flexDirection={isWide ? 'row' : 'column'} alignItems="flex-start" columnGap={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {left}
        {right}
      </Box>
      <Text color={C.muted} wrap="truncate-end">
        ↑↓ move · space toggle · o open · g go to session{REVIEW_BOT ? ` · v review · a ${autoReview ? 'manual' : 'auto'} reviews` : ''} · s sync · r reload · q quit
      </Text>
    </Box>
  )
}
