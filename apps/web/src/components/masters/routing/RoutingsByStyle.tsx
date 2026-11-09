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
 * Masters → Routings, style by style: the counts on top (each narrows the
 * list), one bar to search and narrow, and one plain table — a row for each
 * style and routing, every figure under its own heading:
 *
 *   Style · Routing · Status · Steps · Orders made with it · Where the work
 *   is · Last changed · Actions
 *
 * A style with several routings has a row for each, the style repeated in
 * grey under its first. A style with no routing has one row saying so, with
 * Make routing. A style's orders that have not been given a routing yet —
 * an order takes its steps once its materials are issued — have a row of
 * their own, naming the routing they will take.
 *
 * Opened, a routing's row shows its steps in order and every order made with
 * it: MO, sales order and customer, colour, pieces, the version it was given
 * and where it is.
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

/** One row of the table: a style's routing, a style with none, or a style's orders not given one yet. */
type Line =
  | { type: 'routing'; key: string; group: StyleGroup; routing: StyleRouting; orders: StyleOrder[] }
  | { type: 'none'; key: string; group: StyleGroup }
  | { type: 'waiting'; key: string; group: StyleGroup; orders: StyleOrder[]; takes: StyleRouting | null }

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

const COLS = 9
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const sectionTitle = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/** The table's rows: each style's routings (the one new orders take first), then its row with none, then its waiting orders. */
function linesOf(groups: StyleGroup[]): Line[] {
  const out: Line[] = []
  for (const g of groups) {
    const routings = [...g.routings].sort((a, b) => Number(b.takesNew) - Number(a.takesNew) || Number(b.isActive) - Number(a.isActive))
    for (const r of routings) out.push({ type: 'routing', key: `${g.style.id}:${r.id}`, group: g, routing: r, orders: g.orders.filter((o) => o.routingId === r.id) })
    if (!routings.length) out.push({ type: 'none', key: `${g.style.id}:none`, group: g })
    const waiting = g.orders.filter((o) => !o.routingId)
    if (waiting.length) out.push({ type: 'waiting', key: `${g.style.id}:waiting`, group: g, orders: waiting, takes: routings.find((r) => r.takesNew) ?? null })
  }
  return out
}

/** "Shared by every Shirt style" — whom a routing is for, when it is not made for the style it sits beside. */
function sharedText(r: StyleRouting) {
  if (r.otherStyle) return `Made for ${r.otherStyle}`
  if (r.applies === 'CATEGORY') return `Shared by every ${r.category} style`
  if (r.applies === 'ANY') return 'Shared by any style'
  return null
}

/** Where one order is on its own route, in a few words. */
function whereText(o: StyleOrder) {
  if (o.status === 'CLOSED') return 'Closed'
  if (!o.staged) return o.status === 'COMPLETED' ? 'Completed without steps' : 'Steps not loaded yet'
  if (o.total > 0 && o.done === o.total) return 'Through every step'
  return o.at ? `At ${o.at} · ${o.done} of ${o.total} done` : `${o.done} of ${o.total} done`
}

/**
 * Each running order once, where its slowest colour is: an order with two
 * colours at Stitching and Fusing is at Fusing. The opened row lists each colour.
 */
function runningOrders(orders: StyleOrder[]) {
  const behind = (o: StyleOrder) => (o.staged ? o.done : -1)
  const by = new Map<string, StyleOrder>()
  for (const o of orders) {
    if (!o.open) continue
    const seen = by.get(o.moId)
    if (!seen || behind(o) < behind(seen)) by.set(o.moId, o)
  }
  return [...by.values()]
}

/** The orders running on a row, put together: "2 at Stitching, 1 steps not loaded". */
function whereSummary(orders: StyleOrder[]) {
  const running = runningOrders(orders)
  if (!running.length) return null
  if (running.length === 1) return `${running[0].moNumber}: ${whereText(running[0])}`
  const by = new Map<string, number>()
  for (const o of running) {
    const k = !o.staged ? 'steps not loaded' : o.total > 0 && o.done === o.total ? 'through every step' : o.at ? `at ${o.at}` : 'started'
    by.set(k, (by.get(k) ?? 0) + 1)
  }
  return [...by.entries()].map(([k, n]) => `${n} ${k}`).join(', ')
}

