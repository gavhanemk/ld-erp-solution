'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, ClipboardCheck, ExternalLink, Plus, Printer, RefreshCw, Scale, Search, Undo2 } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { formatDate } from '@/lib/utils'
import { useAppSettings } from '@/lib/appSettings'
import { Pagination } from '@/components/tables/Pagination'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { CountInDialog } from '@/components/production/floor/CountInDialog'
import { SettleDialog } from '@/components/production/floor/SettleDialog'
import { NewTransferDialog } from '@/components/production/floor/NewTransferDialog'
import { transferStatus } from '@/components/production/floor/transferStatus'
import { BoardView } from '@/components/production/floor/BoardView'
import { TransferDetailDialog, mayTakeBack, type TransferRow } from '@/components/production/floor/TransferDetailDialog'
import { pcs, sheetHref, type FlowTransfer } from '@/components/production/floor/types'

/**
 * Process transfers: every handover of a job card's bundles from one
 * department to the next, in the route's order — on our floor, counted in
 * where it arrives, or out to a unit on a job-work challan, back when the unit
 * returns the pieces. It opens on the board: each job card's route with where
 * its pieces are and what to do next. The other tabs are the transfer cards
 * themselves — what needs doing (to count in, short, at outside units) and
 * what is done; each row says in words where the transfer stands and has the
 * one button it needs.
 */

type View = 'board' | 'count' | 'short' | 'units' | 'received' | 'all'
const VIEWS: Array<{ key: View; label: string; empty: string }> = [
  { key: 'board', label: 'Job cards', empty: '' },
  { key: 'count', label: 'To count in', empty: 'Nothing is waiting to be counted in. Transfers sent from one department to the next show here until the receiving department counts them in.' },
  { key: 'short', label: 'Short', empty: 'No transfer is short. One that arrived with fewer pieces than were sent shows here until it is settled.' },
  { key: 'units', label: 'At outside units', empty: 'Nothing is with an outside unit.' },
  { key: 'received', label: 'Received', empty: 'Nothing received yet.' },
  { key: 'all', label: 'All', empty: 'No transfers yet. One is made each time a department sends a job card’s bundles on.' },
]

/** The choices for the dropdowns, as GET /production/transfers/filters gives them. */
interface FilterChoices {
  stages: Array<{ id: string; name: string }>
  customers: Array<{ id: string; name: string }>
  styles: Array<{ id: string; code: string; name: string }>
  orders: Array<{ id: string; moNumber: string; open: boolean; customer: string | null }>
  units: Array<{ id: string; name: string }>
}

/** Every dropdown on the screen. Customer and order apply to both the job cards and the transfer cards. */
interface Filters {
  customerId: string
  moId: string
  // The job cards.
  stage: string
  needs: string
  styleId: string
  due: string
  // The transfer cards.
  fromOp: string
  toOp: string
  unit: string
  from: string
  to: string
}
const NO_FILTERS: Filters = { customerId: '', moId: '', stage: '', needs: '', styleId: '', due: '', fromOp: '', toOp: '', unit: '', from: '', to: '' }
const BOARD_KEYS = ['customerId', 'moId', 'stage', 'needs', 'styleId', 'due'] as const
const CARD_KEYS = ['customerId', 'moId', 'fromOp', 'toOp', 'unit', 'from', 'to'] as const
const NEEDS: Array<[string, string]> = [
  ['count', 'To count in'],
  ['send', 'Ready to send on'],
  ['check', 'To check'],
  ['outside', 'At an outside unit'],
  ['decide', 'Damaged or in rework'],
  ['short', 'Short, to settle'],
  ['cutting', 'Cutting to issue or receive'],
  ['goods', 'Ready for finished goods'],
  ['putRight', 'Sent past a stage'],
  ['none', 'Nothing waiting'],
]
const DUE: Array<[string, string]> = [
  ['late', 'Late'],
  ['week', 'Due in 7 days'],
  ['month', 'Due in 30 days'],
]
const pick = (f: Filters, keys: readonly (keyof Filters)[]) => Object.fromEntries(keys.filter((k) => f[k]).map((k) => [k, f[k]]))
const selectCls = 'form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-40 sm:px-3 sm:text-xs'

