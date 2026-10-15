'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Route, Search } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Pagination } from '@/components/tables/Pagination'
import { useAppSettings } from '@/lib/appSettings'
import { describe, STYLE_STATE, type StyleRow } from './track'

type Filter = '' | 'IN_PROGRESS' | 'NOT_STARTED' | 'DONE' | 'NO_ROUTING'

const FILTERS: Array<{ value: Filter; label: string; count: string }> = [
  { value: '', label: 'All', count: 'ALL' },
  { value: 'IN_PROGRESS', label: 'In progress', count: 'IN_PROGRESS' },
  { value: 'NOT_STARTED', label: 'Not started', count: 'NOT_STARTED' },
  { value: 'DONE', label: 'Done', count: 'DONE' },
  { value: 'NO_ROUTING', label: 'No routing', count: 'NO_ROUTING' },
]

interface ListResponse {
  data: StyleRow[]
  counts: Record<string, number>
  pagination: { total: number; pages: number }
}

/**
 * Every style, with the routing it follows and where it stands on the floor:
 * a coloured dot, the first step not yet done, and how many steps are done.
 * A row opens the style's page.
 */
export function StyleTrackList({ reloadKey, onError }: { reloadKey: number; onError: (m: string | null) => void }) {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<StyleRow[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filter, setFilter] = useState<Filter>('')
  const latest = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [debounced, filter])

  const load = useCallback(async () => {
    const ticket = ++latest.current
    setLoading(true)
    onError(null)
    try {
      const qs = new URLSearchParams({ limit: String(rowsPerPage), page: String(page) })
      if (debounced) qs.set('q', debounced)
      if (filter) qs.set('state', filter)
      const res = await api.get<ListResponse>(`/masters/style-tracking?${qs}`)
      if (ticket !== latest.current) return
      setRows(res.data)
      setCounts(res.counts)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket !== latest.current) return
      onError(err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?')
      setRows([])
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
    // onError is the page's setter; a new reloadKey is how the page asks for a fresh list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, filter, rowsPerPage, page, reloadKey])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="glass-card overflow-hidden p-0">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="bg-field border-field-edge flex min-w-[200px] max-w-sm flex-1 items-center gap-2 rounded-lg border px-3 py-1.5">
          <Search size={14} className="text-muted-foreground" />
          <input
            className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
            placeholder="Search style code, name or category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search styles"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                filter === f.value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
              {counts[f.count] != null && <span className="ml-1 tabular-nums opacity-70">{counts[f.count]}</span>}
            </button>
          ))}
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-10 text-center text-sm">
          {debounced || filter ? 'No style matches that. Clear the search or pick All.' : 'No styles yet. Add one under Masters → Styles, then give it a routing here.'}
        </p>
      ) : (
        <ul className="divide-border/60 divide-y">
          {rows.map((r) => {
            const look = STYLE_STATE[r.overall.state]
            const pct = r.overall.total ? Math.round((r.overall.done / r.overall.total) * 100) : 0
            return (
              <li key={r.style.id}>
                <Link href={`/masters/routings/style/${r.style.id}`} className="hover:bg-secondary/60 flex items-center gap-3 px-4 py-3 transition-colors">
                  <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
                    {r.overall.state === 'IN_PROGRESS' && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', look.dot)} />}
                    <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', look.dot)} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-primary font-mono text-xs">{r.style.code}</span>
                      <span className="text-foreground truncate text-sm font-medium">{r.style.name}</span>
                      {r.style.category && <span className="text-muted-foreground text-xs">{r.style.category}</span>}
                    </p>
                    <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
                      <Route size={12} className="shrink-0" aria-hidden />
                      {r.routing ? (
                        <>
                          <span className="text-foreground/80">{r.routing.name}</span>
                          <span>
                            {r.routing.fabric ? `· ${r.routing.fabric} ` : ''}· v{r.routing.version} · {r.routing.steps} {r.routing.steps === 1 ? 'step' : 'steps'}
                            {r.routing.applies === 'CATEGORY' ? ' · shared by its category' : r.routing.applies === 'ANY' ? ' · shared by any style' : ''}
                          </span>
                        </>
                      ) : (
                        <span className="warn-text">No routing yet</span>
                      )}
                    </p>
                  </div>

                  <div className="hidden w-64 shrink-0 sm:block">
                    <p className="flex items-center justify-end gap-2 text-xs">
                      <span className={look.badge}>{look.label}</span>
                    </p>
                    <p className="text-muted-foreground mt-1 truncate text-right text-xs" title={describe(r.overall)}>
                      {describe(r.overall)}
                    </p>
                  </div>

                  <div className="hidden w-28 shrink-0 md:block">
                    {r.overall.total > 0 ? (
                      <>
                        <p className="text-muted-foreground text-right text-xs tabular-nums">
                          {r.overall.done} of {r.overall.total} done
                        </p>
                        <div className="bg-secondary mt-1 h-1.5 w-full overflow-hidden rounded-full" aria-hidden>
                          <div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </>
                    ) : (
                      <p className="text-muted-foreground text-right text-xs">—</p>
                    )}
                  </div>

                  {/* On a phone the state goes under the name instead of in its own column. */}
                  <span className={cn('sm:hidden', look.badge)}>{look.label}</span>
                  <ChevronRight size={16} className="text-muted-foreground shrink-0" aria-hidden />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />
    </div>
  )
}
