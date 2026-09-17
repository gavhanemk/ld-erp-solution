'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Plus, Search, RefreshCw, AlertCircle, Ban, ChevronDown, ChevronRight } from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { ReceiveGoodsDialog } from '@/components/purchase/ReceiveGoodsDialog'
import { Pagination } from '@/components/tables/Pagination'
import { formatDate } from '@/lib/utils'

/**
 * What has actually turned up against the purchase orders.
 *
 * A receipt cannot be edited once it is saved, because the stock moved when it
 * saved. The only way back is to cancel it, which takes the stock out again and
 * gives the quantity back to the order — so that is the only action offered.
 */

interface ReceiptLine {
  id: string
  orderedQty: string | number
  receivedQty: string | number
  rejectedQty: string | number
  acceptedQty: string | number
  batchNumber: string | null
  item: { id: string; code: string; name: string; uom: { symbol: string } | null }
  warehouse: { id: string; name: string }
}

interface Receipt {
  id: string
  grnNumber: string
  grnDate: string
  vehicleNo: string | null
  status: 'DRAFT' | 'QC_PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED'
  notes: string | null
  po: {
    id: string
    poNumber: string
    supplier: { id: string; name: string } | null
  }
  lines: ReceiptLine[]
}

const qty = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

/** The word a store keeper would use, not the word in the database. */
function stage(status: Receipt['status']): { label: string; cls: string } {
  switch (status) {
    case 'ACCEPTED':
      return { label: 'Received', cls: 'badge-success' }
    case 'CANCELLED':
      return { label: 'Cancelled', cls: 'badge-neutral' }
    case 'QC_PENDING':
      return { label: 'Waiting for checking', cls: 'badge-warning' }
    case 'REJECTED':
      return { label: 'Refused', cls: 'badge-danger' }
    default:
      return { label: 'Draft', cls: 'badge-info' }
  }
}

/**
 * Kept as the 50 this screen already asked for, rather than the user's rows-per-page
 * setting that the order and bill lists follow. Changing it is a decision for
 * whoever owns this screen, not a side effect of giving it a pager.
 */
const PER_PAGE = 50

