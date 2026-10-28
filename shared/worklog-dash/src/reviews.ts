import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { WorklogConfig } from '@worklog-types'
import { CONFIG_PATH, prLabel, ticketFrom } from '@worklog/parse.ts'

import { CONFIG, appendEvent } from './log.ts'
import type { RunJob, RunResult } from './review-run.ts'
import { type ReviewPr, ghText, githubEnv, notify, run } from './sync.ts'

type GithubConfig = NonNullable<WorklogConfig['github']>

const HOME = homedir()
export const STATE_DIR = join(HOME, '.local/state/worklog-dash/reviews')
const INDEX_PATH = join(STATE_DIR, 'index.json')
const LOCK_PATH = join(STATE_DIR, 'lock')
const SETTINGS_PATH = join(STATE_DIR, 'settings.json')
const NAMES_PATH = join(STATE_DIR, 'names.json')
const RUNS_DIR = join(STATE_DIR, 'runs')
const CACHE_DIR = join(HOME, '.cache/worklog-dash')
const CLONES_DIR = join(CACHE_DIR, 'repos')
export const WORKTREES_DIR = join(CACHE_DIR, 'wt')
const RUNNER = new URL('./review-run.ts', import.meta.url).pathname
const CLAUDE = Bun.which('claude') ?? join(HOME, '.local/bin/claude')
const WEZTERM = ['/Applications/WezTerm.app/Contents/MacOS/wezterm', Bun.which('wezterm')].find(
  (path): path is string => path !== null && existsSync(path),
)

// A review gets three runs before it stays failed; `v` resets the count.
const MAX_ATTEMPTS = 3
// Search results flap and a review you just submitted drops the request while you may still be in the session,
// so a PR's worktree outlives its request by this long.
const GONE_GRACE_MS = 2 * 3_600_000
const DEFAULT_SPARSE_EXCLUDE = ['*.prefab', '*.anim', '*.unity', '*.asset']

export type ReviewBotConfig = {
  maxParallel: number
  timeoutMinutes: number
  /** A read-only GitHub token for the review runs; without one they use the PR sync's account. */
  tokenFile: string | null
  model: string
  /** Patterns left out of every worktree; the reviewers read those files with `git show`. */
  sparseExclude: string[]
}

export type ReviewStatus = 'idle' | 'queued' | 'reviewing' | 'ready' | 'failed'

export type ReviewerState = 'approved' | 'changes' | 'commented'
export type Reviewer = { name: string; state: ReviewerState }

export type ReviewEntry = {
  url: string
  repo: string
  number: number
  label: string
  title: string
  status: ReviewStatus
  attempts: number
  /** The headless session's ID, set when a run starts; resuming it opens the review. */
  sessionId: string | null
  pid: number | null
  startedAt: string | null
  finishedAt: string | null
  /** The head the report covers, and the latest head seen since; they differ once the report is stale. */
  sha: string | null
  head: string | null
  commitsSince: number | null
  /** Findings in the report's "Should address" tier, or null when the report couldn't be read. */
  toAddress: number | null
  error: string | null
  /** A review request newer than this queues the PR again. */
  requestedSince: string
  /** The PR's updatedAt when it was last checked for new commits and re-requests. */
  updatedAt: string
  goneAt: string | null
  /** Everyone else's latest review state, by first name; absent until the first sync that fetched them. */
  reviewers?: Reviewer[]
  /** The PR's updatedAt that `reviewers` reflects. */
  reviewersAt?: string
}

type Index = Record<string, ReviewEntry>

function parseReviewBot(json: string): ReviewBotConfig | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const bot = (raw as { worklog?: { reviewBot?: Record<string, unknown> } } | null)?.worklog?.reviewBot
  if (!bot || bot.enabled !== true) return null
  const positive = (value: unknown, fallback: number) => (typeof value === 'number' && value > 0 ? value : fallback)
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const tokenFile = text(bot.tokenFile)
  return {
    maxParallel: positive(bot.maxParallel, 3),
    timeoutMinutes: positive(bot.timeoutMinutes, 45),
    tokenFile: tokenFile ? tokenFile.replace(/^~(?=$|\/)/, HOME) : null,
    model: text(bot.model) || 'opus',
    sparseExclude: Array.isArray(bot.sparseExclude)
      ? bot.sparseExclude.filter((pattern): pattern is string => typeof pattern === 'string' && pattern !== '')
      : DEFAULT_SPARSE_EXCLUDE,
  }
}

