'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Factory,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Route,
  Search,
  Share2,
  Shirt,
  Trash2,
  Unlock,
  X,
} from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import type { Routing } from '@/components/masters/RoutingFormDialog'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { Pagination } from '@/components/tables/Pagination'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Masters → Routings, style by style — laid out as the BOM list is: the
 * counts on top (each narrows the list), one bar to search and narrow, and a
 * table with each style as a heading and its routings under it.
 *
 * A routing's line answers the three things the old list left to guesswork:
 * which style it is for (the heading, or "shared by every Shirt style"), which
 * one a new order takes, and which manufacturing orders were made with it and
 * where each has got to. Opened, a line shows the steps in order and every
 * order made with it, with the version it was given.
 *
 * Read from GET /masters/routings/by-style. Editing, locking, stopping and
 * deleting are the same calls the "All routings" tab makes.
 */

type Applies = 'STYLE' | 'CATEGORY' | 'ANY'
type Show = 'ALL' | 'OWN' | 'SHARED' | 'NONE' | 'ON_ORDERS'

interface StyleRouting {
  id: string
  code: string
  name: string
  version: number
  applies: Applies
  category: string | null
  otherStyle: string | null
  isActive: boolean
  isLocked: boolean
  fabric: string | null
  steps: Array<{ sequence: number; name: string; isQcStep: boolean; execution: string; skip: string }>
  updatedAt: string
  updatedBy: string | null
  boms: number
  takesNew: boolean
}

interface StyleOrder {
  lineId: string
  moId: string
  moNumber: string
  status: string
  open: boolean
  color: string
  planned: number
  staged: boolean
  done: number
  total: number
  at: string | null
  routingId: string | null
  routingVersion: number | null
  so: { soNumber: string; customer: string } | null
}

interface StyleGroup {
  style: { id: string; code: string; name: string; category: string | null; brandType: string }
  kind: 'OWN' | 'SHARED' | 'NONE'
  routings: StyleRouting[]
  orders: StyleOrder[]
}

interface ListResponse {
  data: StyleGroup[]
  counts: Record<Show, number>
  pagination: { total: number; pages: number }
}

const SHOW_LABEL: Record<Show, string> = {
  ALL: 'All styles',
  OWN: 'With their own routing',
  SHARED: 'Following a shared routing',
  NONE: 'With no routing',
  ON_ORDERS: 'With orders in work',
}

const MO_STATUS: Record<string, string> = {
  DRAFT: 'Draft',
  RELEASED: 'Released',
  CUTTING: 'Cutting',
  STITCHING: 'Stitching',
  FINISHING: 'Finishing',
  QC: 'QC',
  PACKING: 'Packing',
  COMPLETED: 'Completed',
  CLOSED: 'Closed',
}

const COLS = 7
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Shared by every Shirt style" — whom a routing is for, when it is not made for the style it sits under. */
function sharedText(r: StyleRouting) {
  if (r.otherStyle) return `Made for ${r.otherStyle}`
  if (r.applies === 'CATEGORY') return `Shared by every ${r.category} style`
  if (r.applies === 'ANY') return 'Shared by any style'
  return null
}

/** Where one order is on its own route, in a few words. */
function whereText(o: StyleOrder) {
  if (o.status === 'CLOSED') return 'Closed'
  if (!o.staged) return 'Steps not loaded yet'
  if (o.total > 0 && o.done === o.total) return 'Through every step'
  return o.at ? `At ${o.at} · ${o.done} of ${o.total} done` : `${o.done} of ${o.total} done`
}

/** The running orders on a routing, put together: "2 at Stitching, 1 not started". */
function whereSummary(orders: StyleOrder[]) {
  const running = orders.filter((o) => o.open)
  if (!running.length) return null
  if (running.length === 1) return `${running[0].moNumber}: ${whereText(running[0])}`
  const by = new Map<string, number>()
  for (const o of running) {
    const k = !o.staged ? 'steps not loaded' : o.total > 0 && o.done === o.total ? 'through every step' : o.at ? `at ${o.at}` : 'started'
    by.set(k, (by.get(k) ?? 0) + 1)
  }
  return [...by.entries()].map(([k, n]) => `${n} ${k}`).join(', ')
}

