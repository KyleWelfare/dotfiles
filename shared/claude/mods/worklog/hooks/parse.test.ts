import { describe, expect, test } from 'claude-code/testing'

import {
  droppedReviews,
  mergeReviews,
  newReviews,
  parseConfig,
  parseEvents,
  parsePlan,
  prLabel,
  prState,
  replaceSection,
  splitPr,
  splitRefs,
  ticketFrom,
  tickMerged,
  ticketUrl,
  toggleLine,
} from './parse'

const TICKETS = { url: 'https://tracker/browse/{id}', pattern: 'ABC-\\d+', flags: 'i' }

const DOC = [
  '---',
  'date: 2026-01-05',
  '---',
  '',
  '## Plan',
  '- [ ] Standardize ([ABC-12](https://x/ABC-12))',
  '\t- [x] Autoplay ([ABC-34](https://x/ABC-34), [PR #27](https://x/27))',
  '',
  '## My open PRs',
  '- [app#19](https://x/19) Add a settings page - awaiting review',
  '',
  '## Wrap-up',
  '- not tracked here',
].join('\n')

describe('parsePlan', () => {
  test('reads tracked sections only, with depth, state and links stripped', async () => {
    const [first, second, pr, ...rest] = parsePlan(DOC)
    expect(rest.length).toBe(0)
    expect(pr?.section).toBe('My open PRs')
    expect(pr?.isCheckbox).toBe(false)
    expect(pr?.text).toBe('app#19 Add a settings page - awaiting review')
    expect(first?.text).toBe('Standardize (ABC-12)')
    expect(first?.isDone).toBe(false)
    expect(second?.depth).toBe(1)
    expect(second?.isDone).toBe(true)
    expect(second?.text).toBe('Autoplay (ABC-34, PR #27)')
    expect(second?.links).toEqual({ 'ABC-34': 'https://x/ABC-34', 'PR #27': 'https://x/27' })
    expect(pr?.links).toEqual({ 'app#19': 'https://x/19' })
  })
})

describe('toggleLine', () => {
  test('flips the box and keeps the rest of the line', async () => {
    const [first] = parsePlan(DOC)
    if (!first) throw new Error('no plan item parsed')
    const next = toggleLine(DOC, first.line, first.raw)
    expect(next?.split('\n')[first.line]).toBe('- [x] Standardize ([ABC-12](https://x/ABC-12))')
  })

  test('refuses when the line changed since it was drawn', async () => {
    const [first] = parsePlan(DOC)
    if (!first) throw new Error('no plan item parsed')
    expect(toggleLine(DOC, first.line, '- [ ] something else')).toBe(null)
  })
})

describe('parseConfig', () => {
  test('defaults to your own PRs through the active gh account, and no ticket links', async () => {
    const defaults = { root: '/home/me/Documents/Work Log', github: { user: null, org: null, team: null }, tickets: null }
    expect(parseConfig('', '/home/me')).toEqual(defaults)
    expect(parseConfig('{not json', '/home/me')).toEqual(defaults)
  })

  test('expands ~, turns sync off when disabled and drops a team without an org', async () => {
    const off = parseConfig(JSON.stringify({ worklog: { root: '~/notes/log', github: { enabled: false } } }), '/home/me')
    expect(off.root).toBe('/home/me/notes/log')
    expect(off.github).toBe(null)
    expect(parseConfig(JSON.stringify({ worklog: { github: { team: 'core' } } }), '/home/me').github).toEqual({ user: null, org: null, team: null })
  })

  test('keeps ticket links only with an {id} URL and a valid pattern', async () => {
    const tickets = (value: unknown) => parseConfig(JSON.stringify({ worklog: { tickets: value } }), '/home/me').tickets
    expect(tickets({ url: 'https://tracker/browse/{id}' })).toEqual({ url: 'https://tracker/browse/{id}', pattern: '[A-Z][A-Z0-9]+-\\d+', flags: '' })
    expect(tickets({ url: 'https://tracker/browse/{id}', pattern: 'ABC-\\d+' })?.flags).toBe('i')
    expect(tickets({ url: 'https://tracker/browse/' })).toBe(null)
    expect(tickets({ url: 'https://tracker/{id}', pattern: '(' })).toBe(null)
  })
})

describe('parseEvents and ticketFrom', () => {
  test('skips a half-written line', async () => {
    const events = parseEvents('{"ts":"t","source":"log","kind":"note","text":"a","ticket":null,"pr":null}\n{"ts":')
    expect(events.length).toBe(1)
  })

  test('finds nothing while ticket links are off', async () => {
    expect(ticketFrom('feat/ABC-34-autoplay', null)).toBe(null)
  })

  test('pulls a custom-pattern ID from a branch name in any case, and links it', async () => {
    expect(ticketFrom('feat/abc-34-autoplay', TICKETS)).toBe('ABC-34')
    expect(ticketFrom('main', TICKETS)).toBe(null)
    expect(ticketUrl(TICKETS, 'ABC-34')).toBe('https://tracker/browse/ABC-34')
  })

  test('the default pattern takes uppercase keys and skips lowercase words', async () => {
    const tickets = { ...TICKETS, pattern: '[A-Z][A-Z0-9]+-\\d+', flags: '' }
    expect(ticketFrom('task/XYZ-7--bump-0.7.1', tickets)).toBe('XYZ-7')
    expect(ticketFrom('fix/node-18-upgrade', tickets)).toBe(null)
  })
})

