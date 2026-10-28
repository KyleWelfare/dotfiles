import { watch } from 'node:fs'

import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useState } from 'react'

import { type Day, ROOT, loadDay } from './log.ts'
import { type LiveSession, activateSession, loadSessions, matchSessions } from './sessions.ts'
import { Recent, SessionMark } from './view.tsx'

const RELOAD_MS = 30_000

const C = { text: '#cdd6f4', muted: '#7f849c', cursor: '#45475a' }

type Props = { day: Day; other: LiveSession[]; width: number; height: number; cursor: number | null }

/**
 * The dashboard's left pane: live sessions that match no plan item on top (the ones that do are marked on the plan
 * itself), and the latest log events below, each in half the height.
 */
export function Side({ day, other, width, height, cursor }: Props) {
  const half = Math.max(3, Math.floor(height / 2))
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" paddingX={1}>
      <Box flexDirection="column" height={half} overflow="hidden">
        <Text bold color={C.text}>
          Other sessions
        </Text>
        {other.length === 0 && <Text color={C.muted}>none</Text>}
        {other.map((session, index) => (
          <Text key={session.pid} wrap="truncate-end" backgroundColor={index === cursor ? C.cursor : undefined}>
            <SessionMark session={session} /> <Text color={C.text}>{session.title ?? session.name}</Text>
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Text bold color={C.text}>
          Recent
        </Text>
        <Recent events={day.events} count={Math.max(1, height - half - 1)} />
      </Box>
    </Box>
  )
}

export function SideApp() {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [day, setDay] = useState<Day | null>(null)
  const [other, setOther] = useState<LiveSession[]>([])
  const [cursor, setCursor] = useState(0)

  const reload = useCallback(async () => {
    const next = await loadDay()
    setDay(next)
    setOther(matchSessions(next.items, await loadSessions()).other)
  }, [])

  useEffect(() => {
    void reload()
    const timer = setInterval(() => void reload(), RELOAD_MS)
    let debounce: ReturnType<typeof setTimeout> | undefined
    const watcher = watch(`${ROOT}/.events`, () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => void reload(), 150)
    })
    return () => {
      clearInterval(timer)
      clearTimeout(debounce)
      watcher.close()
    }
  }, [reload])

  useInput((input, key) => {
    if (input === 'q') exit()
    else if (key.downArrow || input === 'j') setCursor(index => Math.min(index + 1, other.length - 1))
    else if (key.upArrow || input === 'k') setCursor(index => Math.max(index - 1, 0))
    else if (input === 'r') void reload()
    else if (input === 'o' || key.return) {
      const session = other[cursor]
      if (session) activateSession(session)
    }
  })

  if (day === null) return null
  return <Side day={day} other={other} width={columns} height={rows} cursor={other.length > 0 ? cursor : null} />
}
