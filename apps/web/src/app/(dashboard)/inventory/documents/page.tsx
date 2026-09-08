'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import {
  Search,
  RefreshCw,
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  ArrowRight,
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { formatDate } from '@/lib/utils'

/**
 * The stock documents: what was moved between stores, and what was corrected
 * after a count.
 *
 * Both used to leave nothing behind but ledger rows tagged with the clock, so
 * "what did we move last month" and "who changed that figure, and why" had no
 * answer anywhere in the system. This screen is that answer.
 */

interface Line {
  id: string
  item: { id: string; code: string; name: string; uom: { symbol: string } | null }
}

interface TransferLine extends Line {
  qty: string | number
  unitRate: string | number | null
}

interface AdjustmentLine extends Line {
  bookQty: string | number
  countedQty: string | number
  difference: string | number
}

interface Transfer {
  id: string
  transferNumber: string
  transferDate: string
  notes: string | null
  fromWarehouse: { id: string; name: string }
  toWarehouse: { id: string; name: string }
  movedBy: { id: string; name: string } | null
  cancelledAt: string | null
  cancelledBy: { id: string; name: string } | null
  cancelReason: string | null
  lines: TransferLine[]
}

interface Adjustment {
  id: string
  adjustmentNumber: string
  adjustmentDate: string
  reason: string
  warehouse: { id: string; name: string }
  madeBy: { id: string; name: string } | null
  lines: AdjustmentLine[]
}

type Kind = 'transfers' | 'adjustments'

const qty = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

