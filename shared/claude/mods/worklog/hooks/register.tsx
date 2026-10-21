import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LogEvent, WorklogConfig } from '../types'
import { CONFIG_PATH, parseConfig, parsePlan, ticketFrom } from './parse'

// The Atlassian connector's Jira transition, whatever the connector is named; never fires without one.
const TRANSITION_TOOL = /^mcp__.*atlassian.*__transitionJiraIssue$/i
const REFRESH_MS = 30_000
const SUMMARY_EVERY_MS = 10 * 60_000

const SUMMARY_PROMPT =
  'In one plain past-tense sentence, say what work this session accomplished, naming ticket IDs and PR numbers when they appear. ' +
  'No adjectives praising the work, no em dashes. If the session did no real work (only chat, setup or reading), answer exactly SKIP.'

const summary = atom({ plugin: 'worklog', key: 'summary' } as const, null)

type Engine = EngineInterface
type NewEvent = Pick<LogEvent, 'kind' | 'text' | 'ticket' | 'pr'>

// Windows has neither `date` nor `/bin/sh`, so there the same work goes through Windows PowerShell.
const isWindows = async ($: Engine) => (await $.env.get('OS')) === 'Windows_NT'

// Read on each use, so a rerun of shared/setup.ts applies without reloading the mod.
async function config($: Engine): Promise<WorklogConfig> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const path = `${home}/${CONFIG_PATH}`
  return parseConfig((await $.fs.exists(path)) ? await $.fs.read(path) : '', home)
}

const dayPath = async ($: Engine, date: string) => {
  const { root } = await config($)
  return `${root}/${date.slice(0, 4)}/${date.slice(0, 7)}/${date}.md`
}
const eventsPath = async ($: Engine, date: string) => `${(await config($)).root}/.events/${date}.jsonl`

// The hooks environment's clock may not carry the machine's timezone, so local time comes from the OS.
async function localNow($: Engine): Promise<{ date: string; ts: string }> {
  const argv = (await isWindows($))
    ? ['powershell.exe', '-NoProfile', '-Command', "(Get-Date -Format 'yyyy-MM-dd yyyy-MM-ddTHH:mm:sszzz') -replace ':(\\d\\d)$', '$1'"]
    : ['date', '+%Y-%m-%d %Y-%m-%dT%H:%M:%S%z']
  const { stdout } = await $.process.run(argv)
  const [date = '', ts = ''] = stdout.trim().split(' ')
  return { date, ts }
}

/** Today's plan progress in the status line; the log itself is drawn by the worklog-dash pane in WezTerm. */
async function refreshStatus($: Engine): Promise<void> {
  const { date } = await localNow($)
  const path = await dayPath($, date)
  if (!(await $.fs.exists(path))) {
    $.ui.status('today: no plan')
    return
  }
  const top = parsePlan(await $.fs.read(path)).filter(item => item.section === 'Plan' && item.depth === 0)
  $.ui.status(`today ${top.filter(item => item.isDone).length}/${top.length}`)
}

// Appended through the shell so concurrent sessions and /log never overwrite each other's lines.
async function appendEvent($: Engine, event: NewEvent): Promise<void> {
  const { date, ts } = await localNow($)
  const line = JSON.stringify({ ts, source: 'hook', ...event })
  const path = await eventsPath($, date)
  if (await isWindows($)) {
    // Through the environment: arguments to -Command are rejoined as script text, which mangles quotes in the line.
    await $.process.run(
      [
        'powershell.exe',
        '-NoProfile',
        '-Command',
        '[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($env:WORKLOG_EVENTS)) | Out-Null; ' +
          '[IO.File]::AppendAllText($env:WORKLOG_EVENTS, $env:WORKLOG_LINE + "`n")',
      ],
      { env: { WORKLOG_EVENTS: path, WORKLOG_LINE: line } },
    )
  } else {
    await $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s\\n" "$1" >> "$2"', 'sh', line, path])
  }
  await refreshStatus($)
}

