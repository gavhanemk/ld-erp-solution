'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Search, RefreshCw, AlertCircle } from 'lucide-react'
import { ApiError, masterResource, type ListParams, type Paginated } from '@/lib/api'

export interface Column<T> {
  key: string
  header: string
  /** Renders the cell. Falls back to the raw value at `key` when omitted. */
  render?: (row: T) => React.ReactNode
  align?: 'left' | 'right' | 'center'
  /** Only columns the API whitelists may be sorted; others render unclickable. */
  sortable?: boolean
  className?: string
}

interface MasterTableProps<T> {
  title: string
  /** Master endpoint segment, e.g. 'customers' for /api/masters/customers. */
  resource: string
  columns: Column<T>[]
  searchPlaceholder?: string
  defaultSort?: string
  /** Rendered in the header, typically a "New ..." link. */
  actions?: React.ReactNode
  /** Extra query parameters merged into every list request. */
  filters?: ListParams
  emptyMessage?: string
}

const PAGE_SIZE = 25

export function MasterTable<T extends { id: string; isActive?: boolean }>({
  title,
  resource,
  columns,
  searchPlaceholder = 'Search...',
  defaultSort,
  actions,
  filters,
  emptyMessage = 'Nothing here yet.',
}: MasterTableProps<T>) {
  const [rows, setRows] = useState<T[]>([])
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [activeOnly, setActiveOnly] = useState(true)
  const [sort, setSort] = useState(defaultSort)
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')

  const client = useMemo(() => masterResource<T>(resource), [resource])

  // Typing shouldn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 350)
    return () => clearTimeout(timer)
  }, [search])

  // A new search or filter invalidates the current page number.
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, activeOnly])

  // Responses can arrive out of order; only the newest request may render.
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)

    try {
      const res: Paginated<T> = await client.list({
        page,
        limit: PAGE_SIZE,
        q: debouncedSearch || undefined,
        sort,
        order,
        active: activeOnly ? true : undefined,
        ...filters,
      })

      if (id !== requestId.current) return
      setRows(res.data)
      setPagination({
        page: res.pagination.page,
        pages: res.pagination.pages,
        total: res.pagination.total,
      })
    } catch (err) {
      if (id !== requestId.current) return
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?',
      )
      setRows([])
    } finally {
      if (id === requestId.current) setLoading(false)
    }
    // `filters` is an object literal at most call sites, so it is compared by
    // its contents rather than identity to avoid an endless reload loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, page, debouncedSearch, sort, order, activeOnly, JSON.stringify(filters)])

  useEffect(() => {
    void load()
  }, [load])

  const toggleSort = (key: string) => {
    if (sort === key) {
      setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
    } else {
      setSort(key)
      setOrder('asc')
    }
  }

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">
            {loading && rows.length === 0
              ? 'Loading...'
              : `${pagination.total} record${pagination.total === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => void load()} className="btn-secondary" title="Refresh">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          {actions}
        </div>
      </div>

      <div className="glass-card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-60 flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border">
          <Search size={15} className="text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="bg-transparent text-sm text-foreground placeholder:text-muted-foreground flex-1 focus:outline-none"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            className="accent-teal-500"
          />
          Active only
        </label>
      </div>

      {error && (
        <div className="glass-card p-4 flex items-start gap-3 border-red-500/40">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-400">Could not load {title}</p>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
        </div>
      )}

      <div className="glass-card p-6">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={[
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : '',
                      col.sortable ? 'cursor-pointer select-none hover:text-foreground' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                  >
                    {col.header}
                    {sort === col.key && (order === 'asc' ? ' ↑' : ' ↓')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 &&
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`skeleton-${i}`}>
                    {columns.map((col) => (
                      <td key={col.key}>
                        <div className="skeleton h-4 w-24" />
                      </td>
                    ))}
                  </tr>
                ))}

              {!loading && rows.length === 0 && !error && (
                <tr>
                  <td colSpan={columns.length} className="text-center py-10 text-muted-foreground">
                    {debouncedSearch ? `No matches for "${debouncedSearch}".` : emptyMessage}
                  </td>
                </tr>
              )}

              {rows.map((row) => (
                <tr key={row.id} className={row.isActive === false ? 'opacity-50' : ''}>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={[
                        col.align === 'right'
                          ? 'text-right'
                          : col.align === 'center'
                            ? 'text-center'
                            : '',
                        col.className ?? '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {col.render
                        ? col.render(row)
                        : ((row as Record<string, unknown>)[col.key] as React.ReactNode) ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pagination.pages > 1 && (
          <div className="flex items-center justify-between pt-4 mt-4 border-t border-border">
            <p className="text-xs text-muted-foreground">
              Page {pagination.page} of {pagination.pages}
            </p>
            <div className="flex items-center gap-2">
              <button
                className="btn-ghost"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft size={16} />
                Previous
              </button>
              <button
                className="btn-ghost"
                disabled={page >= pagination.pages || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Shared cell renderer for the active/inactive flag every master carries. */
export function ActiveBadge({ isActive }: { isActive?: boolean }) {
  return isActive === false ? (
    <span className="badge-neutral">Inactive</span>
  ) : (
    <span className="badge-success">Active</span>
  )
}

export { Plus }
