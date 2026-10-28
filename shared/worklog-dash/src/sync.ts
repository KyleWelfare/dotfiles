import { readFile, writeFile } from 'node:fs/promises'

import type { TicketConfig, WorklogConfig } from '@worklog-types'
import type { SearchedPr } from '@worklog/parse.ts'
import {
  droppedReviews,
  mergeReviews,
  newReviews,
  parsePlan,
  prLabel,
  prState,
  replaceSection,
  rowPr,
  tickMerged,
  ticketFrom,
} from '@worklog/parse.ts'

import { appendEvent, loadDay } from './log.ts'

const PR_WINDOW_DAYS = 30
const FAILING_CHECKS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT'])

export type ReviewPr = SearchedPr & {
  author: { login: string }
  isDraft: boolean
  repository: { name: string; nameWithOwner: string }
  updatedAt: string
}
type MyPr = SearchedPr & { isDraft: boolean; repository: { name: string; nameWithOwner: string } }
type MergedPr = SearchedPr & { repository: { name: string; nameWithOwner: string } }
type CheckRun = { conclusion?: string | null; state?: string | null }
type GhResult<T> = { value: T } | { error: string }
type GithubConfig = NonNullable<WorklogConfig['github']>

/** `reviews` is every current review request, or null when either search failed. */
export type SyncResult = { error: string | null; requested: ReviewPr[]; reviews: ReviewPr[] | null }