export default function StockDocumentsPage() {
  const [kind, setKind] = useState<Kind>('transfers')
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [adjustments, setAdjustments] = useState<Adjustment[]>([])
  const [total, setTotal] = useState(0)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: '50' })
      if (debounced) qs.set('q', debounced)

      if (kind === 'transfers') {
        const res = await api.get<Paginated<Transfer>>(`/inventory/transfers?${qs}`)
        setTransfers(res.data)
        setTotal(res.pagination.total)
      } else {
        const res = await api.get<Paginated<Adjustment>>(`/inventory/adjustments?${qs}`)
        setAdjustments(res.data)
        setTotal(res.pagination.total)
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing stock documents.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setTransfers([])
      setAdjustments([])
    } finally {
      setLoading(false)
    }
  }, [debounced, kind])

  useEffect(() => {
    void load()
  }, [load])

  const cancel = async (t: Transfer) => {
    const reason = prompt(
      `Why is ${t.transferNumber} being cancelled?\n\nThe goods will be moved back to ${t.fromWarehouse.name}.`
    )
    if (!reason || reason.trim().length < 5) return

    setBusy(t.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/transfers/${t.id}/cancel`, {
        reason: reason.trim(),
      })
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
    } finally {
      setBusy(null)
    }
  }

  const rows = kind === 'transfers' ? transfers : adjustments
  const noun = kind === 'transfers' ? 'transfers' : 'adjustments'

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock Documents</h1>
          <p className="page-subtitle">
            What was moved between stores, and what was corrected after a count
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

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="border-border bg-secondary flex gap-1 rounded-lg border p-1">
            {(['transfers', 'adjustments'] as Kind[]).map((k) => (
              <button
                key={k}
                className={
                  k === kind
                    ? 'bg-primary text-primary-foreground rounded-lg px-3 py-1 text-xs font-semibold'
                    : 'text-muted-foreground rounded-lg px-3 py-1 text-xs'
                }
                onClick={() => {
                  setKind(k)
                  setOpen(null)
                }}
              >
                {k === 'transfers' ? 'Transfers' : 'Adjustments'}
              </button>
            ))}
          </div>

          <div className="border-border bg-secondary flex min-w-[200px] max-w-sm flex-1 items-center gap-2 rounded-lg border px-3 py-2">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder={kind === 'transfers' ? 'Search number...' : 'Search number or reason...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={`Search ${noun}`}
            />
          </div>
          <span className="text-muted-foreground ml-auto text-xs">
            {total} {noun}
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              {kind === 'transfers'
                ? 'Nothing moved between stores yet. Move stock from the Stock screen and the note will appear here.'
                : 'No counts recorded yet. Correct a figure from the Stock screen and the count sheet will appear here.'}
            </p>
          </div>
        ) : kind === 'transfers' ? (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th style={{ width: 30 }} />
                  <th>Number</th>
                  <th>Moved</th>
                  <th>From</th>
                  <th>To</th>
                  <th style={{ textAlign: 'right' }}>Items</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => {
                  const expanded = open === t.id
                  return (
                    <Fragment key={t.id}>
                      <tr>
                        <td>
                          <button
                            className="btn-ghost p-1"
                            onClick={() => setOpen(expanded ? null : t.id)}
                            aria-label={expanded ? 'Hide items' : 'Show items'}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                        <td className="font-mono text-xs text-teal-400">{t.transferNumber}</td>
                        <td className="text-xs">
                          {formatDate(t.transferDate)}
                          {t.movedBy && (
                            <div className="text-muted-foreground text-[10px]">
                              by {t.movedBy.name}
                            </div>
                          )}
                        </td>
                        <td className="text-sm">{t.fromWarehouse.name}</td>
                        <td className="text-sm">
                          <span className="flex items-center gap-1">
                            <ArrowRight size={13} className="text-muted-foreground" />
                            {t.toWarehouse.name}
                          </span>
                        </td>
                        <td className="text-right text-sm tabular-nums">{t.lines.length}</td>
                        <td>
                          {t.cancelledAt ? (
                            <>
                              <span className="badge-neutral">Cancelled</span>
                              {t.cancelReason && (
                                <div className="text-muted-foreground max-w-[200px] truncate text-[10px]">
                                  {t.cancelReason}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="badge-success">Moved</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {!t.cancelledAt && (
                            <button
                              className="btn-ghost p-1.5 hover:text-red-400"
                              onClick={() => void cancel(t)}
                              disabled={busy === t.id}
                              title="Cancel and move the goods back"
                              aria-label={`Cancel ${t.transferNumber}`}
                            >
                              <Ban size={15} />
                            </button>
                          )}
                        </td>
                      </tr>

                      {expanded && (
                        <tr>
                          <td colSpan={8} className="bg-secondary/40 p-0">
                            <table className="data-table w-full">
                              <thead>
                                <tr>
                                  <th>Item</th>
                                  <th style={{ textAlign: 'right' }}>Quantity</th>
                                  <th style={{ textAlign: 'right' }}>Carried at</th>
                                </tr>
                              </thead>
                              <tbody>
                                {t.lines.map((l) => (
                                  <tr key={l.id}>
                                    <td>
                                      <div className="text-sm">{l.item.name}</div>
                                      <div className="text-muted-foreground font-mono text-[10px]">
                                        {l.item.code}
                                      </div>
                                    </td>
                                    <td className="text-right text-sm tabular-nums">
                                      {qty(l.qty)} {l.item.uom?.symbol ?? ''}
                                    </td>
                                    <td className="text-right text-sm tabular-nums">
                                      {l.unitRate === null ? '—' : qty(l.unitRate)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {t.notes && (
                              <p className="text-muted-foreground px-4 py-2 text-xs">{t.notes}</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th style={{ width: 30 }} />
                  <th>Number</th>
                  <th>Counted</th>
                  <th>Store</th>
                  <th>Why</th>
                  <th style={{ textAlign: 'right' }}>Counted</th>
                  <th style={{ textAlign: 'right' }}>Corrected</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a) => {
                  const expanded = open === a.id
                  const changed = a.lines.filter((l) => Number(l.difference) !== 0).length

                  return (
                    <Fragment key={a.id}>
                      <tr>
                        <td>
                          <button
                            className="btn-ghost p-1"
                            onClick={() => setOpen(expanded ? null : a.id)}
                            aria-label={expanded ? 'Hide items' : 'Show items'}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                        <td className="font-mono text-xs text-teal-400">{a.adjustmentNumber}</td>
                        <td className="text-xs">
                          {formatDate(a.adjustmentDate)}
                          {a.madeBy && (
                            <div className="text-muted-foreground text-[10px]">
                              by {a.madeBy.name}
                            </div>
                          )}
                        </td>
                        <td className="text-sm">{a.warehouse.name}</td>
                        <td className="text-muted-foreground max-w-[260px] text-xs">{a.reason}</td>
                        <td className="text-right text-sm tabular-nums">{a.lines.length}</td>
                        <td className="text-right">
                          {changed > 0 ? (
                            <span className="badge-warning">{changed}</span>
                          ) : (
                            <span className="badge-success">all matched</span>
                          )}
                        </td>
                      </tr>

                      {expanded && (
                        <tr>
                          <td colSpan={7} className="bg-secondary/40 p-0">
                            <table className="data-table w-full">
                              <thead>
                                <tr>
                                  <th>Item</th>
                                  <th style={{ textAlign: 'right' }}>Book said</th>
                                  <th style={{ textAlign: 'right' }}>Counted</th>
                                  <th style={{ textAlign: 'right' }}>Difference</th>
                                </tr>
                              </thead>
                              <tbody>
                                {a.lines.map((l) => {
                                  const d = Number(l.difference)
                                  return (
                                    <tr key={l.id}>
                                      <td>
                                        <div className="text-sm">{l.item.name}</div>
                                        <div className="text-muted-foreground font-mono text-[10px]">
                                          {l.item.code}
                                        </div>
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {qty(l.bookQty)}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {qty(l.countedQty)} {l.item.uom?.symbol ?? ''}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {d === 0 ? (
                                          <span className="text-muted-foreground">matched</span>
                                        ) : (
                                          <span
                                            className={d > 0 ? 'text-emerald-400' : 'text-red-400'}
                                          >
                                            {d > 0 ? '+' : ''}
                                            {qty(d)}
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
