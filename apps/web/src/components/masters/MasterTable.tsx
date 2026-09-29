'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  RefreshCw,
  AlertCircle,
  Pencil,
  Ban,
  Trash2,
  X,
} from 'lucide-react'
import { api, ApiError, masterResource, type ListParams, type Paginated } from '@/lib/api'
import { MasterFormDialog, type FormField } from './MasterFormDialog'
import { FilterMenu, type FilterChoice } from './FilterMenu'
import { DeleteDialog } from './DeleteDialog'
import { useAppSettings } from '@/lib/appSettings'

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

type Row = Record<string, unknown>
type Picked = Record<string, string[]>

/**
 * A dropdown filter over the list. The API has to accept `key` as a filter
 * (see `filters` in the route's crudRouter options).
 */
export interface FilterDef {
  /** Query parameter the choices are sent as. */
  key: string
  label: string
  /** Fixed choices, for an enum like item type. */
  options?: { value: string; label: string }[]
  /** Or choices loaded from another master. */
  optionsFrom?: {
    resource: string
    /** Keeps only the rows to offer, given what the other filters have ticked. */
    filter?: (row: Row, picked: Picked) => boolean
    /** Defaults to the row's name. Sees what else is ticked, to say less when it can. */
    label?: (row: Row, picked: Picked) => string
  }
  /** The facet whose counts label each choice. */
  facet?: string
  /**
   * Or choices read off the facet itself, for a typed-in column with no
   * master behind it (a style's season, fabric, fit): every value in use,
   * each its own label.
   */
  valuesFromFacet?: boolean
  /**
   * For a count that has to be added up rather than read off: a main
   * category counts the items under its sub-categories too.
   */
  count?: (value: string, counts: Record<string, number>, rows: Row[]) => number
  /** Offers "not set" as a choice of its own, under this label. */
  noneLabel?: string
  /** Emptied when this other filter changes, as a sub-category is by its category. */
  dependsOn?: string
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
  /**
   * Form definition. Supplying it turns on the New button and the per-row
   * edit and deactivate actions; omitting it leaves the table read-only.
   */
  formFields?: FormField[]
  /** Fields per row in the form on a wide screen. */
  formColumns?: 3 | 4
  /** Singular noun used in the dialog heading, e.g. "Customer". */
  entityName?: string
  /**
   * Offers a permanent Delete beside Deactivate. The route must allow it (the
   * crudRouter's `permanentDelete`); the box then says what it would clear
   * or move, and asks where, before anything is done.
   */
  allowDelete?: boolean
  /** What the delete box tells the person to do about what stops a delete. */
  deleteRefusedHint?: string
  /**
   * The master has no active flag (sizes): no "Active only" tick, nothing
   * sent for it, and no Deactivate. Pair with allowDelete.
   */
  noActiveFlag?: boolean
  /** Changing this reloads the list, for a change made outside it (an import). */
  refreshKey?: number
  /** Dropdown filters shown beside the search. */
  filterDefs?: FilterDef[]
}

