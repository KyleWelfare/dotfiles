import type { LogEvent, PlanItem, TicketConfig, WorklogConfig } from '../types'

/** The per-machine settings file shared/setup.ts writes, relative to the home folder. */
export const CONFIG_PATH = '.config/dotfiles/local.json'

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const expandHome = (path: string, home: string) => path.replace(/^~(?=$|[\\/])/, home)

// Uppercase only, so branch words like node-18 don't read as tickets.
const DEFAULT_TICKET_PATTERN = '[A-Z][A-Z0-9]+-\\d+'

/**
 * The worklog part of local.json, defaults applied: a missing or unreadable file means your own PRs
 * through gh's active account, and no ticket links.
 */
export function parseConfig(json: string, home: string): WorklogConfig {
  let raw: unknown = {}
  try {
    raw = JSON.parse(json)
  } catch {
    // Not set up yet, or hand-edited into invalid JSON: run on the defaults.
  }
  const worklog = (raw as { worklog?: Record<string, unknown> } | null)?.worklog ?? {}
  const github = (worklog.github ?? {}) as Record<string, unknown>
  const org = str(github.org) || null
  return {
    root: expandHome(str(worklog.root) || '~/Documents/Work Log', home),
    github:
      github.enabled === false ? null : { user: str(github.user) || null, org, team: org ? str(github.team) || null : null },
    tickets: parseTickets((worklog.tickets ?? {}) as Record<string, unknown>),
  }
}

function parseTickets(raw: Record<string, unknown>): TicketConfig | null {
  const url = str(raw.url)
  if (!url.includes('{id}')) return null
  const custom = str(raw.pattern)
  try {
    new RegExp(custom || DEFAULT_TICKET_PATTERN)
  } catch {
    return null
  }
  // A custom pattern matches in any case, since branch names are often lowercase.
  return { url, pattern: custom || DEFAULT_TICKET_PATTERN, flags: custom ? 'i' : '' }
}

/** The ticket's page: the configured URL with the ID in place of {id}. */
export const ticketUrl = (tickets: TicketConfig, id: string) => tickets.url.replaceAll('{id}', encodeURIComponent(id))

const CHECKBOX = /^(\t*)- \[( |x|X)\] (.*)$/
const BULLET = /^(\t*)- (.*)$/
const SECTION = /^## (.+)$/
const TRACKED = new Set(['Plan', 'Nice to have', 'Reviews', 'My open PRs'])

const LINK = /\[([^\]]+)\]\(([^)]+)\)/g

export function stripLinks(text: string): string {
  return text.replace(LINK, '$1')
}

export function extractLinks(text: string): Record<string, string> {
  const links: Record<string, string> = {}
  for (const [, label = '', href = ''] of text.matchAll(LINK)) links[label] = href
  return links
}

export function parsePlan(markdown: string): PlanItem[] {
  const items: PlanItem[] = []
  let section = ''
  markdown.split('\n').forEach((raw, line) => {
    const heading = SECTION.exec(raw)
    if (heading) {
      section = (heading[1] ?? '').trim()
      return
    }
    if (!TRACKED.has(section)) return
    const box = CHECKBOX.exec(raw)
    if (box) {
      const [, indent = '', mark = ' ', text = ''] = box
      items.push({ line, raw, section, depth: indent.length, text: stripLinks(text), links: extractLinks(text), isCheckbox: true, isDone: mark !== ' ' })
      return
    }
    const bullet = BULLET.exec(raw)
    if (bullet) {
      const [, indent = '', text = ''] = bullet
      items.push({ line, raw, section, depth: indent.length, text: stripLinks(text), links: extractLinks(text), isCheckbox: false, isDone: false })
    }
  })
  return items
}

