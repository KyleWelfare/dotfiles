import { mkdirSync, watch } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { useApp, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { toggleLine } from '@worklog/parse.ts'

import { CONFIG, type Day, ROOT, loadDay, localDate } from './log.ts'
import {
  REVIEW_BOT,
  type ReviewEntry,
  STATE_DIR,
  isAutoReview,
  loadReviews,
  openSession,
  queueReview,
  reconcileReviews,
  setAutoReview,
  tickReviews,
} from './reviews.ts'
import { type LiveSession, loadSessions, matchSessions } from './sessions.ts'
import { syncPrs } from './sync.ts'
import { Dashboard, type SyncState, selectable } from './view.tsx'

const RELOAD_MS = 30_000
// Each sync is 2 searches plus a view per open PR; GitHub's search API allows about 30 a minute.
const SYNC_MS = 5 * 60_000

const clock = () => new Date().toTimeString().slice(0, 5)

export function App() {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [day, setDay] = useState<Day | null>(null)
  const [reviews, setReviews] = useState<Record<string, ReviewEntry>>({})
  const [autoReview, setAutoReviewState] = useState(true)
  const [live, setLive] = useState<LiveSession[]>([])
  const [cursor, setCursor] = useState(0)
  const [sync, setSync] = useState<SyncState>({ isOff: CONFIG.github === null, isRunning: false, lastAt: null, error: null })
  const isSyncing = useRef(false)

  const reload = useCallback(async () => {
    setDay(await loadDay())
    void loadSessions().then(setLive)
    if (REVIEW_BOT !== null) {
      setReviews(await loadReviews())
      setAutoReviewState(await isAutoReview())
    }
  }, [])

  const runSync = useCallback(async () => {
    const github = CONFIG.github
    if (github === null || isSyncing.current) return
    const current = await loadDay()
    if (!current.hasFile) return
    isSyncing.current = true
    setSync(state => ({ ...state, isRunning: true }))
    try {
      const { error, reviews: requested } = await syncPrs(current.path, current.date, github, CONFIG.tickets)
      setSync({ isOff: false, isRunning: false, lastAt: clock(), error })
      if (requested !== null) await reconcileReviews(requested, github)
    } catch (error) {
      setSync(state => ({ ...state, isRunning: false, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      isSyncing.current = false
      await reload()
    }
  }, [reload])

  useEffect(() => {
    void reload().then(runSync)
    const reloadTimer = setInterval(() => {
      if (CONFIG.github !== null) void tickReviews(CONFIG.github)
      void reload()
    }, RELOAD_MS)
    const syncTimer = setInterval(() => void runSync(), SYNC_MS)
    // Watch the folders, not the files: today's file may not exist yet, and editors replace files on save.
    let debounce: ReturnType<typeof setTimeout> | undefined
    const onChange = () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => void reload(), 150)
    }
    const date = localDate()
    const watchers = [
      watch(dirname(`${ROOT}/${date.slice(0, 4)}/${date.slice(0, 7)}/x`), onChange),
      watch(`${ROOT}/.events`, onChange),
    ]
    if (REVIEW_BOT !== null) {
      mkdirSync(STATE_DIR, { recursive: true })
      watchers.push(watch(STATE_DIR, onChange))
    }
    return () => {
      clearInterval(reloadTimer)
      clearInterval(syncTimer)
      clearTimeout(debounce)
      for (const watcher of watchers) watcher.close()
    }
  }, [reload, runSync])

  const rowsToWalk = day ? selectable(day) : []
  const selected = rowsToWalk[Math.min(cursor, rowsToWalk.length - 1)]

  useInput((input, key) => {
    if (input === 'q') exit()
    else if (key.downArrow || input === 'j') setCursor(index => Math.min(index + 1, rowsToWalk.length - 1))
    else if (key.upArrow || input === 'k') setCursor(index => Math.max(index - 1, 0))
    else if (input === 's') void runSync()
    else if (input === 'r') void reload()
    else if (input === 'o' && selected) {
      const href = Object.values(selected.links)[0]
      const review = href ? reviews[href] : undefined
      if (review?.status === 'ready' && CONFIG.github !== null && openSession(review, CONFIG.github)) return
      if (href) Bun.spawn(process.platform === 'win32' ? ['explorer.exe', href] : ['open', href])
    } else if (input === 'a' && REVIEW_BOT !== null) {
      void setAutoReview(!autoReview).then(reload)
    } else if (input === 'v' && selected?.section === 'Reviews' && CONFIG.github !== null) {
      const href = Object.values(selected.links)[0]
      if (href) void queueReview(href, CONFIG.github).then(reload)
    } else if ((input === ' ' || input === 'x') && selected && day) {
      void (async () => {
        const markdown = await readFile(day.path, 'utf8')
        const next = toggleLine(markdown, selected.line, selected.raw)
        if (next !== null) await writeFile(day.path, next)
        await reload()
      })()
    }
  })

  if (day === null) return null
  const { byLine } = matchSessions(day.items, live)
  return <Dashboard day={day} width={columns} height={rows} cursorLine={selected?.line ?? null} sync={sync} reviews={reviews} autoReview={autoReview} sessions={byLine} />
}
