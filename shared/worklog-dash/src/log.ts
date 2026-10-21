import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { LogEvent, PlanItem } from '@worklog-types'
import { CONFIG_PATH, parseConfig, parseEvents, parsePlan } from '@worklog/parse.ts'

// Read once at start; rerunning shared/setup.ts takes effect when the dashboard restarts.
export const CONFIG = parseConfig(await readOr(join(homedir(), CONFIG_PATH), ''), homedir())
export const ROOT = CONFIG.root

export const dayPath = (date: string) => `${ROOT}/${date.slice(0, 4)}/${date.slice(0, 7)}/${date}.md`
export const eventsPath = (date: string) => `${ROOT}/.events/${date}.jsonl`

export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Local time with its offset, the shape the mod's events use (`2026-10-16T09:45:09-0400`). */
export function localTimestamp(now = new Date()): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(offset / 60)}${pad(offset % 60)}`
}

export type Day = {
  date: string
  path: string
  hasFile: boolean
  markdown: string
  items: PlanItem[]
  events: LogEvent[]
}

async function readOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return fallback
  }
}

export async function loadDay(date = localDate()): Promise<Day> {
  const path = dayPath(date)
  const markdown = await readOr(path, '')
  const events = parseEvents(await readOr(eventsPath(date), ''))
  return { date, path, hasFile: markdown !== '', markdown, items: parsePlan(markdown), events }
}

/** O_APPEND keeps a line whole beside the mod's and /log's concurrent appends. */
export async function appendEvent(event: Pick<LogEvent, 'kind' | 'text' | 'ticket' | 'pr'>): Promise<void> {
  const date = localDate()
  await mkdir(dirname(eventsPath(date)), { recursive: true })
  await appendFile(eventsPath(date), `${JSON.stringify({ ts: localTimestamp(), source: 'dashboard', ...event })}\n`)
}