export function RoutingsByStyle({
  reloadKey,
  onError,
  onMessage,
  onEdit,
  onNew,
}: {
  reloadKey: number
  onError: (m: string | null) => void
  onMessage: (m: string) => void
  /** Opens the routing form on a routing. */
  onEdit: (r: Routing) => void
  /** Opens the routing form for a new routing made for this style. */
  onNew: (styleId: string) => void
}) {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<StyleGroup[] | null>(null)
  const [counts, setCounts] = useState<Record<Show, number> | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [show, setShow] = useState<Show>('ALL')
  /** The routing line opened, as "styleId:routingId". */
  const [expanded, setExpanded] = useState<string | null>(null)
  const latest = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [debounced, show])

  const load = useCallback(async () => {
    const ticket = ++latest.current
    setLoading(true)
    onError(null)
    try {
      const qs = new URLSearchParams({ limit: String(rowsPerPage), page: String(page) })
      if (debounced) qs.set('q', debounced)
      if (show !== 'ALL') qs.set('show', show)
      const res = await api.get<ListResponse>(`/masters/routings/by-style?${qs}`)
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
  }, [debounced, show, rowsPerPage, page, reloadKey])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<{ message?: string }>, fallback: string) => {
    setBusy(true)
    onError(null)
    try {
      const res = await fn()
      onMessage(res.message ?? fallback)
      await load()
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  /** The form needs the whole routing, so it is read fresh before it opens. */
  const edit = async (id: string) => {
    setBusy(true)
    onError(null)
    try {
      onEdit((await api.get<{ data: Routing }>(`/masters/routings/${id}`)).data)
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not open that routing.')
    } finally {
      setBusy(false)
    }
  }

  /** A tile narrows the list to its styles; pressed again, back to all. */
  const pick = (v: Show) => setShow((cur) => (cur === v ? 'ALL' : v))
  const tileSub = (v: Show, text: string) => (show === v ? 'showing only these · click to show all' : text)
  const narrowed = !!debounced || show !== 'ALL'
  const mayCreate = can('masters', 'create')

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          icon={Route}
          tone={TONE.teal}
          label="Own routing"
          value={counts ? String(counts.OWN) : '…'}
          sub={tileSub('OWN', 'styles with a routing made for them')}
          onClick={() => pick('OWN')}
          active={show === 'OWN'}
        />
        <KpiTile
          icon={Share2}
          tone={TONE.sky}
          label="Shared routing"
          value={counts ? String(counts.SHARED) : '…'}
          sub={tileSub('SHARED', "follow a category's or any style's routing")}
          onClick={() => pick('SHARED')}
          active={show === 'SHARED'}
        />
        <KpiTile
          icon={AlertTriangle}
          tone={TONE.amber}
          label="No routing"
          value={counts ? String(counts.NONE) : '…'}
          valueClass={counts?.NONE ? 'text-amber-500' : 'text-foreground'}
          sub={tileSub('NONE', 'an order for these has no steps to load')}
          onClick={() => pick('NONE')}
          active={show === 'NONE'}
        />
        <KpiTile
          icon={Factory}
          tone={TONE.violet}
          label="Orders in work"
          value={counts ? String(counts.ON_ORDERS) : '…'}
          sub={tileSub('ON_ORDERS', 'styles with manufacturing orders running')}
          onClick={() => pick('ON_ORDERS')}
          active={show === 'ON_ORDERS'}
        />
      </div>

      <div className="glass-card flex flex-wrap items-center gap-3 p-4">
        <div className="border-border bg-secondary flex min-w-60 flex-1 items-center gap-2 rounded-lg border px-3 py-2">
          <Search size={15} className="text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search style, routing name, MO or sales order number…"
            className="text-foreground placeholder:text-muted-foreground flex-1 bg-transparent text-sm focus:outline-none"
            aria-label="Search routings by style"
            data-hotkey="search"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground" aria-label="Clear the search">
              <X size={14} />
            </button>
          )}
        </div>
        <SmartSelect className="form-input w-auto" value={show} onChange={(e) => setShow(e.target.value as Show)} aria-label="Show">
          {(Object.keys(SHOW_LABEL) as Show[]).map((k) => (
            <option key={k} value={k}>
              {SHOW_LABEL[k]}
              {counts ? ` (${counts[k]})` : ''}
            </option>
          ))}
        </SmartSelect>
        {narrowed && (
          <button
            type="button"
            onClick={() => {
              setSearch('')
              setShow('ALL')
            }}
            className="text-primary text-xs hover:underline"
          >
            Clear
          </button>
        )}
        <span className="text-muted-foreground ml-auto text-xs">{loading && !rows ? 'Loading…' : plural(total, 'style')}</span>
      </div>

      {loading && !rows && <div className="skeleton h-40 w-full rounded-xl" />}

      {rows && rows.length === 0 && (
        <div className="glass-card p-10 text-center">
          <Route size={22} className="text-muted-foreground mx-auto mb-3" />
          <p className="text-foreground text-sm font-medium">{narrowed ? 'Nothing matches that' : 'No styles yet'}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {narrowed ? 'Clear the search, or show all styles.' : 'Add a style under Masters → Styles, then give it a routing here.'}
          </p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className={cn('glass-card list-scope overflow-hidden p-0 transition-opacity', loading && 'opacity-60')}>
          <ScrollableTable>
            <table className="data-table table-compact min-w-full">
              <thead>
                <tr className="bg-secondary">
                  <th style={{ width: 44 }} />
                  <th className="whitespace-nowrap">Routing</th>
                  <th className="whitespace-nowrap">Steps</th>
                  <th className="whitespace-nowrap">Orders made with it</th>
                  <th className="whitespace-nowrap">Where the work is</th>
                  <th className="whitespace-nowrap">Last changed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((g, gi) => {
                  const unrouted = g.orders.filter((o) => !o.routingId)
                  return (
                    <Fragment key={g.style.id}>
                      <StyleHeading group={g} />
                      {g.routings.length === 0 ? (
                        <tr data-row tabIndex={gi === 0 ? 0 : -1}>
                          <td />
                          <td colSpan={COLS - 2}>
                            <p className="warn-text text-sm">No routing yet</p>
                            <p className="text-muted-foreground text-xs">A manufacturing order for this style has no steps to load until it has one.</p>
                          </td>
                          <td className="text-right">
                            {mayCreate && (
                              <button className="btn-primary h-7 px-2.5 text-xs" onClick={() => onNew(g.style.id)} disabled={busy}>
                                <Plus size={13} /> Make routing
                              </button>
                            )}
                          </td>
                        </tr>
                      ) : (
                        g.routings.map((r, ri) => {
                          const key = `${g.style.id}:${r.id}`
                          return (
                            <RoutingLine
                              key={key}
                              routing={r}
                              orders={g.orders.filter((o) => o.routingId === r.id)}
                              first={gi === 0 && ri === 0}
                              open={expanded === key}
                              busy={busy}
                              onToggle={() => setExpanded(expanded === key ? null : key)}
                              onEdit={() => void edit(r.id)}
                              onLock={() =>
                                void act(() => api.patch(`/masters/routings/${r.id}`, { isLocked: !r.isLocked }), r.isLocked ? 'Unlocked.' : 'Locked.')
                              }
                              onStop={() => {
                                if (confirm(`Stop offering "${r.name}" on new orders? Orders that already have its steps keep them.`)) {
                                  void act(() => api.patch(`/masters/routings/${r.id}`, { isActive: false }), 'No longer offered.')
                                }
                              }}
                              onUseAgain={() => void act(() => api.patch(`/masters/routings/${r.id}`, { isActive: true }), 'Offered again.')}
                              onDelete={() => {
                                if (confirm(`Delete "${r.name}" for good? Its steps go with it. This cannot be undone.`)) {
                                  void act(() => api.delete(`/masters/routings/${r.id}`), 'Deleted.')
                                }
                              }}
                            />
                          )
                        })
                      )}
                      {unrouted.length > 0 && (
                        <tr>
                          <td />
                          <td colSpan={COLS - 1} className="text-muted-foreground text-xs">
                            {plural(unrouted.length, 'order')} made before routings were recorded on orders:{' '}
                            {unrouted.map((o, i) => (
                              <Fragment key={o.lineId}>
                                {i > 0 && ', '}
                                <Link href={`/production/orders?open=${o.moId}`} className="text-primary font-mono hover:underline">
                                  {o.moNumber}
                                </Link>
                              </Fragment>
                            ))}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </ScrollableTable>
          <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />
        </div>
      )}
    </div>
  )
}

/** A style as the heading over its routings: code, name, category, what it has, and its page. */
function StyleHeading({ group: g }: { group: StyleGroup }) {
  const running = g.orders.filter((o) => o.open).length
  return (
    <tr className="border-t-border bg-secondary/60 border-t">
      <td colSpan={COLS} className="!p-0">
        <div className="sticky left-0 flex w-[100cqw] flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2">
          <Shirt size={15} className="text-primary shrink-0" />
          <span className="text-primary font-mono text-sm font-semibold">{g.style.code}</span>
          <span className="text-foreground text-sm font-medium">{g.style.name}</span>
          {g.style.category && <span className="text-muted-foreground text-xs">{g.style.category}</span>}
          {g.style.brandType === 'VHAGAR' && <span className="vhagar-accent text-xs font-bold">VHAGAR</span>}
          <span className="border-border bg-card text-muted-foreground rounded-full border px-2 py-0.5 text-[11px] tabular-nums">
            {g.kind === 'NONE' ? 'no routing' : plural(g.routings.length, 'routing')}
            {` · ${plural(g.orders.length, 'order')}`}
            {running ? ` · ${running} in work` : ''}
          </span>
          <Link
            href={`/masters/routings/style/${g.style.id}`}
            className="text-primary ml-auto inline-flex items-center gap-1 text-xs hover:underline"
            title="Each step of this style, and where its orders stand at each"
          >
            Style page <ExternalLink size={12} />
          </Link>
        </div>
      </td>
    </tr>
  )
}

interface LineProps {
  routing: StyleRouting
  /** This style's orders made with this routing. */
  orders: StyleOrder[]
  first: boolean
  open: boolean
  busy: boolean
  onToggle: () => void
  onEdit: () => void
  onLock: () => void
  onStop: () => void
  onUseAgain: () => void
  onDelete: () => void
}

/** One routing under its style: whom it is for, its steps, the orders made with it, and where they are. */
function RoutingLine({ routing: r, orders, first, open, busy, onToggle, onEdit, onLock, onStop, onUseAgain, onDelete }: LineProps) {
  const shared = sharedText(r)
  const mayEdit = can('masters', 'edit')
  const mayDelete = can('masters', 'delete')
  const running = orders.filter((o) => o.open)
  const finished = orders.length - running.length
  const chain = r.steps.map((s) => s.name)
  const preview = chain.length > 4 ? `${chain.slice(0, 3).join(' → ')} → … → ${chain[chain.length - 1]}` : chain.join(' → ')
  const where = whereSummary(orders)
  // Deleting is for a routing nothing uses; a shared one is looked after on the "All routings" tab.
  const deleteBlock = r.isLocked ? 'Unlock it first' : orders.length ? 'Orders were made with it: stop using it instead' : r.boms ? 'A BOM points at it: stop using it instead' : null

  const actions: RowAction[] = [
    ...(mayEdit
      ? [
          { key: 'edit', label: shared ? `Edit (${shared.toLowerCase()})` : 'Edit', icon: <Pencil size={14} />, onClick: onEdit },
          { key: 'lock', label: r.isLocked ? 'Unlock' : 'Lock, so nobody changes its steps', icon: r.isLocked ? <Unlock size={14} /> : <Lock size={14} />, onClick: onLock },
          r.isActive
            ? { key: 'stop', label: 'Stop using on new orders', icon: <Ban size={14} />, onClick: onStop }
            : { key: 'again', label: 'Use again', icon: <RotateCcw size={14} />, onClick: onUseAgain },
        ]
      : []),
    ...(mayDelete && !shared
      ? [{ key: 'delete', label: 'Delete for good', icon: <Trash2 size={14} />, onClick: onDelete, danger: true, disabled: !!deleteBlock, hint: deleteBlock ?? undefined }]
      : []),
  ]

  return (
    <>
      <tr data-row tabIndex={first ? 0 : -1} className={cn(!r.isActive && 'opacity-70')}>
        <td>
          <button
            onClick={onToggle}
            className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
            aria-label={`${open ? 'Hide' : 'Show'} the steps and orders of ${r.name}`}
            aria-expanded={open}
            title={open ? 'Hide details' : 'Show the steps and every order made with it'}
            data-row-open
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </td>
        <td>
          <div className="text-foreground text-sm font-medium">{r.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-muted-foreground font-mono">v{r.version}</span>
            {r.fabric && <span className="text-muted-foreground">· {r.fabric}</span>}
            {r.takesNew && <span className="badge-success">New orders take this</span>}
            {!r.isActive && <span className="badge-neutral">Stopped</span>}
            {r.isLocked && (
              <span className="text-muted-foreground inline-flex items-center gap-0.5" title="Locked: nobody can change its steps">
                <Lock size={11} /> Locked
              </span>
            )}
            {shared && <span className="badge-info">{shared}</span>}
          </div>
        </td>
        <td className="max-w-[18rem]">
          <div className="text-foreground text-sm tabular-nums">{plural(r.steps.length, 'step')}</div>
          <div className="text-muted-foreground truncate text-[11px]" title={chain.join(' → ')}>
            {preview || '—'}
          </div>
        </td>
        <td className="whitespace-nowrap">
          {orders.length ? (
            <>
              <div className="text-foreground text-sm">
                {running.length ? `${running.length} in work` : ''}
                {running.length && finished ? ' · ' : ''}
                {finished ? `${finished} finished` : ''}
              </div>
              <div className="text-muted-foreground font-mono text-[11px]">
                {orders
                  .slice(0, 2)
                  .map((o) => o.moNumber)
                  .join(', ')}
                {orders.length > 2 ? ` +${orders.length - 2}` : ''}
              </div>
            </>
          ) : (
            <span className="text-muted-foreground text-xs">None yet</span>
          )}
        </td>
        <td className="max-w-[16rem]">
          {where ? <span className="text-foreground text-xs">{where}</span> : <span className="text-muted-foreground text-xs">—</span>}
        </td>
        <td className="whitespace-nowrap text-xs">
          <div className="text-foreground">{r.updatedBy ?? '—'}</div>
          <div className="text-muted-foreground">{formatDate(r.updatedAt)}</div>
        </td>
        <td className="whitespace-nowrap text-right">
          <div className="flex justify-end gap-1.5">
            {mayEdit && (
              <button className="btn-secondary h-7 px-2.5 text-xs" onClick={onEdit} disabled={busy}>
                <Pencil size={13} /> Edit
              </button>
            )}
            {actions.length > 0 && <ActionMenu label={`Actions for ${r.name}`} items={actions} />}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={COLS} className="bg-secondary/30 !p-0">
            <div className="sticky left-0 w-[100cqw]">
              <RoutingDetail routing={r} orders={orders} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

const sectionTitle = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/** Opened: the steps in order, and every order of the style made with this routing. */
function RoutingDetail({ routing: r, orders }: { routing: StyleRouting; orders: StyleOrder[] }) {
  return (
    <div className="grid gap-5 px-4 py-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div>
        <p className={sectionTitle}>Steps, in order</p>
        <ol className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs">
          {r.steps.map((s, i) => (
            <li key={`${s.sequence}-${i}`} className="flex items-center gap-1">
              {i > 0 && <ArrowRight size={12} className="text-muted-foreground shrink-0" aria-hidden />}
              <span className="border-border bg-card text-foreground whitespace-nowrap rounded-md border px-2 py-0.5">
                <span className="text-muted-foreground tabular-nums">{s.sequence}.</span> {s.name}
                {s.isQcStep && <span className="text-primary"> (check)</span>}
                {s.execution === 'OUTSOURCED' && <span className="text-muted-foreground"> (outside unit)</span>}
                {s.skip === 'OPTIONAL' && <span className="text-muted-foreground"> (optional)</span>}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-muted-foreground mt-3 text-[11px]">
          Version {r.version}. Changing the steps makes the next version for orders to come; an order keeps the steps it was given.
          {r.boms ? ` ${plural(r.boms, 'BOM')} point${r.boms === 1 ? 's' : ''} at it.` : ''}
        </p>
      </div>

      <div className="min-w-0">
        <p className={sectionTitle}>Orders made with this routing</p>
        {orders.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-xs">
            None yet. A manufacturing order for this style takes its steps once its materials are issued{r.takesNew ? '' : ' — new orders take the routing marked "New orders take this"'}.
          </p>
        ) : (
          <div className="border-border mt-2 overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-secondary text-muted-foreground text-left">
                  <th className="px-2.5 py-1.5 font-semibold">Order</th>
                  <th className="px-2.5 py-1.5 font-semibold">Sales order · customer</th>
                  <th className="px-2.5 py-1.5 font-semibold">Colour</th>
                  <th className="px-2.5 py-1.5 text-right font-semibold">Pieces</th>
                  <th className="px-2.5 py-1.5 font-semibold">Version</th>
                  <th className="px-2.5 py-1.5 font-semibold">Where it is</th>
                </tr>
              </thead>
              <tbody className="divide-border/60 divide-y">
                {orders.map((o) => (
                  <tr key={o.lineId}>
                    <td className="whitespace-nowrap px-2.5 py-1.5">
                      <Link href={`/production/orders?open=${o.moId}`} className="text-primary font-mono hover:underline">
                        {o.moNumber}
                      </Link>
                      <div className="text-muted-foreground text-[11px]">{MO_STATUS[o.status] ?? o.status}</div>
                    </td>
                    <td className="px-2.5 py-1.5">
                      {o.so ? (
                        <>
                          <Link href={`/sales/orders?q=${encodeURIComponent(o.so.soNumber)}`} className="text-primary font-mono hover:underline">
                            {o.so.soNumber}
                          </Link>
                          <div className="text-muted-foreground text-[11px]">{o.so.customer}</div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">For stock</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-1.5">{o.color || '—'}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-right tabular-nums">{o.planned.toLocaleString('en-IN')}</td>
                    <td className="whitespace-nowrap px-2.5 py-1.5">
                      {o.routingVersion != null ? `v${o.routingVersion}` : '—'}
                      {o.routingVersion != null && o.routingVersion < r.version && <div className="warn-text text-[11px]">older steps</div>}
                    </td>
                    <td className="px-2.5 py-1.5">{whereText(o)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
