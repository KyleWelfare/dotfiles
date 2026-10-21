import { readFile, writeFile } from 'node:fs/promises'

import type { TicketConfig, WorklogConfig } from '@worklog-types'
import type { SearchedPr } from '@worklog/parse.ts'
import { mergeReviews, newReviews, prLabel, prState, replaceSection, ticketFrom } from '@worklog/parse.ts'

import { appendEvent } from './log.ts'

const PR_WINDOW_DAYS = 30
const FAILING_CHECKS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT'])

type ReviewPr = SearchedPr & { author: { login: string } }
type TeamReviewPr = ReviewPr & { isDraft: boolean }
type MyPr = SearchedPr & { isDraft: boolean; repository: { name: string; nameWithOwner: string } }
type CheckRun = { conclusion?: string | null; state?: string | null }
type GhResult<T> = { value: T } | { error: string }
type GithubConfig = NonNullable<WorklogConfig['github']>

export type SyncResult = { error: string | null; requested: ReviewPr[] }

async function run(argv: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(argv, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function ghText(args: string[], env: Record<string, string>): Promise<string | null> {
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
    return { value: JSON.parse(stdout) as T }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Direct requests plus the team's, deduped by URL, minus team drafts and my own PRs. Fails if either
 * search does: rewriting Reviews from half the results would drop rows and re-notify them on the next sync.
 */
function mergeRequests(direct: GhResult<ReviewPr[]>, team: GhResult<TeamReviewPr[]>, user: string): GhResult<ReviewPr[]> {
  if ('error' in direct) return direct
  if ('error' in team) return team
  const seen = new Set(direct.value.map(pr => pr.url))
  const fromTeam = team.value.filter(pr => !pr.isDraft && pr.author.login !== user && !seen.has(pr.url))
  return { value: [...direct.value, ...fromTeam] }
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

function notify(title: string, body: string): void {
  if (process.platform === 'win32') {
    // OSC 777, which WezTerm shows as a toast; it draws nothing, so Ink's frame is untouched.
    process.stdout.write(`\u001b]777;notify;${title};${body.replace(/[;\u0007\u001b]/g, ' ')}\u001b\\`)
    return
  }
  const quote = (text: string) => JSON.stringify(text)
  Bun.spawn(['osascript', '-e', `display notification ${quote(body)} with title ${quote(title)}`], { stdout: 'ignore', stderr: 'ignore' })
}

/**
 * Rewrites the Reviews and My open PRs sections of the day's log from gh; a section whose search fails
 * is left as it was. Each review request the log did not list
 * yet raises a desktop notification and a `review` event. With an account configured, every search runs
 * with that account's token: another active gh account may see none of its PRs and get [] with no error,
 * which would blank both sections, so without a login for that account it writes nothing.
 */
export async function syncPrs(path: string, date: string, github: GithubConfig, tickets: TicketConfig | null): Promise<SyncResult> {
  let env: Record<string, string> = {}
  if (github.user) {
    const token = await ghText(['auth', 'token', '--user', github.user], {})
    if (token === null) return { error: `gh has no login for ${github.user}`, requested: [] }
    env = { GH_TOKEN: token }
  }
  const since = new Date(Date.parse(`${date}T12:00:00Z`) - PR_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const owner = github.org ? ['--owner', github.org] : []
  const search = ['search', 'prs', '--state', 'open', ...owner, '--updated', `>=${since}`, '--json']
  const teamSearch =
    github.org && github.team
      ? ghJson<TeamReviewPr[]>([...search, 'number,title,url,author,repository,isDraft', `team-review-requested:${github.org}/${github.team}`], env)
      : Promise.resolve({ value: [] })
  // Only the team search can return your own PRs, so the login is looked up only for it.
  const login = github.user ?? (github.team ? ((await ghText(['api', 'user', '--jq', '.login'], env)) ?? '') : '')

  const [direct, team, mine] = await Promise.all([
    ghJson<ReviewPr[]>([...search, 'number,title,url,author,repository', '--review-requested', '@me'], env),
    teamSearch,
    ghJson<MyPr[]>([...search, 'number,title,url,repository,isDraft', '--author', '@me'], env),
  ])
  const reviews = mergeRequests(direct, team, login)
  const myRows = 'value' in mine ? await Promise.all(mine.value.map(pr => myPrRow(pr, env))) : null

  // Read after the gh calls so a box ticked while they ran is not lost.
  let markdown = await readFile(path, 'utf8')
  const requested = 'value' in reviews ? newReviews(markdown, reviews.value) : []
  if ('value' in reviews) markdown = replaceSection(markdown, 'Reviews', mergeReviews(markdown, reviews.value))
  if (myRows !== null) markdown = replaceSection(markdown, 'My open PRs', myRows)
  await writeFile(path, markdown)

  for (const pr of requested) {
    const text = `Review requested: ${prLabel(pr)} ${pr.title} (@${pr.author.login})`
    notify('Review requested', `${prLabel(pr)} ${pr.title} (@${pr.author.login})`)
    await appendEvent({ kind: 'review', text, ticket: ticketFrom(pr.title, tickets), pr: pr.url })
  }

  const error = 'error' in reviews ? reviews.error : 'error' in mine ? mine.error : null
  return { error, requested }
}
