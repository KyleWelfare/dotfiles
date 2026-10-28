import { describe, expect, test } from 'bun:test'

import type { PlanItem } from '@worklog-types'

import { type LiveSession, matchSessions } from './sessions.ts'

const row = (line: number, depth: number, labels: string[], text = ''): PlanItem => ({
  line,
  raw: '',
  section: 'Plan',
  depth,
  text,
  isCheckbox: true,
  isDone: false,
  links: Object.fromEntries(labels.map(label => [label, `https://x/${label}`])),
})

const session = (pid: number, mentions: Record<string, number>, title: string | null = null): LiveSession => ({
  name: `s${pid}`,
  pid,
  state: 'idle',
  since: '0m',
  leftPct: 50,
  title,
  paneId: null,
  isThis: false,
  mentions: Object.entries(mentions).map(([ref, count]) => ({ ref, count })),
})

const plan = [
  row(1, 0, ['IS-2804'], 'Self-review the Vault Breakers ingestion drafts'),
  row(2, 1, ['minigames#2309']),
  row(3, 1, ['minigames#2310']),
  row(4, 0, ['IS-2538'], 'Port the Vault Breakers UI improvements from the branch'),
]

describe('matchSessions', () => {
  test('a session spread over several sub-items goes on the parent', () => {
    const { byLine } = matchSessions(plan, [session(1, { 'minigames#2309': 6, 'minigames#2310': 6, 'IS-2804': 3 })])
    expect(byLine.get(1)?.map(s => s.pid)).toEqual([1])
  })

  test('a session mostly on one sub-item goes on it, matched without case or by a bare #number', () => {
    const { byLine } = matchSessions(plan, [session(1, { 'MINIGAMES#2310': 4, '#2310': 4, 'IS-2804': 1 })])
    expect(byLine.get(3)?.map(s => s.pid)).toEqual([1])
  })

  test('a session that names many items, none of them mostly, stays unmatched', () => {
    const { other } = matchSessions(plan, [
      session(1, { 'IS-2804': 9, 'minigames#2309': 3, 'IS-2538': 6, 'IS-2817': 4, 'minigames#2314': 4, 'IS-2666': 4 }),
    ])
    expect(other.map(s => s.pid)).toEqual([1])
  })

  test('a title that matches an item puts the session there, whatever it mentions', () => {
    const { byLine } = matchSessions(plan, [session(1, { 'IS-2812': 9, 'IS-2538': 2 }, 'Porting vault breakers UI improvements')])
    expect(byLine.get(4)?.map(s => s.pid)).toEqual([1])
  })

  test('a title sharing only a word or two with an item does not match', () => {
    const { other } = matchSessions(plan, [session(1, {}, 'Vault Breakers game design requests')])
    expect(other.map(s => s.pid)).toEqual([1])
  })

  test('a few mentions are not enough, however dominant', () => {
    const { other } = matchSessions(plan, [session(1, { 'IS-2538': 3 })])
    expect(other.map(s => s.pid)).toEqual([1])
  })
})
