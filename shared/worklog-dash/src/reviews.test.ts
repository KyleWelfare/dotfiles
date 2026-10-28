import { describe, expect, test } from 'bun:test'

import { countToAddress, isRerequested } from './reviews.ts'

describe('countToAddress', () => {
  test('counts top-level findings under Should address, stopping at the next tier', () => {
    const report = [
      '**Should address**',
      '',
      '1. `a.cs:10` (both) - null on teardown.',
      '   Failure: quit mid-load.',
      '2. `b.cs:4` (Opus) - wrong order.',
      '',
      '**Maybe**',
      '- `c.cs:1` (Fable) - unlikely.',
    ].join('\n')
    expect(countToAddress(report)).toBe(2)
  })

  test('a report without the tier has nothing to address', () => {
    expect(countToAddress('**Maybe**\n- `c.cs:1` - unlikely.')).toBe(0)
    expect(countToAddress('No issues found.')).toBe(0)
  })

  test('an empty report is unknown', () => {
    expect(countToAddress('  \n')).toBeNull()
  })
})

describe('isRerequested', () => {
  const since = '2026-10-28T12:00:00Z'

  test('a request for me or my team after since', () => {
    expect(isRerequested('2026-10-28T13:00:00Z\tKyleProdigy\t', since, 'kyleprodigy', null)).toBe(true)
    expect(isRerequested('2026-10-28T13:00:00Z\t\tgiunity', since, 'KyleProdigy', 'giunity')).toBe(true)
  })

  test('ignores older requests and other reviewers', () => {
    const timeline = ['2026-10-28T11:00:00Z\tKyleProdigy\t', '2026-10-28T13:00:00Z\tsomeoneElse\t', ''].join('\n')
    expect(isRerequested(timeline, since, 'KyleProdigy', 'giunity')).toBe(false)
  })
})