async function prTitle($: Engine, url: string): Promise<string | null> {
  const { exitCode, stdout } = await $.process.run(['gh', 'pr', 'view', url, '--json', 'title', '--jq', '.title'])
  return exitCode === 0 ? stdout.trim() : null
}

async function commitSubject($: Engine, sha: string): Promise<string | null> {
  const { exitCode, stdout } = await $.process.run(['git', 'log', '-1', '--format=%s', sha], {
    cwd: await $.session.cwd(),
  })
  return exitCode === 0 ? stdout.trim() : null
}

// The slice of the Bash tool's `gitOperation` result this mod reads.
type GitOperation = {
  commit?: { sha: string; branch?: string }
  pr?: { number: number; url?: string; action: string }
}

async function logGitOperation($: Engine, op: GitOperation): Promise<void> {
  const { tickets } = await config($)
  if (op.commit) {
    const subject = await commitSubject($, op.commit.sha)
    const branch = op.commit.branch ?? 'detached'
    await appendEvent($, {
      kind: 'progress',
      text: `Committed "${subject ?? op.commit.sha.slice(0, 7)}" on ${branch}`,
      ticket: ticketFrom(branch, tickets) ?? ticketFrom(subject ?? '', tickets),
      pr: null,
    })
  }

  const pr = op.pr
  if (!pr || !pr.url) return
  const verbs: Record<string, [string, string]> = {
    created: ['progress', 'Opened'],
    ready: ['progress', 'Marked ready for review'],
    merged: ['done', 'Merged'],
  }
  const verb = verbs[pr.action]
  if (!verb) return
  const title = await prTitle($, pr.url)
  await appendEvent($, {
    kind: verb[0],
    text: `${verb[1]} PR #${pr.number}${title ? ` ${title}` : ''}`,
    ticket: ticketFrom(title ?? '', tickets),
    pr: pr.url,
  })
}

export const register: Register = on => {
  let toolsThisTurn = 0
  let lastSummaryAt = 0

  on('session.start', async ($, e, next) => {
    await refreshStatus($).catch(() => undefined)
    $.clock.every(REFRESH_MS, () => {
      void refreshStatus($).catch(() => undefined)
    })
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const op = (ran.result as { gitOperation?: GitOperation } | undefined)?.gitOperation
    if (op) await logGitOperation($, op).catch(() => undefined)
    return ran
  })

  on('tool.call', { tool: TRANSITION_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const key = String((e as { issueIdOrKey?: unknown }).issueIdOrKey ?? '')
      const status = /"statusName":"([^"]+)"/.exec(ran.text ?? '')?.[1]?.replace(/\*/g, '')
      await appendEvent($, {
        kind: 'progress',
        text: `Moved ${key} to ${status ?? 'a new status'}`,
        ticket: ticketFrom(key, (await config($)).tickets),
        pr: null,
      }).catch(() => undefined)
    }
    return ran
  })

  on('tool.call', ($, e, next) => {
    toolsThisTurn += 1
    return next(e)
  })

  // session.end only gets a short bound, so the summary is kept fresh here and merely written at the end.
  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const isWorkingTurn = toolsThisTurn > 0 && e.agentId === undefined
    toolsThisTurn = 0
    if (isWorkingTurn && now - lastSummaryAt > SUMMARY_EVERY_MS) {
      lastSummaryAt = now
      $.clock.after(0, () => {
        void $.model.fork({ prompt: SUMMARY_PROMPT }).then(async answer => {
          if (!answer.isAnswered) return
          const text = answer.text.trim()
          await update($, summary, () => (text === 'SKIP' ? null : text))
        })
      })
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const text = await read($, summary)
    if (text) {
      const { tickets } = await config($)
      await appendEvent($, { kind: 'session', text, ticket: ticketFrom(text, tickets), pr: null }).catch(() => undefined)
    }
    return next(e)
  })
}