export default function GoodsReceiptPage() {
  const [rows, setRows] = useState<Receipt[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
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
      const qs = new URLSearchParams({ page: String(page), limit: String(PER_PAGE) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      const res = await api.get<Paginated<Receipt>>(`/purchase/grn?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing goods receipts.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced, status, page])

  useEffect(() => {
    void load()
  }, [load])

  // Narrowing a filter while on page 3 would show an empty page 3 of a shorter
  // list, which reads as "nothing found" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [debounced, status])

  const cancel = async (grn: Receipt) => {
    const reason = prompt(
      `Why is ${grn.grnNumber} being cancelled?\n\nThe stock it brought in will be taken back out.`
    )
    if (!reason || reason.trim().length < 5) return

    setBusy(grn.id)
    setError(null)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/purchase/grn/${grn.id}/cancel`, {
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
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">Goods Receipt</h1>
          <p className="page-subtitle">What has arrived against your purchase orders</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-primary" onClick={() => setDialog(true)}>
            <Plus size={15} /> Receive goods
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
          <div className="border-border bg-secondary flex w-full min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-2 sm:w-auto sm:min-w-[220px] sm:max-w-sm">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="text-foreground placeholder:text-muted-foreground flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Search receipt, order or supplier..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search goods receipts"
            />
          </div>
          <select
            className="form-input h-9 w-full sm:w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All</option>
            <option value="ACCEPTED">Received</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
          <span className="text-muted-foreground ml-auto text-xs">{total} receipts</span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              Nothing received yet. When a delivery arrives against a purchase order, book it in
              here and the stock goes up.
            </p>
          </div>
        ) : (
          <>
            {/* ── On a phone, not a table ──────────────────────────────────

              Same reasoning as the purchase order list: 8 columns cannot be
              made to fit a phone, and a table you drag sideways costs two
              gestures for every read and keeps the buttons off whichever edge
              you are not looking at. Below xl each row is a block instead.

              xl and not lg, because lg is where the sidebar comes back and
              takes 260px of the screen with it. */}
            <div className="divide-border divide-y xl:hidden">
              {rows.map((grn) => {
                const s = stage(grn.status)
                const expanded = open === grn.id
                return (
                  <div key={grn.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-foreground font-mono text-xs font-semibold">
                            {grn.grnNumber}
                          </span>
                          <span className={s.cls}>{s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">
                          {grn.po.supplier?.name ?? '—'}
                        </p>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-right text-xs">
                        {grn.lines.length} {grn.lines.length === 1 ? 'item' : 'items'}
                      </span>
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Against order</dt>
                      <dd className="text-foreground min-w-0 font-mono">{grn.po.poNumber}</dd>
                      <dt className="text-muted-foreground">Received</dt>
                      <dd className="text-foreground min-w-0">
                        {formatDate(grn.grnDate)}
                        {grn.vehicleNo && (
                          <span className="text-muted-foreground"> · {grn.vehicleNo}</span>
                        )}
                      </dd>
                    </dl>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <button
                        onClick={() => setOpen(expanded ? null : grn.id)}
                        className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {expanded ? 'Hide items' : 'What arrived'}
                      </button>
                      {grn.status !== 'CANCELLED' && (
                        <button
                          className="btn-ghost border-border rounded-lg border p-1.5 hover:text-red-400"
                          onClick={() => void cancel(grn)}
                          disabled={busy === grn.id}
                          title="Cancel this receipt"
                          aria-label={`Cancel ${grn.grnNumber}`}
                        >
                          <Ban size={15} />
                        </button>
                      )}
                    </div>

                    {expanded && (
                      <div className="border-border bg-secondary/40 mt-2.5 space-y-2 rounded-lg border p-2">
                        {grn.lines.map((l) => (
                          <div key={l.id} className="border-border bg-card rounded-lg border p-2.5">
                            <p className="text-foreground text-sm font-medium leading-snug">
                              {l.item.name}
                            </p>
                            <p className="text-muted-foreground mt-0.5 truncate text-[10px]">
                              <span className="font-mono">{l.item.code}</span>
                              {l.warehouse?.name && <> · {l.warehouse.name}</>}
                            </p>
                            <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
                              {[
                                ['Ordered', Number(l.orderedQty ?? 0)],
                                ['Arrived', Number(l.receivedQty ?? 0)],
                                ['Rejected', Number(l.rejectedQty ?? 0)],
                                ['Stock', Number(l.acceptedQty ?? 0)],
                              ].map(([label, value]) => (
                                <div key={String(label)}>
                                  <dt className="text-muted-foreground text-[10px] uppercase tracking-wider">
                                    {label}
                                  </dt>
                                  <dd className="text-foreground tabular-nums">{value}</dd>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="hidden w-full overflow-x-auto xl:block">
              {/* A floor, so the table scrolls rather than squashing.

              Eight columns with no minimum width squeeze to fit whatever they
              are given: on a narrow screen the supplier and the number end up
              two characters wide and wrapped over four lines. 900px is what
              these columns need to stay readable, and the wrapper around them
              already scrolls — which is the honest behaviour when a table is
              genuinely wider than the screen.

              It is under the 1058px a 1366px laptop has to give, so the
              commonest screen there is still shows the whole table without
              scrolling at all. */}
              <table className="data-table w-full min-w-[900px]">
                <thead>
                  <tr>
                    <th style={{ width: 30 }} />
                    <th>Number</th>
                    <th>Against order</th>
                    <th>Supplier</th>
                    <th>Received</th>
                    <th style={{ textAlign: 'right' }}>Items</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((grn) => {
                    const s = stage(grn.status)
                    const expanded = open === grn.id

                    return (
                      <Fragment key={grn.id}>
                        <tr>
                          <td>
                            <button
                              className="btn-ghost p-1"
                              onClick={() => setOpen(expanded ? null : grn.id)}
                              aria-label={expanded ? 'Hide items' : 'Show items'}
                            >
                              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td className="font-mono text-xs text-teal-400">{grn.grnNumber}</td>
                          <td className="font-mono text-xs">{grn.po.poNumber}</td>
                          <td className="text-sm">{grn.po.supplier?.name ?? '—'}</td>
                          <td className="text-xs">
                            {formatDate(grn.grnDate)}
                            {grn.vehicleNo && (
                              <div className="text-muted-foreground text-[10px]">
                                {grn.vehicleNo}
                              </div>
                            )}
                          </td>
                          <td className="text-right text-sm tabular-nums">{grn.lines.length}</td>
                          <td>
                            <span className={s.cls}>{s.label}</span>
                          </td>
                          <td className="whitespace-nowrap text-right">
                            {grn.status !== 'CANCELLED' && (
                              <button
                                className="btn-ghost p-1.5 hover:text-red-400"
                                onClick={() => void cancel(grn)}
                                disabled={busy === grn.id}
                                title="Cancel this receipt"
                                aria-label={`Cancel ${grn.grnNumber}`}
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
                                    <th>Store</th>
                                    <th style={{ textAlign: 'right' }}>Ordered</th>
                                    <th style={{ textAlign: 'right' }}>Arrived</th>
                                    <th style={{ textAlign: 'right' }}>Rejected</th>
                                    <th style={{ textAlign: 'right' }}>Into stock</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {grn.lines.map((l) => (
                                    <tr key={l.id}>
                                      <td>
                                        <div className="text-sm">{l.item.name}</div>
                                        <div className="text-muted-foreground font-mono text-[10px]">
                                          {l.item.code}
                                          {l.batchNumber ? ` · batch ${l.batchNumber}` : ''}
                                        </div>
                                      </td>
                                      <td className="text-xs">{l.warehouse.name}</td>
                                      <td className="text-right text-sm tabular-nums">
                                        {qty(l.orderedQty)}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {qty(l.receivedQty)}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {Number(l.rejectedQty) > 0 ? (
                                          <span className="text-red-400">{qty(l.rejectedQty)}</span>
                                        ) : (
                                          <span className="text-muted-foreground">—</span>
                                        )}
                                      </td>
                                      <td className="text-right text-sm tabular-nums">
                                        {qty(l.acceptedQty)} {l.item.uom?.symbol ?? ''}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {grn.notes && (
                                <p className="text-muted-foreground px-4 py-2 text-xs">
                                  {grn.notes}
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
          </>
        )}

        <Pagination
          page={page}
          pages={Math.ceil(total / PER_PAGE) || 1}
          onPageChange={setPage}
          busy={loading}
        />
      </div>

      {dialog && (
        <ReceiveGoodsDialog
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
