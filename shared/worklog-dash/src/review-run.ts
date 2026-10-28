// Reviews one PR for the dashboard, which starts it detached (src/reviews.ts) so it outlives the dashboard: brings
// the PR head into the dashboard's own clone of the repo, points the PR's worktree at it, runs /review headless with
// read-only tools, and writes the result file the dashboard polls for. GH_TOKEN comes from the environment.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type RunJob = {
  url: string
  repo: string
  number: number
  label: string
  sessionId: string
  clone: string
  worktree: string
  report: string
  result: string
  claude: string
  model: string
  sparseExclude: string[]
  ghUser: string | null
}

export type RunResult = { sessionId: string; ok: boolean; sha: string | null; error: string | null }

// dontAsk denies everything not allowed here. The user's and the repo's settings still add their own allow rules,
// so writes they allow are denied explicitly, and `gh api` only reads: a field or method flag makes it a write.
const GH_API_WRITE_FLAGS = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']
export const PERMISSIONS = {
  allow: [
    'Skill(review)',
    'Agent',
    'Read',
    'Grep',
    'Glob',
    'Bash(gh pr view:*)',
    'Bash(gh pr diff:*)',
    'Bash(gh pr checks:*)',
    'Bash(gh api:*)',
    ...['log', 'show', 'diff', 'grep', 'blame', 'rev-parse', 'status', 'worktree list'].map(command => `Bash(git ${command}:*)`),
    'Bash(rg:*)',
    'Bash(ls:*)',
    'Bash(wc:*)',
  ],
  deny: [
    'Edit',
    'Write',
    'NotebookEdit',
    'WebFetch',
    'WebSearch',
    'mcp__claude_ai_Atlassian_MCP',
    'Bash(gh api graphql:*)',
    ...GH_API_WRITE_FLAGS.flatMap(flag => [`Bash(gh api ${flag}*)`, `Bash(gh api * ${flag}*)`]),
    // The PR's own code: its tests and tooling never run here.
    'Bash(npm:*)',
    'Bash(npx:*)',
    'Bash(bun:*)',
    'Bash(node:*)',
    'Bash(ucp:*)',
  ],
}

const job = JSON.parse(process.argv[2] ?? '{}') as RunJob

// The token from the environment, falling back to the PR sync's gh account so git in a resumed session (no GH_TOKEN)
// can still fetch the blobs a sparse, blobless worktree leaves out.
const fallbackToken = job.ghUser && /^[\w-]+$/.test(job.ghUser) ? `$(gh auth token --user ${job.ghUser})` : '$(gh auth token)'
const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=\${GH_TOKEN:-${fallbackToken}}"; }; f`
const GIT_ENV = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' }

const log = (message: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${message}`)

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`, ...args], {
    env: GIT_ENV,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const command = args[0] === '-C' ? args[2] : args[0]
  if (exitCode !== 0) throw new Error(`git ${command} failed: ${stderr.trim().split('\n').at(-1) ?? ''}`)
  return stdout.trim()
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Two new PRs on one repo start two runners, and git can't clone or fetch into one repo twice at once. */
async function withCloneLock<T>(task: () => Promise<T>): Promise<T> {
  const lock = `${job.clone}.lock`
  await mkdir(dirname(lock), { recursive: true })
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch {
      const owner = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => ''))
      // No pid yet is a runner between mkdir and writing it, unless that was long enough ago to be a crash.
      const isStale = owner > 0 ? !isAlive(owner) : Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? 0) > 60_000
      if (isStale) await rm(lock, { recursive: true, force: true })
      else await Bun.sleep(2_000)
    }
  }
  await writeFile(join(lock, 'pid'), String(process.pid))
  try {
    return await task()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function prepare(): Promise<string> {
  const sha = await withCloneLock(async () => {
    if (!existsSync(join(job.clone, '.git'))) {
      log(`cloning ${job.repo}`)
      await rm(job.clone, { recursive: true, force: true })
      // Blobless: history and trees now, file contents only as a checkout or `git show` needs them.
      await git(['clone', '--filter=blob:none', '--no-checkout', '--no-tags', `https://github.com/${job.repo}.git`, job.clone])
      await git(['-C', job.clone, 'config', '--add', 'credential.helper', ''])
      await git(['-C', job.clone, 'config', '--add', 'credential.helper', CREDENTIAL_HELPER])
    }
    log(`fetching ${job.label}`)
    await git(['-C', job.clone, 'fetch', '--no-tags', 'origin', `+refs/pull/${job.number}/head:refs/pr/${job.number}`])
    const head = await git(['-C', job.clone, 'rev-parse', `refs/pr/${job.number}`])
    if (!existsSync(join(job.worktree, '.git'))) {
      await rm(job.worktree, { recursive: true, force: true })
      await git(['-C', job.clone, 'worktree', 'prune'])
      await git(['-C', job.clone, 'worktree', 'add', '--no-checkout', '--detach', job.worktree, head])
    }
    return head
  })
  if (job.sparseExclude.length > 0) {
    await git(['-C', job.worktree, 'sparse-checkout', 'set', '--no-cone', '/*', ...job.sparseExclude.map(pattern => `!${pattern}`)])
  }
  log(`checking out ${sha.slice(0, 7)}`)
  await git(['-C', job.worktree, 'reset', '--hard', '--quiet', sha])
  return sha
}

function systemPrompt(sha: string): string {
  const sparse =
    job.sparseExclude.length > 0
      ? ` It is a sparse checkout without ${job.sparseExclude.join(', ')}; read those with \`git show HEAD:<path>\`.`
      : ''
  return (
    `You are running unattended for the user's worklog dashboard. The PR head ${sha} is checked out, detached, at ` +
    `${job.worktree}, the working directory; give the reviewer that path.${sparse} Nothing you do may change the PR ` +
    'or anything else: no comments, reviews, pushes, edits or ticket changes. Your final message is saved as the ' +
    'report the user reads later, and they resume this session to decide what to post.'
  )
}

async function review(sha: string): Promise<void> {
  log(`reviewing ${job.url}`)
  const out = openSync(job.report, 'w')
  const settings = { permissions: PERMISSIONS, disableAllHooks: true }
  const args = [
    '-p',
    `/review ${job.url}`,
    '--session-id',
    job.sessionId,
    '--name',
    `review ${job.label}`,
    '--model',
    job.model,
    '--permission-mode',
    'dontAsk',
    '--settings',
    JSON.stringify(settings),
    '--append-system-prompt',
    systemPrompt(sha),
  ]
  const exitCode = await new Promise<number>(resolve => {
    const child = spawn(job.claude, args, { cwd: job.worktree, stdio: ['ignore', out, 'inherit'], env: process.env })
    child.on('exit', code => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
  closeSync(out)
  if (exitCode !== 0) throw new Error(`claude exited ${exitCode}`)
  if (statSync(job.report).size === 0) throw new Error('the review produced no report')
}

async function writeResult(result: RunResult): Promise<void> {
  const temp = `${job.result}.tmp`
  await writeFile(temp, JSON.stringify(result))
  await rename(temp, job.result)
}

if (import.meta.main) {
  try {
    const sha = await prepare()
    await review(sha)
    await writeResult({ sessionId: job.sessionId, ok: true, sha, error: null })
    log('done')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(message)
    await writeResult({ sessionId: job.sessionId, ok: false, sha: null, error: message })
  }
}