export async function run(argv: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(argv, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

// PR titles and logins come from other people and end up drawn in the terminal and written to the log, so
// control characters (escape sequences, newlines) are dropped from every string gh returns.
const stripControl = (_key: string, value: unknown) =>
  typeof value === 'string' ? value.replace(/[\t\n\r]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '') : value

export async function ghText(args: string[], env: Record<string, string>): Promise<string | null> {
  try {
    const { exitCode, stdout } = await run(['gh', ...args], env)
    return exitCode === 0 ? stdout.trim() : null
  } catch {
    return null
  }
}

async function ghJson<T>(args: string[], env: Record<string, string>): Promise<GhResult<T>> {
  try {
    const { exitCode, stdout, stderr } = await run(['gh', ...args], env)
    if (exitCode !== 0) return { error: stderr.trim().split('\n')[0] || `gh exited ${exitCode}` }
    return { value: JSON.parse(stdout, stripControl) as T }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Direct requests plus the team's, deduped by URL, minus drafts and my own PRs. Fails if either
 * search does: rewriting Reviews from half the results would drop rows and re-notify them on the next sync.
 */
function mergeRequests(direct: GhResult<ReviewPr[]>, team: GhResult<ReviewPr[]>, user: string): GhResult<ReviewPr[]> {
  if ('error' in direct) return direct
  if ('error' in team) return team
  const fromDirect = direct.value.filter(pr => !pr.isDraft)
  const seen = new Set(fromDirect.map(pr => pr.url))
  const fromTeam = team.value.filter(pr => !pr.isDraft && pr.author.login !== user && !seen.has(pr.url))
  return { value: [...fromDirect, ...fromTeam] }
}

async function myPrRow(pr: MyPr, env: Record<string, string>): Promise<string> {
  const result = await ghJson<{ reviewDecision: string | null; statusCheckRollup: CheckRun[] | null }>(
    ['pr', 'view', String(pr.number), '--repo', pr.repository.nameWithOwner, '--json', 'reviewDecision,statusCheckRollup'],
    env,
  )
  const view = 'value' in result ? result.value : null
  const failingChecks = (view?.statusCheckRollup ?? []).filter(
    check => FAILING_CHECKS.has(check.conclusion ?? '') || FAILING_CHECKS.has(check.state ?? ''),
  ).length
  const state = prState({ isDraft: pr.isDraft, reviewDecision: view?.reviewDecision, failingChecks })
  return `- [${prLabel(pr)}](${pr.url}) ${pr.title} - ${state}`
}

export function notify(title: string, body: string): void {
  if (process.platform === 'win32') {
    // OSC 777, which WezTerm shows as a toast; it draws nothing, so Ink's frame is untouched.
    process.stdout.write(`\u001b]777;notify;${title};${body.replace(/[;\u0007\u001b]/g, ' ')}\u001b\\`)
    return
  }
  const quote = (text: string) => JSON.stringify(text)
  Bun.spawn(['osascript', '-e', `display notification ${quote(body)} with title ${quote(title)}`], { stdout: 'ignore', stderr: 'ignore' })
}

/** The env for gh calls: the configured account's token, null when gh has no login for it, or {} for the active one. */
export async function githubEnv(github: GithubConfig): Promise<Record<string, string> | null> {
  if (!github.user) return {}
  const token = await ghText(['auth', 'token', '--user', github.user], {})
  return token === null ? null : { GH_TOKEN: token }
}

// A merged PR stays merged, so each is looked up once per dashboard run.
const mergedUrls = new Set<string>()

/** A PR's state (OPEN, MERGED, CLOSED) and who has reviewed it, or null when gh failed. */
async function prOutcome(url: string, env: Record<string, string>): Promise<{ state: string; reviewers: string[] } | null> {
  const tsv = await ghText(['pr', 'view', url, '--json', 'state,latestReviews', '--jq', '[.state, ([.latestReviews[].author.login] | join(","))] | @tsv'], env)
  if (tsv === null) return null
  const [state = '', reviewers = ''] = tsv.split('\t')
  return { state, reviewers: reviewers.split(',').filter(Boolean) }
}

/**
 * Rewrites the Reviews and My open PRs sections of the day's log from gh; a section whose search fails
 * is left as it was. Each review request the log did not list
 * yet raises a desktop notification and a `review` event. With an account configured, every search runs
 * with that account's token: another active gh account may see none of its PRs and get [] with no error,
 * which would blank both sections, so without a login for that account it writes nothing.
 *
 * It also does /sync-day's mechanical part: ticks Plan rows that are a PR once it merges (and parents whose
 * sub-items are all ticked), keeps a Reviews row ticked once you reviewed it or it merged or closed, and logs your
 * PRs merged today that no `done` event covers yet. Jira moves and judgement calls stay with /sync-day.
 */
export async function syncPrs(path: string, date: string, github: GithubConfig, tickets: TicketConfig | null): Promise<SyncResult> {
  const env = await githubEnv(github)
  if (env === null) return { error: `gh has no login for ${github.user}`, requested: [], reviews: null }
  const since = new Date(Date.parse(`${date}T12:00:00Z`) - PR_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const owner = github.org ? ['--owner', github.org] : []
  const search = ['search', 'prs', '--state', 'open', ...owner, '--updated', `>=${since}`, '--json']
  const teamSearch =
    github.org && github.team
      ? ghJson<ReviewPr[]>([...search, 'number,title,url,author,repository,isDraft,updatedAt', `team-review-requested:${github.org}/${github.team}`], env)
      : Promise.resolve({ value: [] })
  // The team search can return your own PRs, and a dropped review row is finished when you reviewed it.
  const login = github.user ?? (await ghText(['api', 'user', '--jq', '.login'], env)) ?? ''

  const [direct, team, mine, mergedToday] = await Promise.all([
    ghJson<ReviewPr[]>([...search, 'number,title,url,author,repository,isDraft,updatedAt', '--review-requested', '@me'], env),
    teamSearch,
    ghJson<MyPr[]>([...search, 'number,title,url,repository,isDraft', '--author', '@me'], env),
    ghJson<MergedPr[]>(['search', 'prs', ...owner, '--author', '@me', '--merged-at', `>=${date}`, '--json', 'number,title,url,repository'], env),
  ])
  const reviews = mergeRequests(direct, team, login)
  const myRows = 'value' in mine ? await Promise.all(mine.value.map(pr => myPrRow(pr, env))) : null

  // The plan's open PR rows and the review rows the search dropped, looked up before the log is re-read.
  const before = await readFile(path, 'utf8')
  const planPrs = parsePlan(before)
    .filter(item => item.isCheckbox && !item.isDone && (item.section === 'Plan' || item.section === 'Nice to have'))
    .map(rowPr)
    .filter((url): url is string => url !== null && !mergedUrls.has(url))
  const dropped = 'value' in reviews ? droppedReviews(before, reviews.value) : []
  const finished = new Set<string>()
  await Promise.all(
    [...new Set([...planPrs, ...dropped])].map(async url => {
      const outcome = await prOutcome(url, env)
      if (outcome === null) return
      if (outcome.state === 'MERGED') mergedUrls.add(url)
      const isMine = outcome.reviewers.some(reviewer => reviewer.toLowerCase() === login.toLowerCase())
      if (outcome.state !== 'OPEN' || isMine) finished.add(url)
    }),
  )

  // Read after the gh calls so a box ticked while they ran is not lost. Plan ticks go first: they keep line numbers,
  // and rewriting the later sections doesn't.
  let markdown = await readFile(path, 'utf8')
  const plan = tickMerged(markdown, url => mergedUrls.has(url))
  markdown = plan.markdown
  const requested = 'value' in reviews ? newReviews(markdown, reviews.value) : []
  if ('value' in reviews) markdown = replaceSection(markdown, 'Reviews', mergeReviews(markdown, reviews.value, finished))
  if (myRows !== null) markdown = replaceSection(markdown, 'My open PRs', myRows)
  await writeFile(path, markdown)

  if ('value' in mergedToday) {
    const logged = new Set((await loadDay(date)).events.filter(event => event.kind === 'done' && event.pr).map(event => event.pr))
    for (const pr of mergedToday.value.filter(pr => !logged.has(pr.url))) {
      await appendEvent({ kind: 'done', text: `Merged ${prLabel(pr)} ${pr.title}`, ticket: ticketFrom(pr.title, tickets), pr: pr.url })
    }
  }
  if (plan.ticked.length > 0) {
    await appendEvent({ kind: 'note', text: `Ticked: ${plan.ticked.join('; ')}`, ticket: null, pr: null })
  }

  for (const pr of requested) {
    const text = `Review requested: ${prLabel(pr)} ${pr.title} (@${pr.author.login})`
    notify('Review requested', `${prLabel(pr)} ${pr.title} (@${pr.author.login})`)
    await appendEvent({ kind: 'review', text, ticket: ticketFrom(pr.title, tickets), pr: pr.url })
  }

  const error = 'error' in reviews ? reviews.error : 'error' in mine ? mine.error : null
  return { error, requested, reviews: 'value' in reviews ? reviews.value : null }
}
