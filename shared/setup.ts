// Asks for the per-machine values this repo keeps out of git and writes them to untracked files:
// ~/.config/dotfiles/local.json (work log, PR sync, repo folders), ~/.gitconfig.local (git identity)
// and, on Windows, ~/.ssh/config.local (an SSH host). The install scripts run it on first install
// and with --configure (Mac) or -Configure (Windows); `bun ~/dotfiles/shared/setup.ts` runs it directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

type Local = {
  worklog?: {
    root?: string
    github?: { enabled?: boolean; user?: string; org?: string; team?: string }
    tickets?: { url?: string; pattern?: string }
  }
  repoGlobs?: string[]
  [key: string]: unknown
}

const home = homedir()
const isWindows = process.platform === 'win32'
const localPath = join(home, '.config', 'dotfiles', 'local.json')
const gitLocalPath = join(home, '.gitconfig.local')
const sshLocalPath = join(home, '.ssh', 'config.local')

function readLocal(): Local {
  try {
    return JSON.parse(readFileSync(localPath, 'utf8')) as Local
  } catch {
    return {}
  }
}

/** Enter keeps the bracketed value, "-" clears it. */
function ask(question: string, current = ''): string {
  const answer = prompt(`  ${question}${current ? ` [${current}]` : ''}:`)
  if (answer === null || answer.trim() === '') return current
  return answer.trim() === '-' ? '' : answer.trim()
}

// Run from home so a repo's own config can't answer for the global one.
function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: home })
  return result.exitCode === 0 ? result.stdout.toString().trim() : ''
}

function setGitLocal(key: string, value: string): void {
  if (value) git(['config', '--file', gitLocalPath, key, value])
  else git(['config', '--file', gitLocalPath, '--unset', key])
}

function readSshHost(): { alias: string; hostName: string; user: string } {
  const lines = existsSync(sshLocalPath) ? readFileSync(sshLocalPath, 'utf8').split(/\r?\n/) : []
  const value = (key: string) =>
    lines.map(line => line.trim().split(/\s+/)).find(([name]) => name?.toLowerCase() === key.toLowerCase())?.[1] ?? ''
  return { alias: value('Host'), hostName: value('HostName'), user: value('User') }
}

const local = readLocal()
const worklog = local.worklog ?? {}
const github = worklog.github ?? {}
const tickets = worklog.tickets ?? {}

console.log('Dotfiles setup. Enter keeps the value in brackets, "-" clears it.\n')

console.log('Git identity')
const name = ask('Name', git(['config', '--global', '--includes', '--get', 'user.name']))
const email = ask('Email', git(['config', '--global', '--includes', '--get', 'user.email']))

console.log('\nWork log (worklog-dash and the Claude mod)')
const root = ask('Log folder', worklog.root ?? '~/Documents/Work Log')
const prSync = !/^n/i.test(ask('Show your open PRs and review requests from gh (y/n)', github.enabled === false ? 'n' : 'y'))
const ghUser = prSync ? ask("gh account to use (blank: whichever is active)", github.user ?? '') : (github.user ?? '')
const ghOrg = prSync ? ask('Only search this GitHub org (blank: all of GitHub)', github.org ?? '') : (github.org ?? '')
const ghTeam = prSync && ghOrg ? ask("Also count this team's review requests as yours (blank: none)", github.team ?? '') : (github.team ?? '')
const ticketLink = ask('Ticket links: a URL with {id} where the ticket ID goes (blank: off)', tickets.url ?? '')
const ticketPattern = ticketLink
  ? ask('Ticket ID regex (blank: uppercase keys such as ABC-123)', tickets.pattern ?? '')
  : (tickets.pattern ?? '')

console.log('\nDashboard file tree')
const globs = ask('Repo folders for the picker, comma separated, * allowed (such as ~/code/*)', (local.repoGlobs ?? []).join(', '))

let ssh = readSshHost()
if (isWindows) {
  console.log('\nSSH host (~/.ssh/config.local)')
  const alias = ask('Alias (blank skips)', ssh.alias || 'pi')
  ssh = alias
    ? { alias, hostName: ask('HostName (address)', ssh.hostName), user: ask('User', ssh.user) }
    : { alias: '', hostName: '', user: '' }
}

const next: Local = {
  ...local,
  worklog: {
    root,
    github: { enabled: prSync, user: ghUser, org: ghOrg, team: ghTeam },
    tickets: { url: ticketLink, pattern: ticketPattern },
  },
  repoGlobs: globs
    .split(',')
    .map(glob => glob.trim())
    .filter(Boolean),
}
mkdirSync(dirname(localPath), { recursive: true })
writeFileSync(localPath, `${JSON.stringify(next, null, 2)}\n`)
console.log(`\nwrote   ${localPath}`)

setGitLocal('user.name', name)
setGitLocal('user.email', email)
console.log(`wrote   ${gitLocalPath}`)

if (isWindows && ssh.alias && ssh.hostName) {
  const block = [`Host ${ssh.alias}`, `    HostName ${ssh.hostName}`, ...(ssh.user ? [`    User ${ssh.user}`] : []), '    IdentityFile ~/.ssh/id_ed25519', '']
  mkdirSync(dirname(sshLocalPath), { recursive: true })
  writeFileSync(sshLocalPath, block.join('\n'))
  console.log(`wrote   ${sshLocalPath}`)
}

if (ticketLink && !ticketLink.includes('{id}')) console.log('note    ticket links stay off until the URL has {id} in it')