// Mac only: the runner, the WezTerm handoff and the notifications assume it.
export const REVIEW_BOT =
  process.platform === 'darwin' && CONFIG.github !== null
    ? parseReviewBot(await readFile(join(HOME, CONFIG_PATH), 'utf8').catch(() => ''))
    : null

export const slugOf = (entry: Pick<ReviewEntry, 'repo' | 'number'>) => `${entry.repo.replace('/', '-')}-${entry.number}`
export const worktreeOf = (entry: Pick<ReviewEntry, 'repo' | 'number'>) => join(WORKTREES_DIR, slugOf(entry))
const runPath = (entry: ReviewEntry, ext: 'json' | 'md' | 'log') => join(RUNS_DIR, `${slugOf(entry)}.${ext}`)

/** The link a ready row carries; wezterm.lua's open-uri handler resumes the session in a new tab. */
export const resumeUrl = (entry: ReviewEntry) =>
  `prreview://resume?session=${entry.sessionId}&cwd=${encodeURIComponent(worktreeOf(entry))}&title=${encodeURIComponent(entry.label)}`

export const isStale = (entry: ReviewEntry) => entry.sha !== null && entry.head !== null && entry.head !== entry.sha

export async function loadReviews(): Promise<Index> {
  try {
    return JSON.parse(await readFile(INDEX_PATH, 'utf8')) as Index
  } catch {
    return {}
  }
}