/** Manufacturing orders, counted once each: an order with two colours of a style is one order. */
const moCount = (orders: StyleOrder[]) => new Set(orders.map((o) => o.moId)).size
const moNumbers = (orders: StyleOrder[]) => [...new Set(orders.map((o) => o.moNumber))]

/** What a routing is to its style, as one badge and a few words under it. */
function statusOf(r: StyleRouting, orders: StyleOrder[]) {
  if (!r.isActive) return { badge: 'badge-neutral', label: 'Stopped', sub: orders.length ? 'kept for its orders' : 'not offered' }
  if (r.takesNew) return { badge: 'badge-success', label: 'In use', sub: 'new orders take this' }
  return { badge: 'badge-info', label: 'Spare', sub: 'new orders take another' }
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
  const [groups, setGroups] = useState<StyleGroup[] | null>(null)
  const [counts, setCounts] = useState<Record<Show, number> | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [show, setShow] = useState<Show>('ALL')
  /** The row opened, by its key. */
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
      setGroups(res.data)
      setCounts(res.counts)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket !== latest.current) return
      onError(err instanceof ApiError ? err.message : 'Could not reach the server. Is the API running?')
      setGroups([])
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
  const lines = groups ? linesOf(groups) : []

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
        <span className="text-muted-foreground ml-auto text-xs">{loading && !groups ? 'Loading…' : plural(total, 'style')}</span>
      </div>

      {loading && !groups && <div className="skeleton h-40 w-full rounded-xl" />}

      {groups && groups.length === 0 && (
        <div className="glass-card p-10 text-center">
          <Route size={22} className="text-muted-foreground mx-auto mb-3" />
          <p className="text-foreground text-sm font-medium">{narrowed ? 'Nothing matches that' : 'No styles yet'}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {narrowed ? 'Clear the search, or show all styles.' : 'Add a style under Masters → Styles, then give it a routing here.'}
          </p>
        </div>
      )}

      {lines.length > 0 && (
        <div className={cn('glass-card list-scope overflow-hidden p-0 transition-opacity', loading && 'opacity-60')}>
          <ScrollableTable>
            {/* Fixed widths, so each column lines up row after row; the routing and where the work is share what is left. */}
            <table className="data-table table-compact w-full min-w-[1400px] table-fixed">
              <colgroup>
                <col style={{ width: 44 }} />
                <col style={{ width: 240 }} />
                <col />
                <col style={{ width: 140 }} />
                <col style={{ width: 170 }} />
                <col style={{ width: 140 }} />
                <col />
                <col style={{ width: 150 }} />
                <col style={{ width: 132 }} />
              </colgroup>
              <thead>
                <tr className="bg-secondary [&>th]:whitespace-nowrap">
                  <th />
                  <th>Style</th>
                  <th>Routing</th>
                  <th>Status</th>
                  <th>Steps</th>
                  <th>Orders</th>
                  <th>Where the work is</th>
                  <th>Last changed</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => {
                  // The style's first row names it; the rows after repeat it in grey, so each row still reads on its own.
                  const repeat = i > 0 && lines[i - 1].group.style.id === line.group.style.id
                  const open = expanded === line.key
                  const toggle = () => setExpanded(open ? null : line.key)
                  return (
                    <Fragment key={line.key}>
                      {line.type === 'routing' ? (
                        <RoutingRow
                          line={line}
                          repeat={repeat}
                          first={i === 0}
                          open={open}
                          busy={busy}
                          onToggle={toggle}
                          onEdit={() => void edit(line.routing.id)}
                          onLock={() =>
                            void act(
                              () => api.patch(`/masters/routings/${line.routing.id}`, { isLocked: !line.routing.isLocked }),
                              line.routing.isLocked ? 'Unlocked.' : 'Locked.',
                            )
                          }
                          onStop={() => {
                            if (confirm(`Stop offering "${line.routing.name}" on new orders? Orders that already have its steps keep them.`)) {
                              void act(() => api.patch(`/masters/routings/${line.routing.id}`, { isActive: false }), 'No longer offered.')
                            }
                          }}
                          onUseAgain={() => void act(() => api.patch(`/masters/routings/${line.routing.id}`, { isActive: true }), 'Offered again.')}
                          onDelete={() => {
                            if (confirm(`Delete "${line.routing.name}" for good? Its steps go with it. This cannot be undone.`)) {
                              void act(() => api.delete(`/masters/routings/${line.routing.id}`), 'Deleted.')
                            }
                          }}
                        />
                      ) : line.type === 'none' ? (
                        <tr data-row tabIndex={i === 0 ? 0 : -1}>
                          <td />
                          <StyleCell group={line.group} repeat={repeat} />
                          <td>
                            <span className="text-muted-foreground text-sm">—</span>
                          </td>
                          <td className="whitespace-nowrap">
                            <span className="badge-warning">No routing</span>
                            <div className="text-muted-foreground mt-0.5 truncate text-[11px]">needs one</div>
                          </td>
                          <td className="text-muted-foreground">—</td>
                          <td className="text-muted-foreground text-xs">None yet</td>
                          <td className="text-muted-foreground">—</td>
                          <td className="text-muted-foreground">—</td>
                          <td className="whitespace-nowrap text-right">
                            {mayCreate && (
                              <button className="btn-primary h-7 px-2.5 text-xs" onClick={() => onNew(line.group.style.id)} disabled={busy}>
                                <Plus size={13} /> Make routing
                              </button>
                            )}
                          </td>
                        </tr>
                      ) : (
                        <WaitingRow line={line} repeat={repeat} first={i === 0} open={open} onToggle={toggle} />
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

/** The style a row is for: its code (opening the style's page) and category over its name. */
function StyleCell({ group: g, repeat }: { group: StyleGroup; repeat: boolean }) {
  return (
    <td>
      <div className="flex items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
        <Link
          href={`/masters/routings/style/${g.style.id}`}
          className={cn('font-mono text-xs font-semibold hover:underline', repeat ? 'text-muted-foreground' : 'text-primary')}
          title="Open the style page: each step, and where its orders stand at each"
        >
          {g.style.code}
        </Link>
        {g.style.category && <span className="text-muted-foreground text-[11px]">{g.style.category}</span>}
        {g.style.brandType === 'VHAGAR' && <span className="vhagar-accent text-[11px] font-bold">VHAGAR</span>}
      </div>
      <div className={cn('truncate text-sm', repeat ? 'text-muted-foreground' : 'text-foreground')} title={g.style.name}>
        {g.style.name}
      </div>
    </td>
  )
}

/** The open / close button at the start of a row. */
function Toggle({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
      aria-label={`${open ? 'Hide' : 'Show'} ${label}`}
      aria-expanded={open}
      title={open ? 'Hide details' : `Show ${label}`}
      data-row-open
    >
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  )
}

/** The orders a row is about: how many are in work and finished, and their numbers. */
function OrdersCell({ orders }: { orders: StyleOrder[] }) {
  if (!orders.length) return <td className="text-muted-foreground text-xs">None yet</td>
  const running = moCount(orders.filter((o) => o.open))
  const finished = moCount(orders) - running
  const numbers = moNumbers(orders)
  return (
    <td>
      <div className="text-foreground truncate text-sm">{[running ? `${running} in work` : '', finished ? `${finished} finished` : ''].filter(Boolean).join(' · ')}</div>
      <div className="text-muted-foreground truncate font-mono text-[11px]" title={numbers.join(', ')}>
        {numbers[0]}
        {numbers.length > 1 ? ` +${numbers.length - 1}` : ''}
      </div>
    </td>
  )
}

interface RoutingRowProps {
  line: Extract<Line, { type: 'routing' }>
  repeat: boolean
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

/** A style's routing: whom it is for, whether new orders take it, its steps, the orders made with it, and where they are. */
function RoutingRow({ line, repeat, first, open, busy, onToggle, onEdit, onLock, onStop, onUseAgain, onDelete }: RoutingRowProps) {
  const { group: g, routing: r, orders } = line
  const shared = sharedText(r)
  const status = statusOf(r, orders)
  const mayEdit = can('masters', 'edit')
  const mayDelete = can('masters', 'delete')
  const chain = r.steps.map((s) => s.name)
  const preview = chain.length > 2 ? `${chain[0]} → … → ${chain[chain.length - 1]}` : chain.join(' → ')
  const where = whereSummary(orders)
  // Deleting is for a routing nothing uses; a shared one is looked after on the "All routings" tab.
  const deleteBlock = r.isLocked ? 'Unlock it first' : orders.length ? 'Orders were made with it: stop using it instead' : r.boms ? 'A BOM points at it: stop using it instead' : null

  const actions: RowAction[] = [
    { key: 'style', label: 'Open the style page', icon: <ExternalLink size={14} />, href: `/masters/routings/style/${g.style.id}` },
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
          <Toggle open={open} label={`the steps and orders of ${r.name}`} onToggle={onToggle} />
        </td>
        <StyleCell group={g} repeat={repeat} />
        <td>
          <div className="text-foreground truncate text-sm font-medium" title={r.name}>
            {r.name}
          </div>
          <div className="text-muted-foreground flex items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-[11px]">
            <span className="font-mono">v{r.version}</span>
            {r.fabric && <span>· {r.fabric}</span>}
            {shared && <span className="text-primary">· {shared}</span>}
          </div>
        </td>
        <td>
          <span className={status.badge}>{status.label}</span>
          <div className="text-muted-foreground mt-0.5 flex items-center gap-1 overflow-hidden whitespace-nowrap text-[11px]" title={status.sub}>
            {r.isLocked && (
              <span className="inline-flex items-center gap-0.5" title="Locked: nobody can change its steps">
                <Lock size={10} /> locked ·
              </span>
            )}
            {status.sub}
          </div>
        </td>
        <td>
          <div className="text-foreground text-sm tabular-nums">{plural(r.steps.length, 'step')}</div>
          <div className="text-muted-foreground truncate text-[11px]" title={chain.join(' → ')}>
            {preview || '—'}
          </div>
        </td>
        <OrdersCell orders={orders} />
        <td className="text-xs">
          {where ? (
            <span className="text-foreground line-clamp-2" title={where}>
              {where}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="text-xs">
          <div className="text-foreground">{formatDate(r.updatedAt)}</div>
          {r.updatedBy && (
            <div className="text-muted-foreground truncate" title={`by ${r.updatedBy}`}>
              by {r.updatedBy}
            </div>
          )}
        </td>
        <td className="whitespace-nowrap text-right">
          <div className="flex justify-end gap-1.5">
            {mayEdit && (
              <button className="btn-secondary h-7 w-7 p-0" onClick={onEdit} disabled={busy} title={`Edit ${r.name}`} aria-label={`Edit ${r.name}`}>
                <Pencil size={13} />
              </button>
            )}
            <ActionMenu label={`Actions for ${r.name}`} items={actions} />
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

/** A style's orders that have no routing yet: they take one when their steps are loaded. */
function WaitingRow({ line, repeat, first, open, onToggle }: { line: Extract<Line, { type: 'waiting' }>; repeat: boolean; first: boolean; open: boolean; onToggle: () => void }) {
  const running = line.orders.some((o) => o.open)
  return (
    <>
      <tr data-row tabIndex={first ? 0 : -1}>
        <td>
          <Toggle open={open} label="the orders not given a routing yet" onToggle={onToggle} />
        </td>
        <StyleCell group={line.group} repeat={repeat} />
        <td>
          <div className="text-muted-foreground truncate text-sm italic">No routing on the order yet</div>
          {running && line.takes && (
            <div className="text-muted-foreground truncate text-[11px]" title={line.takes.name}>
              will take {line.takes.name}
            </div>
          )}
        </td>
        <td>
          {running ? <span className="badge-info">Waiting</span> : <span className="badge-neutral">Without steps</span>}
          <div className="text-muted-foreground mt-0.5 truncate text-[11px]" title={running ? 'An order takes its steps once its materials are issued' : undefined}>
            {running ? 'on material issue' : 'made without a routing'}
          </div>
        </td>
        <td className="text-muted-foreground">—</td>
        <OrdersCell orders={line.orders} />
        <td className="text-xs">
          <span className="line-clamp-2">{whereSummary(line.orders) ?? <span className="text-muted-foreground">—</span>}</span>
        </td>
        <td className="text-muted-foreground">—</td>
        <td className="whitespace-nowrap text-right">
          {line.orders.length === 1 && (
            <Link href={`/production/orders?open=${line.orders[0].moId}`} className="btn-secondary h-7 px-2.5 text-xs">
              <ExternalLink size={13} /> Open
            </Link>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={COLS} className="bg-secondary/30 !p-0">
            <div className="sticky left-0 w-[100cqw] px-4 py-4">
              <p className={sectionTitle}>Orders not given a routing yet</p>
              <p className="text-muted-foreground mt-1 text-xs">
                An order is given the steps of its style&apos;s routing{line.takes ? ` (now "${line.takes.name}")` : ''} when its materials are issued, or from the order&apos;s own page.
              </p>
              <OrdersTable orders={line.orders} current={null} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

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
            None yet. A manufacturing order for this style is given its steps once its materials are issued
            {r.takesNew ? '' : ' — new orders take the routing marked "In use"'}.
          </p>
        ) : (
          <OrdersTable orders={orders} current={r.version} />
        )}
      </div>
    </div>
  )
}

/** Every order line: MO, sales order and customer, colour, pieces, the routing version it was given, and where it is. */
function OrdersTable({ orders, current }: { orders: StyleOrder[]; current: number | null }) {
  const th = 'px-2.5 py-1.5 font-semibold'
  const td = 'px-2.5 py-1.5'
  return (
    <div className="border-border mt-2 overflow-x-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-secondary text-muted-foreground text-left">
            <th className={th}>Order</th>
            <th className={th}>Sales order · customer</th>
            <th className={th}>Colour</th>
            <th className={cn(th, 'text-right')}>Pieces</th>
            {current != null && <th className={th}>Version</th>}
            <th className={th}>Where it is</th>
          </tr>
        </thead>
        <tbody className="divide-border/60 divide-y">
          {orders.map((o) => (
            <tr key={o.lineId}>
              <td className={cn(td, 'whitespace-nowrap')}>
                <Link href={`/production/orders?open=${o.moId}`} className="text-primary font-mono hover:underline">
                  {o.moNumber}
                </Link>
                <div className="text-muted-foreground text-[11px]">{MO_STATUS[o.status] ?? o.status}</div>
              </td>
              <td className={td}>
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
              <td className={cn(td, 'whitespace-nowrap')}>{o.color || '—'}</td>
              <td className={cn(td, 'whitespace-nowrap text-right tabular-nums')}>{o.planned.toLocaleString('en-IN')}</td>
              {current != null && (
                <td className={cn(td, 'whitespace-nowrap')}>
                  {o.routingVersion != null ? `v${o.routingVersion}` : '—'}
                  {o.routingVersion != null && o.routingVersion < current && <div className="warn-text text-[11px]">older steps</div>}
                </td>
              )}
              <td className={td}>{whereText(o)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
