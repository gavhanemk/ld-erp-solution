import { useCallback, useEffect, useState } from 'react'
import { ApiError } from './api'

/**
 * One screen's worth of data, with the four states every screen owes the user:
 * loading, empty, error, loaded. See docs/02-design-rules.md — a screen missing
 * one of them is not finished.
 *
 * `waking` is separate from `loading` on purpose. The free hosting plan puts
 * the server to sleep, and the first request of the day can sit for the better
 * part of a minute. A spinner that long reads as a crash, so once a request has
 * been running a few seconds the screen is told to explain itself instead.
 */

const WAKING_AFTER_MS = 4000

export function useFetch<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [waking, setWaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fetcher, deps)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const slow = setTimeout(() => setWaking(true), WAKING_AFTER_MS)

    try {
      setData(await run())
    } catch (err) {
      // The API writes its messages for a mill clerk, so they are shown as
      // sent. Only an unrecognised failure needs wording of our own.
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      clearTimeout(slow)
      setWaking(false)
      setLoading(false)
    }
  }, [run])

  useEffect(() => {
    void load()
  }, [load])

  return { data, loading, waking, error, reload: load }
}
