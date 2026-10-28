import { render, renderToString } from 'ink'

import { App } from './src/app.tsx'
import { loadDay } from './src/log.ts'
import { isAutoReview, loadReviews } from './src/reviews.ts'
import { Dashboard } from './src/view.tsx'

// `--once [columns]` prints one frame of today's log and exits, for checking the layout without a TTY.
const onceAt = process.argv.indexOf('--once')
if (onceAt >= 0) {
  const columns = Number(process.argv[onceAt + 1] ?? 160) || 160
  const day = await loadDay()
  const sync = { isOff: false, isRunning: false, lastAt: null, error: null }
  console.log(renderToString(<Dashboard day={day} width={columns} height={20} cursorLine={null} sync={sync} reviews={await loadReviews()} autoReview={await isAutoReview()} />, { columns }))
  process.exit(0)
}

// The alternate screen keeps the pane a fixed canvas, so redraws never scroll it.
process.stdout.write('\u001b[?1049h\u001b[?25l')
const restore = () => process.stdout.write('\u001b[?25h\u001b[?1049l')
process.on('exit', restore)

const app = render(<App />, { exitOnCtrlC: true })
await app.waitUntilExit()
process.exit(0)
