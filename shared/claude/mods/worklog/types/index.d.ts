export type PlanItem = {
  line: number
  raw: string
  section: string
  depth: number
  text: string
  isCheckbox: boolean
  isDone: boolean
  /** Link label to its URL, for each markdown link the line held. */
  links: Record<string, string>
}

export type LogEvent = {
  ts: string
  source: string
  kind: string
  text: string
  ticket: string | null
  pr: string | null
}

/** Links ticket IDs found in branches, commits and PR titles; any tracker with a per-ticket URL. */
export type TicketConfig = {
  /** The ticket page, with {id} where the ID goes. */
  url: string
  /** Regex source for an ID; by default uppercase keys such as ABC-123. */
  pattern: string
  flags: string
}

/** The worklog part of ~/.config/dotfiles/local.json, with defaults applied. */
export type WorklogConfig = {
  root: string
  /**
   * PR sync, or null when turned off. A null user means gh's active account; a null org searches
   * every repo; the team (only with an org) adds that team's review requests.
   */
  github: { user: string | null; org: string | null; team: string | null } | null
  tickets: TicketConfig | null
}

export type Today = {
  date: string
  path: string
  hasFile: boolean
  items: PlanItem[]
  events: LogEvent[]
}

declare module 'claude-code' {
  interface PluginState {
    worklog: { summary: string | null }
  }
}