/** Flips one checkbox line, or returns null when the line no longer matches what was drawn. */
export function toggleLine(markdown: string, line: number, expectedRaw: string): string | null {
  const lines = markdown.split('\n')
  if (lines[line] !== expectedRaw) return null
  const box = CHECKBOX.exec(expectedRaw)
  if (!box) return null
  const [, indent = '', mark = ' ', text = ''] = box
  lines[line] = `${indent}- [${mark === ' ' ? 'x' : ' '}] ${text}`
  return lines.join('\n')
}

export function parseEvents(jsonl: string): LogEvent[] {
  const events: LogEvent[] = []
  for (const raw of jsonl.split('\n')) {
    if (raw.trim() === '') continue
    try {
      events.push(JSON.parse(raw) as LogEvent)
    } catch {
      // A line half-written by a concurrent append is skipped, not fatal.
    }
  }
  return events
}

/**
 * Splits "Do thing (Spec, PR #2)" into the description and its trailing ref list: a closing parenthetical
 * whose every part is one of the line's link labels or a bare PR number.
 */
export function splitRefs(text: string, links: Record<string, string> = {}): { title: string; refs: string } {
  const match = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(text)
  const parts = (match?.[2] ?? '').split(/,\s*/)
  if (!match || !parts.every(part => part in links || /^(PR )?#\d+$/.test(part))) return { title: text, refs: '' }
  return { title: match[1] ?? text, refs: parts.join(' · ') }
}

/** Splits "#12 [tag] Title - approved" into number, title (a leading [tag] dropped) and state. */
export function splitPr(text: string): { number: string; title: string; state: string } {
  const match = /^(\S+)\s+(.*?)(?:\s+-\s+([^-]+))?$/.exec(text)
  if (!match) return { number: '', title: text, state: '' }
  const title = (match[2] ?? '').replace(/^\[[^\]]*\]\s*/, '')
  return { number: match[1] ?? '', title, state: (match[3] ?? '').trim() }
}

/** The first ticket ID in the text, uppercased, or null when ticket links are off. */
export function ticketFrom(text: string | undefined, tickets: TicketConfig | null): string | null {
  if (!tickets) return null
  const match = new RegExp(`(?<![A-Za-z0-9])(?:${tickets.pattern})(?![A-Za-z0-9])`, tickets.flags).exec(text ?? '')
  return match ? match[0].toUpperCase() : null
}

const SECTION_ORDER = ['Plan', 'Nice to have', 'Reviews', 'My open PRs', 'Wrap-up']

export type SearchedPr = { number: number; title: string; url: string; repository: { name: string } }

/** "app#29": the repo name keeps PRs from different repos apart in one list. */
export function prLabel(pr: SearchedPr): string {
  return `${pr.repository.name}#${pr.number}`
}

export function prState(pr: { isDraft: boolean; reviewDecision?: string | null; failingChecks: number }): string {
  if (pr.isDraft) return 'draft'
  if (pr.failingChecks > 0) return 'CI failing'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested'
  if (pr.reviewDecision === 'APPROVED') return 'approved'
  return 'awaiting review'
}

/** The searched review requests the log's Reviews section does not list yet, checked or not. */
export function newReviews<T extends SearchedPr>(markdown: string, fresh: T[]): T[] {
  const listed = new Set(
    parsePlan(markdown)
      .filter(item => item.section === 'Reviews')
      .flatMap(item => Object.values(item.links)),
  )
  return fresh.filter(pr => !listed.has(pr.url))
}

/**
 * Review rows for the fresh search, keeping each one already checked off. A submitted review drops the
 * request, so a checked row the search no longer returns is kept as written rather than deleted, and so is an
 * unchecked one in `finished` (reviewed by you, merged or closed), checked off; any other dropped row is a
 * withdrawn request and goes.
 */
export function mergeReviews(
  markdown: string,
  fresh: Array<SearchedPr & { author: { login: string } }>,
  finished: Set<string> = new Set(),
): string[] {
  const existing = parsePlan(markdown).filter(item => item.section === 'Reviews' && item.isCheckbox)
  const urlOf = (item: PlanItem) => Object.values(item.links)[0] ?? ''
  const done = new Set(existing.filter(item => item.isDone).map(urlOf))
  const freshUrls = new Set(fresh.map(pr => pr.url))
  const rows = fresh.map(pr => `- [${done.has(pr.url) ? 'x' : ' '}] [${prLabel(pr)}](${pr.url}) ${pr.title} - @${pr.author.login}`)
  const kept = existing
    .filter(item => !freshUrls.has(urlOf(item)) && (item.isDone || finished.has(urlOf(item))))
    .map(item => (item.isDone ? item.raw : item.raw.replace('- [ ]', '- [x]')))
  return [...rows, ...kept]
}

/** The unchecked Reviews rows the fresh search no longer returns: reviewed, merged, closed or withdrawn. */
export function droppedReviews(markdown: string, fresh: SearchedPr[]): string[] {
  const freshUrls = new Set(fresh.map(pr => pr.url))
  return parsePlan(markdown)
    .filter(item => item.section === 'Reviews' && item.isCheckbox && !item.isDone)
    .map(item => Object.values(item.links)[0] ?? '')
    .filter(url => url !== '' && !freshUrls.has(url))
}

const PULL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/

/** The PR a Plan or Nice to have row is about: the link it starts with, as PR rows are written. */
export function rowPr(item: PlanItem): string | null {
  for (const [label, href] of Object.entries(item.links)) {
    if (PULL.test(href) && (item.text === label || item.text.startsWith(`${label} `))) return href
  }
  return null
}

/**
 * Ticks each unchecked Plan and Nice to have row that is a PR `isMerged` says merged, then each parent whose
 * sub-items are all ticked, deepest first. A row that only links a PR among other work is left for /sync-day to judge.
 */
export function tickMerged(markdown: string, isMerged: (url: string) => boolean): { markdown: string; ticked: string[] } {
  const items = parsePlan(markdown).filter(item => item.isCheckbox && (item.section === 'Plan' || item.section === 'Nice to have'))
  const done = new Set(items.filter(item => item.isDone).map(item => item.line))
  const ticked: PlanItem[] = []
  for (const item of items) {
    const pr = rowPr(item)
    if (!done.has(item.line) && pr !== null && isMerged(pr)) {
      done.add(item.line)
      ticked.push(item)
    }
  }
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item === undefined || done.has(item.line)) continue
    const children: PlanItem[] = []
    for (const next of items.slice(index + 1)) {
      if (next.section !== item.section || next.depth <= item.depth) break
      if (next.depth === item.depth + 1) children.push(next)
    }
    if (children.length > 0 && children.every(child => done.has(child.line))) {
      done.add(item.line)
      ticked.push(item)
    }
  }
  let next = markdown
  for (const item of ticked) next = toggleLine(next, item.line, item.raw) ?? next
  return { markdown: next, ticked: ticked.map(item => item.text) }
}

/** Replaces a section's body, inserting it in template order when absent and dropping it when empty. */
export function replaceSection(markdown: string, section: string, rows: string[]): string {
  const lines = markdown.split('\n')
  const headingOf = (raw: string) => SECTION.exec(raw)?.[1]?.trim()
  const start = lines.findIndex(raw => headingOf(raw) === section)
  const block = rows.length > 0 ? [`## ${section}`, ...rows, ''] : []
  if (start >= 0) {
    const nextHeading = lines.findIndex((raw, i) => i > start && headingOf(raw) !== undefined)
    const end = nextHeading >= 0 ? nextHeading : lines.length
    lines.splice(start, end - start, ...block)
    return lines.join('\n')
  }
  if (block.length === 0) return markdown
  const rank = SECTION_ORDER.indexOf(section)
  const before = lines.findIndex(raw => SECTION_ORDER.indexOf(headingOf(raw) ?? '') > rank)
  if (before < 0) return [...lines, ...(lines.at(-1) === '' ? [] : ['']), ...block].join('\n')
  lines.splice(before, 0, ...block)
  return lines.join('\n')
}