describe('splitRefs and splitPr', () => {
  test('pulls a trailing list of links and PR numbers off a plan item', async () => {
    const links = { 'ABC-34': 'https://x/ABC-34', Spec: 'https://x/spec' }
    expect(splitRefs('Autoplay baseline (ABC-34, Spec, PR #27)', links)).toEqual({ title: 'Autoplay baseline', refs: 'ABC-34 · Spec · PR #27' })
    expect(splitRefs('Polish (and rename) the menu', links)).toEqual({ title: 'Polish (and rename) the menu', refs: '' })
  })

  test('splits a PR line and drops a leading [tag]', async () => {
    expect(splitPr('#18 [ABC-56] Rotate-your-device overlay - approved')).toEqual({
      number: '#18',
      title: 'Rotate-your-device overlay',
      state: 'approved',
    })
    expect(splitPr('web#27 Autoplay baseline - draft').title).toBe('Autoplay baseline')
  })
})

const LOG = [
  '## Plan',
  '- [ ] Thing',
  '',
  '## Reviews',
  '- [x] [app#1](https://x/1) Done and gone - @a',
  '- [x] [app#2](https://x/2) Done, still requested - @b',
  '- [ ] [app#3](https://x/3) Dropped - @c',
  '',
  '## Wrap-up',
  '(written by /wrap-day)',
].join('\n')

const pr = (number: number, repo = 'app') => ({
  number,
  title: `PR ${number}`,
  url: `https://x/${number}`,
  repository: { name: repo },
  author: { login: 'dev' },
})

describe('PR section sync', () => {
  test('labels each PR with its repo', async () => {
    expect(prLabel(pr(29, 'web'))).toBe('web#29')
    expect(prLabel(pr(19))).toBe('app#19')
  })

  test('picks one state, draft and CI first', async () => {
    expect(prState({ isDraft: true, reviewDecision: 'APPROVED', failingChecks: 1 })).toBe('draft')
    expect(prState({ isDraft: false, reviewDecision: 'APPROVED', failingChecks: 1 })).toBe('CI failing')
    expect(prState({ isDraft: false, reviewDecision: 'CHANGES_REQUESTED', failingChecks: 0 })).toBe('changes requested')
    expect(prState({ isDraft: false, reviewDecision: 'APPROVED', failingChecks: 0 })).toBe('approved')
    expect(prState({ isDraft: false, reviewDecision: null, failingChecks: 0 })).toBe('awaiting review')
  })

  test('keeps checked reviews, drops unchecked ones no longer requested', async () => {
    expect(mergeReviews(LOG, [pr(2), pr(4)])).toEqual([
      '- [x] [app#2](https://x/2) PR 2 - @dev',
      '- [ ] [app#4](https://x/4) PR 4 - @dev',
      '- [x] [app#1](https://x/1) Done and gone - @a',
    ])
  })

  test('keeps a dropped unchecked review you finished, checked off', async () => {
    expect(mergeReviews(LOG, [pr(2)], new Set(['https://x/3']))).toEqual([
      '- [x] [app#2](https://x/2) PR 2 - @dev',
      '- [x] [app#1](https://x/1) Done and gone - @a',
      '- [x] [app#3](https://x/3) Dropped - @c',
    ])
  })

  test('droppedReviews lists unchecked rows the search no longer returns', async () => {
    expect(droppedReviews(LOG, [pr(2)])).toEqual(['https://x/3'])
    expect(droppedReviews(LOG, [pr(3)])).toEqual([])
  })

  test('newReviews returns only requests the section does not list, checked or not', async () => {
    expect(newReviews(LOG, [pr(1), pr(2), pr(4)]).map(found => found.number)).toEqual([4])
  })

  test('replaces an existing section and inserts a missing one in template order', async () => {
    const replaced = replaceSection(LOG, 'Reviews', ['- [ ] new'])
    expect(replaced.split('\n').slice(3, 6)).toEqual(['## Reviews', '- [ ] new', ''])
    const inserted = replaceSection(replaced, 'My open PRs', ['- mine'])
    expect(inserted.split('\n').slice(3, 9)).toEqual(['## Reviews', '- [ ] new', '', '## My open PRs', '- mine', ''])
    expect(inserted.split('\n')[9]).toBe('## Wrap-up')
  })

  test('drops a section the search came back empty for', async () => {
    expect(replaceSection(LOG, 'Reviews', [])).toBe(['## Plan', '- [ ] Thing', '', '## Wrap-up', '(written by /wrap-day)'].join('\n'))
    expect(replaceSection(LOG, 'My open PRs', [])).toBe(LOG)
  })
})

describe('tickMerged', () => {
  const PLAN = [
    '## Plan',
    '- [ ] Ship the port ([ABC-1](https://tracker/ABC-1))',
    '\t- [ ] [app#1](https://github.com/o/app/pull/1) Part one',
    '\t- [x] [app#2](https://github.com/o/app/pull/2) Part two',
    '- [ ] Port the UI from [app#3](https://github.com/o/app/pull/3) to here',
    '- [ ] [app#4](https://github.com/o/app/pull/4) Still open',
    '',
  ].join('\n')
  const merged = new Set(['https://github.com/o/app/pull/1', 'https://github.com/o/app/pull/3'])

  test('ticks a merged PR row, then its parent once every sub-item is ticked', async () => {
    const { markdown, ticked } = tickMerged(PLAN, url => merged.has(url))
    expect(ticked).toEqual(['app#1 Part one', 'Ship the port (ABC-1)'])
    expect(markdown.split('\n').slice(1, 3)).toEqual([
      '- [x] Ship the port ([ABC-1](https://tracker/ABC-1))',
      '\t- [x] [app#1](https://github.com/o/app/pull/1) Part one',
    ])
  })

  test('leaves a row that only mentions a merged PR, and open PRs', async () => {
    const { markdown } = tickMerged(PLAN, url => merged.has(url))
    expect(markdown).toContain('- [ ] Port the UI from')
    expect(markdown).toContain('- [ ] [app#4]')
  })
})
