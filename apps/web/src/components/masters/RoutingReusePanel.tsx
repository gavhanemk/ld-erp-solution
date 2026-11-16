'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Copy, X, Loader2, ChevronRight } from 'lucide-react'
import { RoutingPickerDialog } from './RoutingPickerDialog'
import { compareRoutings, type ComparableRouting } from '@ld-erp/shared'
import { api, type Paginated } from '@/lib/api'
import type { Routing, RoutingStep } from './RoutingFormDialog'

type Comparison = ReturnType<typeof compareRoutings>
type Match = { routing: Routing; comparison: Comparison | null; kind: string }
export interface RoutingReuseHandle {
  checkBeforeSave: (proceed: () => void) => Promise<void>
}
interface Props {
  current: ComparableRouting & {
    steps: RoutingStep[]
    style?: { code: string; name: string }
    fabric?: { code: string; name: string }
  }
  revision: string
  excludeId?: string
  source: Routing | null
  editing: boolean
  disabled: boolean
  allowCopy: boolean
  onCopy: (routing: Routing) => void
}
export const RoutingReusePanel = forwardRef<RoutingReuseHandle, Props>(function RoutingReusePanel(
  { current, revision, excludeId, source, editing, disabled, allowCopy, onCopy },
  ref
) {
  const panel = useRef<HTMLElement>(null)
  const [browse, setBrowse] = useState(false)
  const [browseMode, setBrowseMode] = useState<'all' | 'matches'>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [results, setResults] = useState<Routing[]>([])
  const [selected, setSelected] = useState<Routing | null>(null)
  const [compare, setCompare] = useState(false)
  const [matches, setMatches] = useState<Match[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [searching, setSearching] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const pending = useRef<(() => void) | null>(null)
  const reviewed = useRef('')
  const suggestionKey = useRef('')
  const body = {
    styleId: current.styleId,
    category: current.category,
    fabricItemId: current.fabricItemId,
    steps: current.steps
      .filter((s) => s.operationId && s.departmentId)
      .map((s) => ({
        ...s,
        workstationId: s.workstationId || null,
        contractorId: s.contractorId || null,
      })),
    excludeId,
  }
  const fingerprint = JSON.stringify(body)
  const saveFingerprint = fingerprint + revision
  const latest = useRef(saveFingerprint)
  latest.current = saveFingerprint
  const fetchMatches = () =>
    api.post<{ data: Match[] }>('/masters/routings/similar', body).then((r) => r.data)
  useEffect(() => {
    pending.current = null
  }, [saveFingerprint])
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void fetchMatches()
        .then((rows) => {
          if (!live) return
          setMatches(rows)
          const key = rows.map((m) => `${m.routing.id}:${m.kind}`).join('|')
          if (key !== suggestionKey.current) {
            setDismissed(false)
            suggestionKey.current = key
          }
        })
        .catch(() => {})
    }, 650)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [fingerprint]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!browse || browseMode === 'matches') {
      setSearching(false)
      return
    }
    let live = true
    setSearching(true)
    const timer = setTimeout(() => {
      void api
        .get<Paginated<Routing>>(
          `/masters/routings?q=${encodeURIComponent(query)}&page=${page}&limit=6`
        )
        .then((r) => {
          if (live) {
            setResults(r.data)
            setSelected(r.data[0] ?? null)
            setCompare(false)
            setPages(r.pagination.pages)
            setError('')
          }
        })
        .catch(() => {
          if (live) {
            setError('Could not load routings. Try searching again.')
            setResults([])
            setSelected(null)
          }
        })
        .finally(() => {
          if (live) setSearching(false)
        })
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [browse, browseMode, query, page])
  useImperativeHandle(ref, () => ({
    checkBeforeSave: async (proceed) => {
      if (inFlight.current) return
      if (reviewed.current === saveFingerprint) {
        proceed()
        return
      }
      inFlight.current = true
      setChecking(true)
      try {
        const data = await fetchMatches()
        if (latest.current !== saveFingerprint) return
        if (!data.length) {
          reviewed.current = saveFingerprint
          proceed()
          return
        }
        setMatches(data)
        setDismissed(false)
        pending.current = proceed
        panel.current?.parentElement?.scrollTo({ top: 0, behavior: 'smooth' })
      } catch {
        if (latest.current !== saveFingerprint) return
        setError('Similarity check is unavailable. Retry saving or continue with your routing.')
        setDismissed(false)
        pending.current = proceed
        panel.current?.parentElement?.scrollTo({ top: 0, behavior: 'smooth' })
      } finally {
        inFlight.current = false
        setChecking(false)
      }
    },
  }))
  const continueNew = () => {
    setBrowse(false)
    reviewed.current = saveFingerprint
    setDismissed(true)
    setError('')
    const proceed = pending.current
    pending.current = null
    proceed?.()
  }
  const useRouting = (r: Routing) => {
    pending.current = null
    reviewed.current = ''
    setSelected(null)
    setBrowse(false)
    setDismissed(true)
    setError('')
    onCopy(r)
  }
  const openBrowser = () => {
    setBrowseMode('all')
    setBrowse(true)
    setCompare(false)
    setSelected(null)
  }
  const reviewMatches = () => {
    setBrowseMode('matches')
    setSelected(matches[0]?.routing ?? null)
    setCompare(true)
    setBrowse(true)
  }
  return (
    <section ref={panel} className="space-y-2">
      <div className="border-border bg-card flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Copy size={14} className="text-primary shrink-0" />
          {source ? (
            <span className="truncate">
              Copied from <span className="font-medium">{source.code}</span> · v{source.version}
            </span>
          ) : (
            <span className="text-muted-foreground">Reuse a routing to save time.</span>
          )}
        </div>
        <button
          type="button"
          className="btn-secondary h-8 text-xs"
          disabled={disabled || !allowCopy}
          onClick={openBrowser}
        >
          {source ? 'Choose another routing' : 'Create from Existing Routing'}
          <ChevronRight size={14} />
        </button>
      </div>
      {checking && (
        <p role="status" className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
          <Loader2 size={13} className="animate-spin" />
          Checking existing routings…
        </p>
      )}
      {!dismissed && (matches.length > 0 || error) && (
        <div
          role="status"
          className="border-primary/20 bg-primary/5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2"
        >
          <div className="min-w-0 flex-1 text-xs">
            <p className="font-medium">
              {error ||
                (matches.some((m) => m.kind !== 'SUGGESTED')
                  ? 'An existing or similar routing was found!'
                  : `${matches.length} routings suit this target`)}
            </p>
          </div>
          {matches.length > 0 && (
            <button
              type="button"
              className="text-primary text-xs font-semibold hover:underline"
              onClick={reviewMatches}
            >
              Review {matches.length} {matches.length === 1 ? 'match' : 'matches'}
            </button>
          )}
          <button
            type="button"
            className="btn-ghost h-7 px-2 text-xs"
            disabled={disabled || checking}
            onClick={continueNew}
          >
            {editing ? 'Continue with My Changes' : 'Create New Routing'}
          </button>
          <button
            type="button"
            className="text-muted-foreground p-1"
            aria-label="Dismiss routing suggestions"
            onClick={() => {
              pending.current = null
              setDismissed(true)
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {browse && (
        <RoutingPickerDialog
          current={current}
          results={browseMode === 'matches' ? matches.map((m) => m.routing) : results}
          selected={selected}
          onSelect={(r) => {
            setSelected(r)
            setCompare(false)
          }}
          query={query}
          onQuery={(q) => {
            setQuery(q)
            setPage(1)
          }}
          page={page}
          pages={pages}
          onPage={setPage}
          searching={searching}
          error={error}
          compare={compare}
          onCompare={setCompare}
          suggestions={browseMode === 'matches'}
          onBrowse={openBrowser}
          onClose={() => setBrowse(false)}
          onCopy={useRouting}
          disabled={disabled || checking || !allowCopy}
        />
      )}
    </section>
  )
})
