import { Box, Text } from 'ink'

import type { PlanItem } from '@worklog-types'
import { splitPr, splitRefs, ticketUrl } from '@worklog/parse.ts'

import { CONFIG, type Day } from './log.ts'

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
const RECENT_COUNT = 5

export type SyncState = { isOff: boolean; isRunning: boolean; lastAt: string | null; error: string | null }

/** The rows the cursor walks: every checkbox in Plan, Nice to have and Reviews, in file order. */
export function selectable(day: Day): PlanItem[] {
  return day.items.filter(item => item.isCheckbox)
}

type Props = { day: Day; width: number; height: number; cursorLine: number | null; sync: SyncState }

export function Dashboard({ day, width, height, cursorLine, sync }: Props) {
  if (!day.hasFile) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={C.accent}>{formatDate(day.date)}</Text>
        <Text color={C.muted}>No plan yet. Run /plan-day in Claude.</Text>
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
  const recent = day.events.slice(-RECENT_COUNT).reverse()

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
    return (
      <Box key={`row-${item.line}`} justifyContent="space-between" columnGap={2}>
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
              {title}
            </Text>
          </Text>
        </Box>
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
      const [number = '', ...words] = title.split(' ')
      // One Text per row: Ink drops a gap beside a colored symbol glyph and adds a blank line.
      return (
        <Text key={`row-${item.line}`} wrap="truncate-end">
          {mark(item)}{' '}
          <Text
            color={item.isDone ? C.muted : C.text}
            backgroundColor={item.line === cursorLine ? C.cursor : undefined}
            strikethrough={item.isDone}
          >
            {link(number, item.links[number])} {words.join(' ')}
          </Text>
        </Text>
      )
    }
    const pr = splitPr(item.text)
    return (
      <Box key={`row-${item.line}`} justifyContent="space-between" columnGap={2}>
        <Box flexShrink={1} columnGap={1}>
          <Text color={C.blue}>{link(pr.number, item.links[pr.number])}</Text>
          <Text color={C.text} wrap="truncate-end">
            {pr.title}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={PR_STATE_COLORS[pr.state] ?? C.muted}>{pr.state}</Text>
        </Box>
      </Box>
    )
  }

  const syncLine = sync.isOff ? 'PR sync off' : sync.isRunning ? 'syncing…' : sync.lastAt ? `synced ${sync.lastAt}` : 'not synced'

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
      {recent.length > 0 && (
        <Box flexDirection="column" marginTop={secondary.length === 0 && isWide ? 0 : 1}>
          <Text bold color={C.text}>
            Recent
          </Text>
          {recent.map((event, index) => {
            const icon = EVENT_ICONS[event.kind] ?? { glyph: '•', color: C.muted }
            const ticket = CONFIG.tickets && event.ticket ? link(event.ticket, ticketUrl(CONFIG.tickets, event.ticket)) : null
            return (
              <Text key={`event-${index}`} color={C.text} wrap="truncate-end">
                <Text color={C.muted}>{event.ts.slice(11, 16)}</Text> <Text color={icon.color}>{icon.glyph}</Text>{' '}
                {event.text}
                {ticket && <Text color={C.muted}> · {ticket}</Text>}
              </Text>
            )
          })}
        </Box>
      )}
    </Box>
  )

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" paddingX={1}>
      <Box flexDirection={isWide ? 'row' : 'column'} columnGap={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {left}
        {right}
      </Box>
      <Text color={C.muted} wrap="truncate-end">
        ↑↓ move · space toggle · o open · s sync · r reload · q quit
      </Text>
    </Box>
  )
}
