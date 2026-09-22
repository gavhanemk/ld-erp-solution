'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { AlertCircle, Ban, CheckCircle2, FileMinus, RefreshCw, Search, Send } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { RowPanel } from '@/components/tables/RowPanel'
import { formatDate } from '@/lib/utils'

/**
 * What the mill is claiming back from its suppliers.
 *
 * These were being raised correctly and were visible only in the database:
 * the bill form sends a rate charged above the order to a draft note, and
 * nothing after that could list one, read it or send it. A claim nobody can
 * see is a claim nobody makes.
 */

interface NoteLine {
  id: string
  description: string | null
  hsnCode: string | null
  qty: string | number
  unitPrice: string | number
  taxableValue: string | number
  gstRate: string | number
  amount: string | number
  item: { id: string; code: string; name: string; uom: { symbol: string } | null }
}

interface DebitNote {
  id: string
  noteNumber: string
  noteDate: string
  reason: string | null
  subtotal: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  totalAmount: string | number
  status: 'DRAFT' | 'ISSUED' | 'ADJUSTED' | 'CANCELLED'
  notes: string | null
  supplier: { id: string; code: string; name: string; gstin: string | null }
  bill: { id: string; billNumber: string; supplierInvoiceNo: string | null } | null
  lines: NoteLine[]
}