export function MasterTable<T extends { id: string; isActive?: boolean }>({
  title,
  resource,
  columns,
  searchPlaceholder = 'Search...',
  defaultSort,
  actions,
  filters,
  emptyMessage = 'Nothing here yet.',
  formFields,
  formColumns,
  entityName,
  filterDefs = [],
  allowDelete = false,
  deleteRefusedHint,
  noActiveFlag = false,
  refreshKey = 0,
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

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<T | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // The record whose delete box is open, and what the last delete did.
  const [deleting, setDeleting] = useState<T | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Rows per page comes from Settings -> Preferences.
  const { rowsPerPage } = useAppSettings()

  const client = useMemo(() => masterResource<T>(resource), [resource])
  const editable = Boolean(formFields?.length)
  const singular = entityName ?? title.replace(/s$/, '')

  // Typing shouldn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 350)
    return () => clearTimeout(timer)
  }, [search])

  // What each dropdown has ticked, by query parameter.
  const [picked, setPicked] = useState<Picked>({})
  // The rows each master-backed dropdown offers, loaded once.
  const [filterRows, setFilterRows] = useState<Record<string, Row[]>>({})
  // Per facet, how many records each value would leave.
  const [facetCounts, setFacetCounts] = useState<Record<string, Record<string, number>> | null>(
    null,
  )

  // A new search or filter invalidates the current page number.
  const pickedKey = JSON.stringify(picked)
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, activeOnly, pickedKey])

  // Everything that narrows the list, as the API takes it. The list and the
  // counts are asked the same question, so they can never disagree.
  const filtersKey = JSON.stringify(filters)
  const narrowing = useMemo<ListParams>(() => {
    const params: ListParams = {
      q: debouncedSearch || undefined,
      active: activeOnly && !noActiveFlag ? true : undefined,
      ...filters,
    }
    for (const [key, values] of Object.entries(picked)) {
      if (values.length) params[key] = values.join(',')
    }
    return params
    // Compared by contents: `filters` is an object literal at most call sites.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, activeOnly, pickedKey, filtersKey])

  // Dropdowns fed from another master load their rows once.
  const filterDefsKey = filterDefs.map((f) => f.key).join()
  useEffect(() => {
    let cancelled = false
    for (const def of filterDefs) {
      if (!def.optionsFrom) continue
      masterResource<Row>(def.optionsFrom.resource)
        .list({ limit: 200, active: true })
        .then((res) => {
          if (!cancelled) setFilterRows((prev) => ({ ...prev, [def.key]: res.data }))
        })
        .catch(() => {
          if (!cancelled) setFilterRows((prev) => ({ ...prev, [def.key]: [] }))
        })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterDefsKey])

  // The counts follow the search and every filter; the newest request wins.
  const facetRequest = useRef(0)
  const hasFacets = filterDefs.some((f) => f.facet)
  useEffect(() => {
    if (!hasFacets) return
    const id = ++facetRequest.current
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(narrowing)) {
      if (v !== undefined && v !== '') qs.set(k, String(v))
    }
    api
      .get<{ data: Record<string, Record<string, number>> }>(`/masters/${resource}/facets?${qs}`)
      .then((res) => {
        if (id === facetRequest.current) setFacetCounts(res.data)
      })
      .catch(() => {
        // Without counts the dropdowns still filter; they just show no numbers.
        if (id === facetRequest.current) setFacetCounts({})
      })
  }, [narrowing, resource, hasFacets])

  // Every value a facet-fed dropdown has offered, so a value the other
  // filters narrow to nought stays in its list with 0 rather than vanishing.
  const facetValuesSeen = useRef<Record<string, Set<string>>>({})

  const choicesFor = (def: FilterDef): FilterChoice[] | undefined => {
    const counts = def.facet && facetCounts ? (facetCounts[def.facet] ?? {}) : undefined
    const countOf = (value: string, rows: Row[]) =>
      counts === undefined
        ? undefined
        : def.count
          ? def.count(value, counts, rows)
          : (counts[value] ?? 0)

    let list: FilterChoice[]
    if (def.valuesFromFacet) {
      if (!counts) return undefined
      const seen = (facetValuesSeen.current[def.key] ??= new Set())
      for (const v of Object.keys(counts)) if (v && v !== 'none') seen.add(v)
      for (const v of picked[def.key] ?? []) if (v !== 'none') seen.add(v)
      list = [...seen]
        .sort((a, b) => a.localeCompare(b))
        .map((v) => ({ value: v, label: v, count: counts[v] ?? 0 }))
      // Typed-in columns hold both nothing and an empty string; both are "not set".
      if (def.noneLabel) {
        list.push({ value: 'none', label: def.noneLabel, count: (counts.none ?? 0) + (counts[''] ?? 0) })
      }
      return list
    } else if (def.optionsFrom) {
      const rows = filterRows[def.key]
      if (!rows) return undefined
      const { filter, label } = def.optionsFrom
      list = rows
        .filter((r) => !filter || filter(r, picked))
        .map((r) => ({
          value: String(r.id),
          label: label ? label(r, picked) : String(r.name ?? r.id),
          count: countOf(String(r.id), rows),
        }))
    } else {
      list = (def.options ?? []).map((o) => ({ ...o, count: countOf(o.value, []) }))
    }
    if (def.noneLabel) list.push({ value: 'none', label: def.noneLabel, count: countOf('none', []) })
    return list
  }

  const setFilter = (key: string, values: string[]) =>
    setPicked((prev) => {
      const next = { ...prev, [key]: values }
      for (const def of filterDefs) if (def.dependsOn === key) next[def.key] = []
      return next
    })

  // Each ticked choice as a removable chip, named as it is in its list.
  const chips = filterDefs.flatMap((def) => {
    const values = picked[def.key] ?? []
    if (!values.length) return []
    const choices = choicesFor(def) ?? []
    return values.map((value) => ({
      key: def.key,
      value,
      text: `${def.label}: ${choices.find((c) => c.value === value)?.label ?? '…'}`,
    }))
  })
  const narrowed = chips.length > 0 || Boolean(debouncedSearch)

  // Responses can arrive out of order; only the newest request may render.
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)

    try {
      const res: Paginated<T> = await client.list({
        page,
        limit: rowsPerPage,
        sort,
        order,
        ...narrowing,
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
  }, [client, page, rowsPerPage, sort, order, narrowing])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  /**
   * Masters are referenced by transactions forever, so the API deactivates
   * rather than deletes. The wording here has to match that or it reads as
   * destructive.
   */
  const deactivate = async (row: T) => {
    const label = (row as Record<string, unknown>).name ?? (row as Record<string, unknown>).code
    if (
      !window.confirm(
        `Deactivate ${label}?\n\nIt stays in the system and on past documents, but stops appearing in new ones. You can reactivate it later by editing it.`,
      )
    ) {
      return
    }

    setActionError(null)
    try {
      await client.deactivate(row.id)
      await load()
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : 'Could not deactivate. Is the API running?',
      )
    }
  }

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
          {editable && (
            <button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
              className="btn-primary"
            >
              <Plus size={16} />
              New {singular}
            </button>
          )}
        </div>
      </div>

      {/* Raised above the table so an open dropdown lies over it, not under it. */}
      <div className="glass-card relative z-20 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 min-w-60 flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
            <Search size={15} className="text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {filterDefs.map((def) => (
            <FilterMenu
              key={def.key}
              label={def.label}
              choices={choicesFor(def)}
              selected={picked[def.key] ?? []}
              onChange={(values) => setFilter(def.key, values)}
            />
          ))}

          {!noActiveFlag && (
          <label className="ml-1 flex cursor-pointer select-none items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
              className="accent-teal-500"
            />
            Active only
          </label>
          )}
        </div>

        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {chips.map((c) => (
              <span
                key={`${c.key}:${c.value}`}
                className="border-primary/30 bg-primary/10 inline-flex items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-xs text-foreground"
              >
                {c.text}
                <button
                  type="button"
                  onClick={() =>
                    setFilter(
                      c.key,
                      (picked[c.key] ?? []).filter((v) => v !== c.value),
                    )
                  }
                  className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${c.text}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => {
                setPicked({})
                setSearch('')
              }}
              className="text-primary text-xs font-medium hover:underline"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* What the last delete did, in the API's words: "Embroidery QC deleted.
        1 operation and 1 routing step moved to Embroidery." */}
      {notice && (
        <div className="glass-card flex items-start justify-between gap-3 border-emerald-500/40 p-4">
          <p className="text-sm text-foreground">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {(error || actionError) && (
        <div className="glass-card p-4 flex items-start gap-3 border-red-500/40">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-400">
              {error ? `Could not load ${title}` : 'Action failed'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{error ?? actionError}</p>
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
                    // Inline, because the stylesheet's `.data-table > thead > tr > th`
                    // sets text-left at a weight a `text-right` class cannot beat,
                    // which left a number's heading at the far side of its column.
                    style={col.align ? { textAlign: col.align } : undefined}
                    className={col.sortable ? 'cursor-pointer select-none hover:text-foreground' : undefined}
                    onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                  >
                    {col.header}
                    {sort === col.key && (order === 'asc' ? ' ↑' : ' ↓')}
                  </th>
                ))}
                {editable && <th style={{ textAlign: 'right' }}>Actions</th>}
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
                  <td
                    colSpan={columns.length + (editable ? 1 : 0)}
                    className="text-center py-10 text-muted-foreground"
                  >
                    {narrowed
                      ? `Nothing matches${debouncedSearch ? ` "${debouncedSearch}"` : ''}${
                          chips.length ? ' with these filters' : ''
                        }.`
                      : emptyMessage}
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
                  {editable && (
                    <td className="text-right whitespace-nowrap">
                      <button
                        className="btn-ghost p-1.5"
                        title={`Edit ${singular.toLowerCase()}`}
                        onClick={() => {
                          setEditing(row)
                          setDialogOpen(true)
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                      {/* Kept in place but hidden on an inactive row, so the
                        Delete beside it stays in the same column on every row. */}
                      {!noActiveFlag && (
                        <button
                          className={`btn-ghost p-1.5 text-red-400 ${row.isActive === false ? 'invisible' : ''}`}
                          title={`Deactivate ${singular.toLowerCase()}`}
                          onClick={() => void deactivate(row)}
                        >
                          <Ban size={14} />
                        </button>
                      )}
                      {allowDelete && (
                        <button
                          className="btn-ghost p-1.5 text-red-500"
                          title={`Delete ${singular.toLowerCase()} permanently`}
                          onClick={() => {
                            setActionError(null)
                            setNotice(null)
                            setDeleting(row)
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  )}
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

      {deleting && (
        <DeleteDialog
          resource={resource}
          id={deleting.id}
          name={String(
            (deleting as Record<string, unknown>).name ??
              (deleting as Record<string, unknown>).label ??
              (deleting as Record<string, unknown>).code ??
              singular,
          )}
          entityName={singular}
          refusedHint={deleteRefusedHint}
          onClose={() => setDeleting(null)}
          onDeleted={(message) => {
            setDeleting(null)
            setNotice(message)
            void load()
          }}
        />
      )}

      {editable && formFields && (
        <MasterFormDialog<T>
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onSaved={() => void load()}
          resource={resource}
          fields={formFields}
          record={editing}
          title={singular}
          columns={formColumns}
        />
      )}
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