export default function TransfersPage() {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<TransferRow[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<View, number> | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [detail, setDetail] = useState<TransferRow | null>(null)
  const [counting, setCounting] = useState<TransferRow | null>(null)
  const [settling, setSettling] = useState<TransferRow | null>(null)
  // Sent by mistake: the pieces go back to the department that sent them.
  const [takingBack, setTakingBack] = useState<TransferRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [choices, setChoices] = useState<FilterChoices | null>(null)
  const setFilter = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }))
  // Each view's filters, as the query its list is read with.
  const boardFilters = pick(filters, BOARD_KEYS)
  const cardQuery = new URLSearchParams(pick(filters, CARD_KEYS)).toString()
  const anyFilter = (view === 'board' ? BOARD_KEYS : CARD_KEYS).some((k) => !!filters[k])

  useEffect(() => {
    let alive = true
    api
      .get<{ data: FilterChoices }>('/production/transfers/filters')
      .then((r) => alive && setChoices(r.data))
      .catch(() => {
        // The dropdowns stay empty; the lists still work.
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setPage(1), [debounced, view, cardQuery])

  const loadCounts = useCallback(async () => {
    try {
      const res = await api.get<{ data: Record<View, number> }>(`/production/transfers/counts${cardQuery ? `?${cardQuery}` : ''}`)
      setCounts(res.data)
    } catch {
      // The tabs still work without their numbers.
    }
  }, [cardQuery])

  const load = useCallback(async () => {
    if (!view || view === 'board') return
    const ticket = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage), ...pick(filters, CARD_KEYS) })
      if (view !== 'all') qs.set('view', view)
      if (debounced) qs.set('q', debounced)
      const res = await api.get<Paginated<TransferRow>>(`/production/transfers?${qs}`)
      if (ticket !== latest.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof ApiError ? err.message : 'Could not load the process transfers.')
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
    // The card filters come in through cardQuery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, rowsPerPage, view, debounced, cardQuery])

  useEffect(() => {
    // Opens on the board; a link can open a tab of cards instead.
    const asked = new URLSearchParams(window.location.search).get('view') as View | null
    setView(asked && VIEWS.some((v) => v.key === asked) ? asked : 'board')
  }, [])
  // The tabs' numbers, read again whenever the card filters change.
  useEffect(() => {
    void loadCounts()
  }, [loadCounts])
  useEffect(() => {
    void load()
  }, [load])

  const saved = (m: string) => {
    setCounting(null)
    setSettling(null)
    setCreating(false)
    setDetail(null)
    setMessage(m)
    setRefreshKey((k) => k + 1)
    void load()
    void loadCounts()
  }
  const takeBack = async (t: TransferRow, reason: string) => {
    setBusy(true)
    try {
      const res = await api.post<{ message?: string }>(`/production/transfers/${t.id}/cancel`, { reason })
      setTakingBack(null)
      saved(res.message ?? 'Taken back.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not take it back.')
      setTakingBack(null)
    } finally {
      setBusy(false)
    }
  }
  const print = (t: TransferRow) => window.open(`/print/transfer/${t.id}`, '_blank', 'noopener')

  /** The one thing a transfer needs next, as a button. */
  const actionOf = (t: TransferRow) => {
    if (!t.vendor && (t.status === 'DISPATCHED' || t.status === 'PARTLY_RECEIVED') && can('production', 'create')) {
      return (
        <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => setCounting(t)}>
          <ClipboardCheck size={14} /> Count in
        </button>
      )
    }
    if (t.status === 'DISCREPANCY' && can('production', 'edit')) {
      return (
        <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => setSettling(t)}>
          <Scale size={14} /> Settle
        </button>
      )
    }
    if (t.vendor && (t.status === 'DISPATCHED' || t.status === 'PARTLY_RECEIVED') && t.jobCard) {
      return (
        <a className="btn-secondary h-8 px-3 text-xs" href={sheetHref(t.jobCard.id, t.toStep.id)} title="Record what came back, on the stage's sheet">
          <ExternalLink size={14} /> Record return
        </a>
      )
    }
    return null
  }

  const current = VIEWS.find((v) => v.key === view) ?? VIEWS[0]
  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title text-xl sm:text-2xl">Process Transfers</h1>
          <p className="page-subtitle hidden sm:block">Bundles handed from one stage to the next, in the route&apos;s order — counted in where they arrive, or out to an outside unit and back</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost"
            onClick={() => {
              setRefreshKey((k) => k + 1)
              void load()
              void loadCounts()
            }}
            disabled={loading}
            aria-label="Refresh"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {can('production', 'create') && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> New transfer
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        {/* Tabs: what needs doing first, then what is done. */}
        <div className="border-border flex gap-1 overflow-x-auto border-b px-2 pt-2" role="tablist">
          {VIEWS.map((v) => {
            const on = v.key === view
            const n = counts?.[v.key]
            const urgent = (v.key === 'count' || v.key === 'short') && !!n
            return (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setView(v.key)}
                className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm ${on ? 'border-primary text-primary font-semibold' : 'text-muted-foreground hover:text-foreground border-transparent'}`}
              >
                {v.label}
                {n != null && (
                  <span
                    className={`rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${urgent ? (v.key === 'short' ? 'bg-destructive text-white' : 'bg-primary text-primary-foreground') : 'bg-secondary text-foreground'}`}
                  >
                    {n}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="bg-field border-field-edge flex min-w-[200px] max-w-md flex-1 items-center gap-2 rounded-lg border px-3 py-1.5">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder={view === 'board' ? 'Search job card, order, style, colour or customer…' : 'Search transfer no., job card, order, bundle, department or unit…'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
            />
          </div>
          {view !== 'board' && (
            <span className="text-muted-foreground ml-auto text-xs">
              {total} {total === 1 ? 'transfer' : 'transfers'}
            </span>
          )}
        </div>

        {/* Dropdown filters: the job cards' own, or the transfer cards' own; customer and order go with both. */}
        <div className="border-border grid grid-cols-2 gap-2 border-b px-4 py-2.5 sm:flex sm:flex-wrap sm:items-center">
          {view === 'board' ? (
            <>
              <SmartSelect className={selectCls} value={filters.stage} onChange={(e) => setFilter('stage', e.target.value)} aria-label="Filter by stage">
                <option value="">All stages</option>
                {choices?.stages.map((s) => (
                  <option key={s.id} value={s.id} data-sub="Pieces there now">
                    {s.name}
                  </option>
                ))}
              </SmartSelect>
              <SmartSelect className={selectCls} value={filters.needs} onChange={(e) => setFilter('needs', e.target.value)} aria-label="Filter by what needs doing">
                <option value="">Anything to do</option>
                {NEEDS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </SmartSelect>
            </>
          ) : (
            <>
              <SmartSelect className={selectCls} value={filters.fromOp} onChange={(e) => setFilter('fromOp', e.target.value)} aria-label="Filter by the stage it left">
                <option value="">From any stage</option>
                {choices?.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    From {s.name}
                  </option>
                ))}
              </SmartSelect>
              <SmartSelect className={selectCls} value={filters.toOp} onChange={(e) => setFilter('toOp', e.target.value)} aria-label="Filter by the stage it went to">
                <option value="">To any stage</option>
                {choices?.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    To {s.name}
                  </option>
                ))}
              </SmartSelect>
              <SmartSelect className={selectCls} value={filters.unit} onChange={(e) => setFilter('unit', e.target.value)} aria-label="Filter by outside unit">
                <option value="">Our floor and outside</option>
                <option value="none">Our floor only</option>
                <option value="any">Any outside unit</option>
                {choices?.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </SmartSelect>
            </>
          )}
          <SmartSelect className={selectCls} value={filters.customerId} onChange={(e) => setFilter('customerId', e.target.value)} aria-label="Filter by customer">
            <option value="">All customers</option>
            {choices?.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SmartSelect>
          <SmartSelect className={selectCls} value={filters.moId} onChange={(e) => setFilter('moId', e.target.value)} aria-label="Filter by order">
            <option value="">All orders</option>
            {choices?.orders
              .filter((o) => (view === 'board' ? o.open : true) && (!filters.customerId || o.customer === choices.customers.find((c) => c.id === filters.customerId)?.name))
              .map((o) => (
                <option key={o.id} value={o.id} data-sub={[o.customer, o.open ? null : 'closed'].filter(Boolean).join(' · ') || undefined}>
                  {o.moNumber}
                </option>
              ))}
          </SmartSelect>
          {view === 'board' ? (
            <>
              <SmartSelect className={selectCls} value={filters.styleId} onChange={(e) => setFilter('styleId', e.target.value)} aria-label="Filter by style">
                <option value="">All styles</option>
                {choices?.styles.map((s) => (
                  <option key={s.id} value={s.id} data-sub={s.name}>
                    {s.code}
                  </option>
                ))}
              </SmartSelect>
              <SmartSelect className={selectCls} value={filters.due} onChange={(e) => setFilter('due', e.target.value)} aria-label="Filter by due date">
                <option value="">Any due date</option>
                {DUE.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </SmartSelect>
            </>
          ) : (
            <div className="col-span-2 flex items-center gap-1 sm:col-span-1">
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[11px] sm:w-[8rem] sm:flex-none sm:px-3 sm:text-xs"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(e) => setFilter('from', e.target.value)}
                aria-label="Sent from"
              />
              <span className="text-muted-foreground text-xs">to</span>
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[11px] sm:w-[8rem] sm:flex-none sm:px-3 sm:text-xs"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(e) => setFilter('to', e.target.value)}
                aria-label="Sent to"
              />
            </div>
          )}
          {anyFilter && (
            <button
              type="button"
              className="btn-ghost h-8 px-2 text-xs"
              onClick={() => setFilters((f) => ({ ...f, ...Object.fromEntries((view === 'board' ? BOARD_KEYS : CARD_KEYS).map((k) => [k, ''])) }))}
            >
              Clear filters
            </button>
          )}
        </div>

        {view === 'board' ? (
          <BoardView
            search={debounced}
            filters={boardFilters}
            refreshKey={refreshKey}
            onSaved={(m) => {
              setMessage(m)
              void loadCounts()
            }}
          />
        ) : loading && !rows.length ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : !rows.length ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">{debounced || anyFilter ? 'No transfer matches that search and these filters.' : current.empty}</p>
        ) : (
          <>
            {/* Wide screens: a table. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>Transfer</th>
                    <th>Job card</th>
                    <th>From → to</th>
                    <th style={{ textAlign: 'right' }}>Pieces</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    const st = transferStatus(t)
                    const sent = t.lines.reduce((s, l) => s + l.dispatchedQty, 0)
                    const got = t.lines.reduce((s, l) => s + l.receivedQty, 0)
                    const short = t.lines.reduce((s, l) => s + l.shortQty - l.settledQty, 0)
                    return (
                      <tr key={t.id} className={`cursor-pointer ${t.status === 'CANCELLED' ? 'opacity-60' : ''}`} onClick={() => setDetail(t)}>
                        <td>
                          <span className="text-foreground font-mono text-xs font-semibold">{t.transferNumber}</span>
                          <span className="text-muted-foreground block text-[11px]">
                            {formatDate(t.dispatchDate)}
                            {t.issuedBy ? ` · by ${t.issuedBy}` : ''}
                          </span>
                        </td>
                        <td>
                          <span className="text-primary font-mono text-xs">{t.jobCard?.jobCardNumber ?? t.mo.moNumber}</span>
                          <span className="text-muted-foreground block text-[11px]">
                            {t.jobCard ? `${t.jobCard.moLine.style.code} · ${t.jobCard.moLine.color}` : ''}
                            {t.mo.so ? ` · ${t.mo.so.customer.name}` : ''}
                          </span>
                        </td>
                        <td className="text-xs">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-foreground font-medium">{t.fromStep.name}</span>
                            <ArrowRight size={12} className="text-muted-foreground" />
                            <span className="text-foreground font-medium">{t.toStep.name}</span>
                          </span>
                          {t.vendor && <span className="text-muted-foreground block text-[11px]">at {t.vendor.name} (outside unit)</span>}
                          {!!t.passed?.length && <span className="warn-text block text-[11px]">Passed {t.passed.join(', ')}: take it back</span>}
                        </td>
                        <td className="text-right text-xs tabular-nums">
                          <span className="text-foreground font-semibold">{pcs(sent)}</span>
                          <span className="text-muted-foreground"> in {t.lines.length}</span>
                          {(got > 0 || short > 0) && (
                            <span className={`block text-[11px] ${short ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {short ? `${pcs(short)} short` : `${pcs(got)} ${t.vendor ? 'back' : 'counted in'}`}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={st.cls}>{st.label}</span>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <span className="flex items-center justify-end gap-1">
                            {actionOf(t)}
                            <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => print(t)} aria-label={`Print ${t.transferNumber}`} title="Print the card">
                              <Printer size={14} />
                            </button>
                            {can('production', 'edit') && mayTakeBack(t) && (t.passed?.length || (t.status === 'DISPATCHED' && !got)) && (
                              <button
                                type="button"
                                className={`h-8 px-2 text-xs ${t.passed?.length ? 'btn-secondary' : 'btn-ghost text-muted-foreground hover:text-destructive'}`}
                                onClick={() => setTakingBack(t)}
                                title="The pieces go back to the department that sent them"
                              >
                                <Undo2 size={14} /> Take back
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Phones: a card each. */}
            <div className="divide-border/60 divide-y md:hidden">
              {rows.map((t) => {
                const st = transferStatus(t)
                const sent = t.lines.reduce((s, l) => s + l.dispatchedQty, 0)
                return (
                  <div key={t.id} className={`space-y-1.5 px-4 py-3 ${t.status === 'CANCELLED' ? 'opacity-60' : ''}`} onClick={() => setDetail(t)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold">{t.transferNumber}</span>
                      <span className={st.cls}>{st.label}</span>
                    </div>
                    <p className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-medium">{t.fromStep.name}</span> <ArrowRight size={12} /> <span className="font-medium">{t.toStep.name}</span>
                      {t.vendor && <span className="text-muted-foreground text-xs">at {t.vendor.name}</span>}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t.jobCard ? `${t.jobCard.jobCardNumber} · ${t.jobCard.moLine.style.code} ${t.jobCard.moLine.color}` : t.mo.moNumber} · {pcs(sent)} pcs · {formatDate(t.dispatchDate)}
                    </p>
                    {!!t.passed?.length && <p className="warn-text text-xs">Passed {t.passed.join(', ')}: take it back</p>}
                    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      {actionOf(t)}
                      <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => print(t)}>
                        <Printer size={14} /> Print
                      </button>
                      {can('production', 'edit') && mayTakeBack(t) && (t.passed?.length || t.status === 'DISPATCHED') && (
                        <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={() => setTakingBack(t)}>
                          <Undo2 size={14} /> Take back
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
        {view !== 'board' && <Pagination page={page} pages={Math.ceil(total / rowsPerPage) || 1} onPageChange={setPage} busy={loading} />}
      </div>

      {detail && (
        <TransferDetailDialog
          t={detail}
          onClose={() => setDetail(null)}
          onCountIn={() => {
            setCounting(detail)
            setDetail(null)
          }}
          onSettle={() => {
            setSettling(detail)
            setDetail(null)
          }}
          onTakeBack={() => {
            setTakingBack(detail)
            setDetail(null)
          }}
        />
      )}
      {counting && <CountInDialog transfer={counting as unknown as FlowTransfer} moNumber={counting.mo.moNumber} onClose={() => setCounting(null)} onSaved={saved} />}
      {settling && <SettleDialog transfer={settling as unknown as FlowTransfer} onClose={() => setSettling(null)} onSaved={saved} />}
      {creating && (
        <NewTransferDialog
          onClose={() => setCreating(false)}
          onSaved={(m, transferId) => {
            saved(m)
            if (transferId) window.open(`/print/transfer/${transferId}`, '_blank', 'noopener')
          }}
        />
      )}
      {takingBack && (
        <ReasonDialog
          title={`Take back ${takingBack.transferNumber}?`}
          description={`The pieces go back to ${takingBack.fromStep.name}, as if never sent${
            takingBack.lines.some((l) => l.receivedQty > 0) ? `; the count-in at ${takingBack.toStep.name} is undone first, refused if ${takingBack.toStep.name} has already worked on them` : ''
          }. From there, send them on to the next stage in order.`}
          confirmLabel="Take it back"
          danger
          busy={busy}
          onCancel={() => setTakingBack(null)}
          onConfirm={(reason) => void takeBack(takingBack, reason)}
        />
      )}
    </div>
  )
}
