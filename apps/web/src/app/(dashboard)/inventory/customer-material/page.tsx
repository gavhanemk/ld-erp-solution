'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Plus, Search, RefreshCw, AlertCircle, Ban, ChevronDown, ChevronRight } from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { CustomerMaterialDialog } from '@/components/inventory/CustomerMaterialDialog'
import { formatDate } from '@/lib/utils'

/**
 * Material customers have sent in for us to work on.
 *
 * It is in our godown and it is not ours. The stock screen shows it under the
 * customer's name with no value against it, and the stock figure never counts
 * it — this screen is where it comes in and, if a receipt was wrong, goes back
 * off again.
 */

interface Line {
  id: string
  challanQty: string | number
  receivedQty: string | number
  batchNumber: string | null
  markings: string | null
  item: { id: string; code: string; name: string; uom: { symbol: string } | null }
}

interface Receipt {
  id: string
  grnNumber: string
  receiptDate: string
  challanNumber: string | null
  challanDate: string | null
  gateEntryNumber: string | null
  vehicleNo: string | null
  transporter: string | null
  notes: string | null
  cancelledAt: string | null
  cancelReason: string | null
  customer: { id: string; name: string }
  so: { id: string; soNumber: string } | null
  warehouse: { id: string; name: string }
  receivedBy: { id: string; name: string } | null
  lines: Line[]
}

const qty = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

export default function CustomerMaterialPage() {
  const [rows, setRows] = useState<Receipt[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)

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
      const res = await api.get<Paginated<Receipt>>(`/inventory/customer-grn?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing customer material.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced])

  useEffect(() => {
    void load()
  }, [load])

  const cancel = async (r: Receipt) => {
    const reason = prompt(
      `Why is ${r.grnNumber} being cancelled?\n\n${r.customer.name}'s material will be taken back off the books. If any of it has already been issued to the floor, this will be refused.`
    )
    if (!reason || reason.trim().length < 5) return

    setBusy(r.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/inventory/customer-grn/${r.id}/cancel`, {
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

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Customer Material</h1>
          <p className="page-subtitle">What customers have sent in for us to work on</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-primary" onClick={() => setDialog(true)}>
            <Plus size={15} /> Receive material
          </button>
        </div>
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
          <div className="border-border bg-secondary flex min-w-[220px] max-w-sm flex-1 items-center gap-2 rounded-lg border px-3 py-2">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Search receipt, challan or customer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search customer material"
            />
          </div>
          <span className="text-muted-foreground ml-auto text-xs">{total} receipts</span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              Nothing here yet. When a customer sends fabric or trims in for us to process, book it
              in here — it goes onto the stock screen under their name and stays out of our stock
              value.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th style={{ width: 30 }} />
                  <th>Number</th>
                  <th>Customer</th>
                  <th>Their challan</th>
                  <th>Received</th>
                  <th>Into store</th>
                  <th style={{ textAlign: 'right' }}>Items</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const expanded = open === r.id
                  return (
                    <Fragment key={r.id}>
                      <tr>
                        <td>
                          <button
                            className="btn-ghost p-1"
                            onClick={() => setOpen(expanded ? null : r.id)}
                            aria-label={expanded ? 'Hide items' : 'Show items'}
                          >
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                        <td className="font-mono text-xs text-teal-400">{r.grnNumber}</td>
                        <td className="text-sm">
                          {r.customer.name}
                          {r.so && (
                            <div className="text-muted-foreground font-mono text-[10px]">
                              {r.so.soNumber}
                            </div>
                          )}
                        </td>
                        <td className="text-xs">
                          {r.challanNumber ?? '—'}
                          {r.challanDate && (
                            <div className="text-muted-foreground text-[10px]">
                              {formatDate(r.challanDate)}
                            </div>
                          )}
                        </td>
                        <td className="text-xs">
                          {formatDate(r.receiptDate)}
                          {r.receivedBy && (
                            <div className="text-muted-foreground text-[10px]">
                              by {r.receivedBy.name}
                            </div>
                          )}
                        </td>
                        <td className="text-sm">{r.warehouse.name}</td>
                        <td className="text-right text-sm tabular-nums">{r.lines.length}</td>
                        <td>
                          {r.cancelledAt ? (
                            <>
                              <span className="badge-neutral">Cancelled</span>
                              {r.cancelReason && (
                                <div className="text-muted-foreground max-w-[180px] truncate text-[10px]">
                                  {r.cancelReason}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="badge-info">Theirs, with us</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-right">
                          {!r.cancelledAt && (
                            <button
                              className="btn-ghost p-1.5 hover:text-red-400"
                              onClick={() => void cancel(r)}
                              disabled={busy === r.id}
                              title="Cancel this receipt"
                              aria-label={`Cancel ${r.grnNumber}`}
                            >
                              <Ban size={15} />
                            </button>
                          )}
                        </td>
                      </tr>

                      {expanded && (
                        <tr>
                          <td colSpan={9} className="bg-secondary/40 p-0">
                            <table className="data-table w-full">
                              <thead>
                                <tr>
                                  <th>Item</th>
                                  <th>Their markings</th>
                                  <th style={{ textAlign: 'right' }}>Their challan</th>
                                  <th style={{ textAlign: 'right' }}>Arrived</th>
                                  <th style={{ textAlign: 'right' }}>Short / excess</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.lines.map((l) => {
                                  const d = Number(l.receivedQty) - Number(l.challanQty)
                                  return (
                                    <tr key={l.id}>
                                      <td>
                                        <div className="text-sm">{l.item.name}</div>
                                        <div className="text-muted-foreground font-mono text-[10px]">
                                          {l.item.code}
                                          {l.batchNumber ? ` · batch ${l.batchNumber}` : ''}
                                        </div>
                                      </td>
                                      <td className="text-muted-foreground text-xs">
                                        {l.markings ?? '—'}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {qty(l.challanQty)}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {qty(l.receivedQty)} {l.item.uom?.symbol ?? ''}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {d === 0 ? (
                                          <span className="text-muted-foreground">matches</span>
                                        ) : (
                                          <span
                                            className={d > 0 ? 'text-amber-400' : 'text-red-400'}
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
                            {(r.vehicleNo || r.transporter || r.notes) && (
                              <p className="text-muted-foreground px-4 py-2 text-xs">
                                {[r.vehicleNo, r.transporter, r.notes].filter(Boolean).join(' · ')}
                              </p>
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
        )}
      </div>

      {dialog && (
        <CustomerMaterialDialog
          onClose={() => setDialog(false)}
          onSaved={(msg) => {
            setDialog(false)
            setMessage(msg)
            void load()
          }}
        />
      )}
    </div>
  )
}
