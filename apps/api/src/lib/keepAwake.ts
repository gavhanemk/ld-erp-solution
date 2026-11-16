import { logger } from '../utils/logger'

/**
 * Keeps the API from being put to sleep between users.
 *
 * On Render's free plan a web service that goes 15 minutes without a request is
 * stopped, and the next person to open a page waits about a minute while it
 * starts again — the screen just says "Loading…" until it is back. Calling our
 * own public address every 10 minutes goes out through Render's front door like
 * any visitor, so the service is never left quiet long enough to be stopped.
 * Render's own health checks do not count; they never leave its network.
 *
 * Runs only where there is a public address to call: Render sets
 * RENDER_EXTERNAL_URL on every web service, and KEEP_AWAKE_URL can name another.
 * On a paid instance, which never sleeps, KEEP_AWAKE=off turns it off.
 */
export function keepAwake(everyMs = 10 * 60 * 1000) {
  const base = process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL
  if (!base || process.env.KEEP_AWAKE === 'off') return

  const url = `${base.replace(/\/+$/, '')}/health`
  const timer = setInterval(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) logger.warn(`Keep-awake: ${url} answered ${res.status}`)
    } catch (err) {
      logger.warn(`Keep-awake: ${url} did not answer — ${(err as Error).message}`)
    }
  }, everyMs)
  // Never the reason the process stays up on shutdown.
  timer.unref()
  logger.info(`Keep-awake: calling ${url} every ${Math.round(everyMs / 60000)} minutes`)
}
