import { describe, expect, test } from 'bun:test'

import type { PlanItem } from '@worklog-types'

import { type LiveSession, matchSessions } from './sessions.ts'

const row = (line: number, depth: number, labels: string[]): PlanItem => ({
  line,
  raw: '',
  section: 'Plan',
  depth,
  text: '',
  isCheckbox: true,
  isDone: false,
  links: Object.fromEntries(labels.map(label => [label, `https://x/${label}`])),
})

const session = (pid: number, mentions: Record<string, number>): LiveSession => ({
  name: `s${pid}`,
  pid,
  state: 'idle',
  since: '0m',
  leftPct: 50,
  title: null,
  paneId: null,
  isThis: false,
  mentions: Object.entries(mentions).map(([ref, texts]) => ({ ref, texts })),
})

const plan = [row(1, 0, ['IS-2804']), row(2, 1, ['minigames#2309']), row(3, 1, ['minigames#2310']), row(4, 0, ['IS-2538'])]

describe('matchSessions', () => {
  test('a session spread over several sub-items goes on the parent', () => {
    const { byLine } = matchSessions(plan, [session(1, { 'minigames#2309': 3, 'minigames#2310': 3, 'IS-2804': 1 })])
    expect(byLine.get(1)?.map(s => s.pid)).toEqual([1])
  })

  test('a session mostly on one sub-item goes on it, matched without case', () => {
    const { byLine } = matchSessions(plan, [session(1, { 'MINIGAMES#2310': 4, 'IS-2804': 1 })])
    expect(byLine.get(3)?.map(s => s.pid)).toEqual([1])
  })

  test('passing mentions spread over an item leave a session unmatched', () => {
    const { other } = matchSessions(plan, [session(1, { 'IS-2804': 1, 'minigames#2309': 2 })])
    expect(other.map(s => s.pid)).toEqual([1])
  })

  test('a couple of passing mentions leave a session unmatched', () => {
    const { byLine, other } = matchSessions(plan, [session(1, { 'IS-2538': 2, 'minigames#9999': 6 })])
    expect(byLine.size).toBe(0)
    expect(other.map(s => s.pid)).toEqual([1])
  })
})