async function saveIndex(index: Index): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  const temp = `${INDEX_PATH}.${process.pid}`
  await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`)
  await rename(temp, INDEX_PATH)
}

/** Whether `pid` is still the process it was: after a reboot the number may belong to something unrelated. */
function isRunning(pid: number, script: string): boolean {
  const ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)])
  return ps.exitCode === 0 && ps.stdout.toString().includes(script)
}

let hasLock = false

/**
 * Only one dashboard runs reviews: each dash tab runs this app, and two of them would start every review twice.
 * The others only show the index. A lock whose dashboard is gone (a closed pane skips exit handlers) is taken over.
 */
async function holdLock(): Promise<boolean> {
  if (hasLock) return true
  await mkdir(STATE_DIR, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(LOCK_PATH, String(process.pid), { flag: 'wx' })
      hasLock = true
      process.on('exit', () => {
        try {
          unlinkSync(LOCK_PATH)
        } catch {
          // Already gone.
        }
      })
      return true
    } catch {
      const owner = Number(await readFile(LOCK_PATH, 'utf8').catch(() => ''))
      if (owner > 0 && isRunning(owner, 'index.tsx')) return false
      await unlink(LOCK_PATH).catch(() => undefined)
    }
  }
  return false
}

// The sync, the 30-second tick and `v` all read, change and write the whole index, so they take turns.
let turn: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = turn.then(task)
  turn = next.catch(() => undefined)
  return next
}

/** The number of findings under the report's "Should address" tier; the skill leaves out empty tiers. */
export function countToAddress(report: string): number | null {
  if (report.trim() === '') return null
  const lines = report.split('\n')
  const start = lines.findIndex(line => /should address/i.test(line))
  if (start < 0) return 0
  let count = 0
  for (const line of lines.slice(start + 1)) {
    if (/^\W*(maybe|not worth addressing)\b/i.test(line)) break
    if (/^(\d+[.)]|[-*])\s+\S/.test(line)) count += 1
  }
  return count
}

/** Whether the timeline's review requests (`created_at\tlogin\tteam slug` lines) include one for me since `since`. */
export function isRerequested(timeline: string, since: string, login: string, team: string | null): boolean {
  return timeline
    .split('\n')
    .map(line => line.split('\t'))
    .some(
      ([at = '', reviewer = '', slug = '']) =>
        Date.parse(at) > Date.parse(since) &&
        ((login !== '' && reviewer.toLowerCase() === login.toLowerCase()) || (team !== null && slug === team)),
    )
}

const TIMELINE_JQ =
  '.[] | select(.event == "review_requested") | [.created_at, (.requested_reviewer.login // ""), (.requested_team.slug // "")] | @tsv'

let login: string | null = null

/**
 * Each other reviewer's latest state from `login\tSTATE` lines in review order. A comment after an approval or a
 * change request doesn't undo it; pending and dismissed reviews, bots and `me` are left out.
 */
export function latestReviewStates(lines: string, me: string): Array<{ login: string; state: ReviewerState }> {
  const states = new Map<string, ReviewerState>()
  for (const line of lines.split('\n')) {
    const [reviewer = '', raw = ''] = line.split('\t')
    if (reviewer === '' || reviewer.endsWith('[bot]') || reviewer.toLowerCase() === me.toLowerCase()) continue
    const state = raw === 'APPROVED' ? 'approved' : raw === 'CHANGES_REQUESTED' ? 'changes' : raw === 'COMMENTED' ? 'commented' : null
    if (state === null || (state === 'commented' && states.has(reviewer))) continue
    states.set(reviewer, state)
  }
  return [...states].map(([reviewer, state]) => ({ login: reviewer, state }))
}

let names: Record<string, string> | null = null

/** A login's first name from its GitHub profile, cached on disk; the login itself when the profile has no name. */
async function firstName(reviewer: string, env: Record<string, string>): Promise<string> {
  names ??= await readFile(NAMES_PATH, 'utf8')
    .then(text => JSON.parse(text) as Record<string, string>)
    .catch(() => ({}))
  const cached = names[reviewer]
  if (cached !== undefined) return cached
  const name = await ghText(['api', `users/${reviewer}`, '--jq', '.name // ""'], env)
  if (name === null) return reviewer
  const first = name.trim().split(/\s+/)[0] || reviewer
  names[reviewer] = first
  await writeFile(NAMES_PATH, `${JSON.stringify(names, null, 2)}\n`).catch(() => undefined)
  return first
}

async function refreshReviewers(entry: ReviewEntry, pr: ReviewPr, env: Record<string, string>, me: string): Promise<void> {
  const lines = await ghText(
    ['api', '--paginate', `repos/${entry.repo}/pulls/${entry.number}/reviews?per_page=100`, '--jq', '.[] | [.user.login, .state] | @tsv'],
    env,
  )
  if (lines === null) return
  const states = latestReviewStates(lines, me)
  entry.reviewers = await Promise.all(states.map(async ({ login: reviewer, state }) => ({ name: await firstName(reviewer, env), state })))
  entry.reviewersAt = pr.updatedAt
}

/** Picks up new commits (the report goes stale, never re-run) and re-requests (queued again) on a PR that changed. */
async function refresh(
  entry: ReviewEntry,
  pr: ReviewPr,
  github: GithubConfig,
  env: Record<string, string>,
  { auto, me }: { auto: boolean; me: string },
): Promise<void> {
  // A request made mid-run would be older than the run's requestedSince, so these wait until it ends.
  if (entry.status === 'queued' || entry.status === 'reviewing') return
  if (entry.sha !== null) {
    const head = await ghText(['api', `repos/${entry.repo}/pulls/${entry.number}`, '--jq', '.head.sha'], env)
    if (head === null) return
    if (head !== entry.head) {
      entry.head = head
      // A force push can leave the reviewed commit unreachable from the new head; then the count is unknown.
      const ahead =
        head === entry.sha ? '0' : await ghText(['api', `repos/${entry.repo}/compare/${entry.sha}...${head}`, '--jq', '.ahead_by'], env)
      entry.commitsSince = ahead !== null && /^\d+$/.test(ahead) ? Number(ahead) : null
    }
  }
  const timeline = await ghText(
    ['api', '--paginate', `repos/${entry.repo}/issues/${entry.number}/timeline?per_page=100`, '--jq', TIMELINE_JQ],
    env,
  )
  if (timeline === null) return
  if (isRerequested(timeline, entry.requestedSince, me, github.team)) {
    entry.status = auto ? 'queued' : 'idle'
    entry.attempts = 0
    // Moved past this request, so switching back to auto doesn't review what arrived while in manual.
    entry.requestedSince = new Date().toISOString()
  }
  entry.updatedAt = pr.updatedAt
}

function newEntry(pr: ReviewPr, status: ReviewStatus, now: string): ReviewEntry {
  return {
    url: pr.url,
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    label: prLabel(pr),
    title: pr.title,
    status,
    attempts: 0,
    sessionId: null,
    pid: null,
    startedAt: null,
    finishedAt: null,
    sha: null,
    head: null,
    commitsSince: null,
    toAddress: null,
    error: null,
    requestedSince: now,
    updatedAt: pr.updatedAt,
    goneAt: null,
  }
}

async function reviewToken(github: GithubConfig): Promise<string | null> {
  if (REVIEW_BOT?.tokenFile) return (await readFile(REVIEW_BOT.tokenFile, 'utf8').catch(() => '')).trim() || null
  const env = await githubEnv(github)
  return env === null ? null : (env.GH_TOKEN ?? (await ghText(['auth', 'token'], {})))
}

/** Starts the entry's runner; false when it couldn't. */
async function start(entry: ReviewEntry, github: GithubConfig): Promise<boolean> {
  const bot = REVIEW_BOT
  if (bot === null) return false
  const token = await reviewToken(github)
  if (token === null) {
    entry.attempts = MAX_ATTEMPTS
    fail(entry, bot.tokenFile ? `no token in ${bot.tokenFile}` : `gh has no login for ${github.user ?? 'the active account'}`)
    return false
  }
  const now = new Date().toISOString()
  Object.assign(entry, {
    status: 'reviewing',
    sessionId: randomUUID(),
    attempts: entry.attempts + 1,
    startedAt: now,
    finishedAt: null,
    requestedSince: now,
    error: null,
  })
  await mkdir(RUNS_DIR, { recursive: true })
  await rm(runPath(entry, 'json'), { force: true })
  const job: RunJob = {
    url: entry.url,
    repo: entry.repo,
    number: entry.number,
    label: entry.label,
    sessionId: entry.sessionId ?? '',
    clone: join(CLONES_DIR, entry.repo),
    worktree: worktreeOf(entry),
    report: runPath(entry, 'md'),
    result: runPath(entry, 'json'),
    claude: CLAUDE,
    model: bot.model,
    sparseExclude: bot.sparseExclude,
    ghUser: github.user,
  }
  const log = openSync(runPath(entry, 'log'), 'w')
  try {
    // Detached in its own process group, so it outlives the dashboard and a timeout can stop it and its claude.
    const child = spawn(process.execPath, [RUNNER, JSON.stringify(job)], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, GH_TOKEN: token },
    })
    child.on('error', () => undefined)
    child.unref()
    entry.pid = child.pid ?? null
  } finally {
    closeSync(log)
  }
  return true
}

function stop(entry: ReviewEntry): void {
  if (entry.pid === null || !isRunning(entry.pid, RUNNER)) return
  try {
    process.kill(-entry.pid, 'SIGTERM')
  } catch {
    // Exited meanwhile.
  }
}

function fail(entry: ReviewEntry, message: string): void {
  entry.pid = null
  entry.error = message
  if (entry.attempts < MAX_ATTEMPTS) {
    entry.status = 'queued'
    return
  }
  entry.status = 'failed'
  notify('Review failed', `${entry.label}: ${message}`)
}

async function finish(entry: ReviewEntry, result: RunResult): Promise<void> {
  const report = await readFile(runPath(entry, 'md'), 'utf8').catch(() => '')
  Object.assign(entry, {
    status: 'ready',
    pid: null,
    error: null,
    finishedAt: new Date().toISOString(),
    sha: result.sha,
    head: result.sha,
    commitsSince: 0,
    toAddress: countToAddress(report),
  })
  const summary = entry.toAddress === null ? '' : entry.toAddress === 0 ? ' · nothing to address' : ` · ${entry.toAddress} to address`
  notify('Review ready', `${entry.label} ${entry.title}${summary}`)
  await appendEvent({
    kind: 'review-ready',
    text: `Review ready: ${entry.label} ${entry.title}${summary}`,
    ticket: ticketFrom(entry.title, CONFIG.tickets),
    pr: entry.url,
  })
}

async function check(entry: ReviewEntry): Promise<void> {
  const result = await readFile(runPath(entry, 'json'), 'utf8')
    .then(text => JSON.parse(text) as RunResult)
    .catch(() => null)
  if (result !== null && result.sessionId === entry.sessionId) {
    if (result.ok) await finish(entry, result)
    else fail(entry, result.error ?? 'the review failed')
    return
  }
  if (entry.pid === null || !isRunning(entry.pid, RUNNER)) {
    fail(entry, 'the runner exited without a result')
    return
  }
  const minutes = REVIEW_BOT?.timeoutMinutes ?? 45
  if (Date.now() - Date.parse(entry.startedAt ?? '') > minutes * 60_000) {
    stop(entry)
    fail(entry, `timed out after ${minutes} minutes`)
  }
}

/** Settles finished and stuck runs, then starts queued ones up to the parallel limit. */
async function step(index: Index, github: GithubConfig): Promise<void> {
  const entries = Object.values(index)
  for (const entry of entries) if (entry.status === 'reviewing') await check(entry)
  let running = entries.filter(entry => entry.status === 'reviewing').length
  for (const entry of entries) {
    if (running >= (REVIEW_BOT?.maxParallel ?? 0)) break
    if (entry.status !== 'queued' || entry.goneAt !== null) continue
    if (await start(entry, github)) running += 1
  }
}

/** Deletes a worktree by path, then prunes its clone's record of it; `git worktree remove` would time out on minigames. */
async function removeWorktree(path: string): Promise<void> {
  if (!path.startsWith(`${WORKTREES_DIR}/`)) return
  const gitFile = await readFile(join(path, '.git'), 'utf8').catch(() => '')
  const clone = /^gitdir: (.+)\/\.git\/worktrees\/[^/]+$/.exec(gitFile.trim())?.[1]
  await rm(path, { recursive: true, force: true })
  if (clone) await run(['git', '-C', clone, 'worktree', 'prune'])
}

async function discard(entry: ReviewEntry): Promise<void> {
  stop(entry)
  await removeWorktree(worktreeOf(entry))
  await Promise.all((['json', 'md', 'log'] as const).map(ext => rm(runPath(entry, ext), { force: true })))
}

/** Worktrees no entry owns, left by a crash or a deleted index. */
async function sweepWorktrees(index: Index): Promise<void> {
  const owned = new Set(Object.values(index).map(slugOf))
  const names = await readdir(WORKTREES_DIR).catch(() => [] as string[])
  for (const name of names) if (!owned.has(name)) await removeWorktree(join(WORKTREES_DIR, name))
}

/**
 * Brings the index in line with a successful review-request search. New requests are queued; on the first run the
 * ones already waiting are listed as idle instead, so turning the bot on doesn't review the whole backlog at once.
 * A PR the search stopped returning is dropped, with its worktree and report, once the grace period passes.
 */
export function reconcileReviews(requested: ReviewPr[], github: GithubConfig): Promise<void> {
  return serial(async () => {
    if (REVIEW_BOT === null || !(await holdLock())) return
    const isFirstRun = !existsSync(INDEX_PATH)
    const auto = await isAutoReview()
    const index = await loadReviews()
    const now = new Date().toISOString()
    const env = await githubEnv(github)
    if (env !== null) login ??= github.user ?? (await ghText(['api', 'user', '--jq', '.login'], env))
    const me = login ?? ''
    for (const pr of requested) {
      const existing = index[pr.url]
      const entry = existing ?? newEntry(pr, isFirstRun || !auto ? 'idle' : 'queued', now)
      index[pr.url] = entry
      entry.title = pr.title
      entry.goneAt = null
      if (env === null) continue
      if (existing !== undefined && pr.updatedAt !== entry.updatedAt) await refresh(entry, pr, github, env, { auto, me })
      if (pr.updatedAt !== entry.reviewersAt) await refreshReviewers(entry, pr, env, me)
    }
    const urls = new Set(requested.map(pr => pr.url))
    for (const entry of Object.values(index)) {
      if (urls.has(entry.url)) continue
      entry.goneAt ??= now
      if (Date.now() - Date.parse(entry.goneAt) > GONE_GRACE_MS) {
        await discard(entry)
        delete index[entry.url]
      }
    }
    await sweepWorktrees(index)
    await step(index, github)
    await saveIndex(index)
  })
}

/** Runs between syncs so a finished review shows up within the dashboard's 30-second reload. */
export function tickReviews(github: GithubConfig): Promise<void> {
  return serial(async () => {
    if (REVIEW_BOT === null || !(await holdLock())) return
    const index = await loadReviews()
    if (!Object.values(index).some(entry => entry.status === 'reviewing' || entry.status === 'queued')) return
    await step(index, github)
    await saveIndex(index)
  })
}

/** Whether new requests and re-requests are reviewed on their own; off, they're listed idle for `v`. On by default. */
export async function isAutoReview(): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(SETTINGS_PATH, 'utf8')) as { auto?: unknown }).auto !== false
  } catch {
    return true
  }
}

/**
 * `a`: switches between auto and manual for every dashboard. Going manual sends anything waiting to start back to
 * idle; reviews already running finish.
 */
export function setAutoReview(auto: boolean): Promise<void> {
  return serial(async () => {
    await mkdir(STATE_DIR, { recursive: true })
    const temp = `${SETTINGS_PATH}.${process.pid}`
    await writeFile(temp, `${JSON.stringify({ auto })}\n`)
    await rename(temp, SETTINGS_PATH)
    if (auto || !(await holdLock())) return
    const index = await loadReviews()
    for (const entry of Object.values(index)) if (entry.status === 'queued') entry.status = 'idle'
    await saveIndex(index)
  })
}

/** `v` on a Reviews row: review it now, whatever its state, unless a run is already queued or going. */
export function queueReview(url: string, github: GithubConfig): Promise<boolean> {
  return serial(async () => {
    if (REVIEW_BOT === null || !(await holdLock())) return false
    const index = await loadReviews()
    const entry = index[url]
    if (entry === undefined || entry.status === 'queued' || entry.status === 'reviewing') return false
    entry.status = 'queued'
    entry.attempts = 0
    await step(index, github)
    await saveIndex(index)
    return true
  })
}

/** Resumes a ready review's session in a new WezTerm tab, in its worktree, with the PR sync's gh account. */
export function openSession(entry: ReviewEntry, github: GithubConfig): boolean {
  if (WEZTERM === undefined || entry.sessionId === null || !existsSync(worktreeOf(entry))) return false
  const token = github.user && /^[\w-]+$/.test(github.user) ? `GH_TOKEN=$(gh auth token --user ${github.user}) ` : ''
  void (async () => {
    const proc = Bun.spawn(
      [WEZTERM, 'cli', 'spawn', '--cwd', worktreeOf(entry), '--', '/bin/zsh', '-lc', `${token}claude --resume ${entry.sessionId}`],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const pane = (await new Response(proc.stdout).text()).trim()
    if (/^\d+$/.test(pane)) Bun.spawn([WEZTERM, 'cli', 'set-tab-title', '--pane-id', pane, `review: ${entry.label}`], { stderr: 'ignore' })
  })()
  return true
}