const STATUS: Record<DebitNote['status'], { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-info' },
  ISSUED: { label: 'Sent', cls: 'badge-warning' },
  ADJUSTED: { label: 'Settled', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const PER_PAGE = 25

export default function DebitNotesPage() {
  const [rows, setRows] = useState<DebitNote[]>([])
  const [summary, setSummary] = useState<Record<string, { count: number; amount: number }>>({})
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    void (async () => {
      try {
        const list = await masterResource<{ id: string; name: string }>('suppliers').list({
          limit: 500,
        })
        setSuppliers([...list.data].sort((a, b) => a.name.localeCompare(b.name)))
      } catch {
        // The filter comes up empty; the list still loads.
      }
    })()
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(PER_PAGE) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      if (supplierId) qs.set('supplierId', supplierId)
      if (fromDate) qs.set('from', fromDate)
      if (toDate) qs.set('to', toDate)
      const res = await api.get<
        Paginated<DebitNote> & { summary: Record<string, { count: number; amount: number }> }
      >(`/purchase/debit-notes?${qs}`)
      setRows(res.data)
      setSummary(res.summary ?? {})
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing debit notes.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
    } finally {
      setLoading(false)
    }
  }, [page, debounced, status, supplierId, fromDate, toDate])

  useEffect(() => {
    void load()
  }, [load])

  // Narrowing a filter while on page three would show an empty page three.
  useEffect(() => {
    setPage(1)
  }, [debounced, status, supplierId, fromDate, toDate])

  const anyFilter = Boolean(search || status || supplierId || fromDate || toDate)

  const act = async (note: DebitNote, what: 'issue' | 'settle' | 'cancel') => {
    if (what === 'issue') {
      const ok = confirm(
        `Send ${note.noteNumber} to ${note.supplier.name}?\n\n` +
          `It claims ₹${money(note.totalAmount)} back from them. A debit note leaves the ` +
          `building because a person decided it should, so this is the press that does it.`
      )
      if (!ok) return
    }
    let reason: string | null = null
    if (what === 'cancel') {
      if (!confirm(`Cancel ${note.noteNumber}? The claim is dropped.`)) return
      reason = prompt('Why is it being cancelled? (optional)') ?? null
    }

    setBusy(true)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(
        `/purchase/debit-notes/${note.id}/${what}`,
        what === 'cancel' ? { reason: reason ?? undefined } : {}
      )
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const rowActions = (n: DebitNote): RowAction[] => {
    const items: RowAction[] = []
    if (n.status === 'DRAFT') {
      items.push({
        key: 'issue',
        label: 'Send to supplier',
        icon: <Send size={14} />,
        onClick: () => void act(n, 'issue'),
      })
    }
    if (n.status === 'ISSUED') {
      items.push({
        key: 'settle',
        label: 'Mark settled',
        icon: <CheckCircle2 size={14} />,
        onClick: () => void act(n, 'settle'),
      })
    }
    if (n.status !== 'CANCELLED' && n.status !== 'ADJUSTED') {
      items.push({
        key: 'cancel',
        label: 'Cancel note',
        icon: <Ban size={14} />,
        danger: true,
        onClick: () => void act(n, 'cancel'),
      })
    }
    return items
  }

  const openClaim = (summary.DRAFT?.amount ?? 0) + (summary.ISSUED?.amount ?? 0)

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">Debit Notes</h1>
          <p className="page-subtitle hidden sm:block">
            What you are claiming back from your suppliers
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="glass-card p-3">
          <p className="text-muted-foreground text-xs">Still to send</p>
          <p className="text-foreground mt-1 text-lg font-semibold">{summary.DRAFT?.count ?? 0}</p>
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            ₹{money(summary.DRAFT?.amount ?? 0)} drafted
          </p>
        </div>
        <div className="glass-card p-3">
          <p className="text-muted-foreground text-xs">Sent, not settled</p>
          <p className="mt-1 text-lg font-semibold text-amber-400">{summary.ISSUED?.count ?? 0}</p>
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            ₹{money(summary.ISSUED?.amount ?? 0)} outstanding
          </p>
        </div>
        <div className="glass-card p-3">
          <p className="text-muted-foreground text-xs">Claimed in all</p>
          <p className="text-foreground mt-1 text-lg font-semibold">₹{money(openClaim)}</p>
          <p className="text-muted-foreground mt-0.5 text-[11px]">drafted and sent together</p>
        </div>
        <div className="glass-card p-3">
          <p className="text-muted-foreground text-xs">Settled</p>
          <p className="mt-1 text-lg font-semibold text-emerald-400">
            {summary.ADJUSTED?.count ?? 0}
          </p>
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            ₹{money(summary.ADJUSTED?.amount ?? 0)} credited back
          </p>
        </div>
      </div>

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-3 py-2">
          <div className="border-border bg-secondary flex min-w-0 shrink grow basis-full items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:min-w-[150px] sm:max-w-[240px] sm:basis-0">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Note number, supplier, or reason..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search debit notes"
            />
          </div>
          <select
            className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-32"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">Any status</option>
            {Object.entries(STATUS).map(([v, s]) => (
              <option key={v} value={v}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            className="form-input h-8 w-full min-w-0 py-0 text-xs sm:w-44"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            aria-label="Filter by supplier"
          >
            <option value="">All suppliers</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="flex w-full min-w-0 shrink-0 items-center gap-1.5 sm:w-auto">
            <span className="text-muted-foreground shrink-0 text-xs">Raised</span>
            <input
              type="date"
              className="form-input h-8 min-w-0 flex-1 py-0 text-xs sm:w-[8.5rem] sm:flex-none"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => setFromDate(e.target.value)}
              aria-label="Raised on or after"
            />
            <span className="text-muted-foreground shrink-0 text-xs">to</span>
            <input
              type="date"
              className="form-input h-8 min-w-0 flex-1 py-0 text-xs sm:w-[8.5rem] sm:flex-none"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => setToDate(e.target.value)}
              aria-label="Raised on or before"
            />
          </div>
          {anyFilter && (
            <button
              className="btn-ghost h-8 shrink-0 px-2 text-xs"
              onClick={() => {
                setSearch('')
                setStatus('')
                setSupplierId('')
                setFromDate('')
                setToDate('')
              }}
            >
              Clear
            </button>
          )}
          <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
            {total} {total === 1 ? 'note' : 'notes'}
          </span>
        </div>

        {loading ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <FileMinus size={22} className="text-muted-foreground mx-auto" />
            <p className="text-foreground mt-2 text-sm font-medium">
              {anyFilter ? 'Nothing matches that' : 'No debit notes'}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {anyFilter
                ? 'Clear the filters to see every note.'
                : 'One is raised for you whenever a supplier bills above the rate the order agreed. Book a bill with a higher rate and accept it to see one here.'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            {/* Below 700px of container the columns cannot be made to read, so
              each note becomes a card. Without this the table is simply
              `display: none` and the screen is blank on a phone. */}
            <div className="list-cards divide-border divide-y">
              {rows.map((n) => {
                const open = expanded === n.id
                const actions = rowActions(n)
                return (
                  <div key={n.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <span className="text-foreground font-mono text-xs font-semibold">
                          {n.noteNumber}
                        </span>
                        <p className="text-foreground mt-1 font-medium leading-snug">
                          {n.supplier.name}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className="text-foreground block font-semibold tabular-nums">
                          ₹{money(n.totalAmount)}
                        </span>
                        <span className={`${STATUS[n.status].cls} mt-1 inline-block`}>
                          {STATUS[n.status].label}
                        </span>
                      </div>
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Raised</dt>
                      <dd className="text-foreground min-w-0">{formatDate(n.noteDate)}</dd>
                      <dt className="text-muted-foreground">Against</dt>
                      <dd className="text-foreground min-w-0 font-mono">
                        {n.bill?.billNumber ?? '—'}
                      </dd>
                      <dt className="text-muted-foreground">Reason</dt>
                      <dd className="text-foreground min-w-0">{n.reason ?? '—'}</dd>
                    </dl>

                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={() => setExpanded(open ? null : n.id)}
                        className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                        aria-expanded={open}
                      >
                        {open ? 'Hide' : 'Show'} {n.lines.length}{' '}
                        {n.lines.length === 1 ? 'line' : 'lines'}
                      </button>
                      {actions.length > 0 && (
                        <ActionMenu label={`Actions for ${n.noteNumber}`} items={actions} />
                      )}
                    </div>

                    {open && (
                      <ul className="border-border mt-3 space-y-1.5 border-t pt-2.5">
                        {n.lines.map((l) => (
                          <li key={l.id} className="flex justify-between gap-3 text-xs">
                            <span className="text-foreground min-w-0">
                              {l.item.name}
                              <span className="text-muted-foreground block">
                                {Number(l.qty).toLocaleString('en-IN')}
                                {l.item.uom?.symbol ? ` ${l.item.uom.symbol}` : ''} × ₹
                                {money(l.unitPrice)}
                              </span>
                            </span>
                            <span className="text-foreground shrink-0 tabular-nums">
                              ₹{money(l.amount)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="list-rows">
              <table className="w-full">
                <thead>
                  <tr>
                    <th style={{ width: '2.5rem' }} />
                    <th>Note No.</th>
                    <th>Supplier</th>
                    <th className="col-wide">Against bill</th>
                    <th className="col-roomy">Raised</th>
                    <th className="col-full">Reason</th>
                    <th style={{ textAlign: 'right' }}>Claimed</th>
                    <th>Status</th>
                    <th style={{ width: '6rem' }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((n) => {
                    const open = expanded === n.id
                    const actions = rowActions(n)
                    return (
                      <Fragment key={n.id}>
                        <tr>
                          <td>
                            <button
                              onClick={() => setExpanded(open ? null : n.id)}
                              className="text-muted-foreground hover:text-foreground"
                              aria-expanded={open}
                              aria-label={`${open ? 'Hide' : 'Show'} what ${n.noteNumber} claims`}
                            >
                              {open ? '−' : '+'}
                            </button>
                          </td>
                          <td className="font-mono text-xs text-teal-400">{n.noteNumber}</td>
                          <td className="text-foreground">{n.supplier.name}</td>
                          <td className="col-wide font-mono text-xs">
                            {n.bill?.billNumber ?? <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="col-roomy whitespace-nowrap text-xs">
                            {formatDate(n.noteDate)}
                          </td>
                          <td className="col-full text-muted-foreground text-xs">
                            {n.reason ?? '—'}
                          </td>
                          <td className="text-foreground text-right font-medium tabular-nums">
                            ₹{money(n.totalAmount)}
                          </td>
                          <td>
                            <span className={STATUS[n.status].cls}>{STATUS[n.status].label}</span>
                          </td>
                          <td className="whitespace-nowrap">
                            {actions.length > 0 && (
                              <ActionMenu label={`Actions for ${n.noteNumber}`} items={actions} />
                            )}
                          </td>
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={9} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <RowPanel
                                icon={FileMinus}
                                title="What is claimed"
                                note={`${n.lines.length} ${n.lines.length === 1 ? 'line' : 'lines'} on ${n.noteNumber}`}
                              >
                                <table className="subtable w-full">
                                  <thead>
                                    <tr>
                                      <th>Item</th>
                                      <th style={{ textAlign: 'right' }}>Qty</th>
                                      <th style={{ textAlign: 'right' }}>Rate</th>
                                      <th style={{ textAlign: 'right' }}>Taxable</th>
                                      <th style={{ textAlign: 'right' }}>GST %</th>
                                      <th style={{ textAlign: 'right' }}>Amount</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {n.lines.map((l) => (
                                      <tr key={l.id}>
                                        <td>
                                          {l.item.name}
                                          <span className="text-muted-foreground ml-1.5 font-mono text-[10px]">
                                            {l.item.code}
                                          </span>
                                        </td>
                                        <td className="text-right tabular-nums">
                                          {Number(l.qty).toLocaleString('en-IN')}
                                          {l.item.uom?.symbol ? ` ${l.item.uom.symbol}` : ''}
                                        </td>
                                        <td className="text-right tabular-nums">
                                          ₹{money(l.unitPrice)}
                                        </td>
                                        <td className="text-right tabular-nums">
                                          ₹{money(l.taxableValue)}
                                        </td>
                                        <td className="text-right tabular-nums">
                                          {Number(l.gstRate)}%
                                        </td>
                                        <td className="text-right tabular-nums">
                                          ₹{money(l.amount)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                {n.notes && (
                                  <p className="text-muted-foreground mt-2 whitespace-pre-line px-1 text-xs">
                                    {n.notes}
                                  </p>
                                )}
                              </RowPanel>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Pagination
        page={page}
        pages={Math.max(1, Math.ceil(total / PER_PAGE))}
        onPageChange={setPage}
        busy={loading || busy}
      />
    </div>
  )
}
