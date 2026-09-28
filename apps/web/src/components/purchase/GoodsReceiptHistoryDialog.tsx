'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Calendar, Loader2, PackageCheck, Truck, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'

interface HistoryLine {
  id: string
  poLineId: string | null
  orderedQty: string | number
  receivedQty: string | number
  rejectedQty: string | number
  acceptedQty: string | number
  batchNumber?: string | null
  item: { id: string; code: string; name: string; uom?: { symbol: string } | null }
  warehouse?: { id: string; name: string } | null
}

interface HistoryReceipt {
  id: string
  grnNumber: string
  grnDate: string
  status: 'DRAFT' | 'QC_PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED'
  challanNo?: string | null
  challanDate?: string | null
  gateEntryNo?: string | null
  notes?: string | null
  createdBy?: { id: string; name: string } | null
  lines: HistoryLine[]
}

function stage(status: HistoryReceipt['status']): { label: string; cls: string } {
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

const qty = (v: string | number) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 })

const onDate = (v?: string | null) =>
  v
    ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—'

/**
 * Every delivery booked against one order, in one place.
 *
 * The orders screen used to carry this as a link that jumped to the goods
 * receipt screen with the order number typed into its search box. That found
 * the right rows, but it answered a different question: it showed the
 * receipts as a list among all the others, and left somebody holding an order
 * to work out for themselves how much of each line had actually turned up
 * across four lorries.
 *
 * This answers the question that was asked. The summary is the order read
 * back through its deliveries — ordered, arrived, refused, into stock and
 * what is still owed, a line at a time — and the deliveries themselves are
 * underneath it in the order they happened.
 */
export function GoodsReceiptHistoryDialog({
  poId,
  poNumber,
  supplierName,
  onClose,
}: {
  poId: string
  poNumber: string
  supplierName?: string | null
  onClose: () => void
}) {
  const [receipts, setReceipts] = useState<HistoryReceipt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{ success: boolean; data: HistoryReceipt[] }>(
          `/purchase/grn?poId=${poId}&limit=100`
        )
        if (!cancelled) setReceipts(res.data)
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : 'Could not read this order’s deliveries.'
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [poId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * The order line by line, read back through its deliveries.
   *
   * Cancelled receipts are counted as nothing. They are still listed below,
   * because a delivery that was booked and then called off is part of what
   * happened — but letting one add to "into stock" would say the mill holds
   * goods it sent back.
   *
   * Ordered is taken once per order line rather than summed: every receipt
   * line carries the quantity its order line was raised for, so adding them
   * up would multiply the order by the number of lorries.
   */
  const summary = useMemo(() => {
    const rows = new Map<
      string,
      {
        name: string
        code: string
        uom: string
        ordered: number
        received: number
        rejected: number
        accepted: number
      }
    >()

    for (const receipt of receipts) {
      const counts = receipt.status !== 'CANCELLED'
      for (const line of receipt.lines) {
        const key = line.poLineId ?? line.item.id
        const row = rows.get(key) ?? {
          name: line.item.name,
          code: line.item.code,
          uom: line.item.uom?.symbol ?? '',
          ordered: Number(line.orderedQty),
          received: 0,
          rejected: 0,
          accepted: 0,
        }
        if (counts) {
          row.received += Number(line.receivedQty)
          row.rejected += Number(line.rejectedQty)
          row.accepted += Number(line.acceptedQty)
        }
        rows.set(key, row)
      }
    }

    return [...rows.values()]
  }, [receipts])

  const live = receipts.filter((r) => r.status !== 'CANCELLED').length

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3"
      onClick={onClose}
    >
      <div
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="grn-history-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-border flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2
              id="grn-history-title"
              className="text-foreground flex items-center gap-2 text-base font-semibold"
            >
              <PackageCheck size={17} className="text-primary shrink-0" />
              Goods Receipt History
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              What has arrived against <span className="text-foreground font-mono">{poNumber}</span>
              {supplierName ? ` from ${supplierName}` : ''}.
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost shrink-0 p-1"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 size={14} className="animate-spin" /> Loading...
            </p>
          ) : error ? (
            <p className="flex items-center gap-2 text-sm text-red-400">
              <AlertCircle size={14} /> {error}
            </p>
          ) : receipts.length === 0 ? (
            <div className="border-border bg-secondary/40 rounded-lg border px-4 py-8 text-center">
              <Truck size={22} className="text-muted-foreground mx-auto opacity-60" />
              <p className="text-foreground mt-2 text-sm font-medium">Nothing has arrived yet</p>
              <p className="text-muted-foreground mt-1 text-xs">
                When a delivery is booked against {poNumber}, it will be listed here.
              </p>
            </div>
          ) : (
            <>
              {/* ── The order, read back through its deliveries ──────── */}
              <section>
                <h3 className="text-muted-foreground mb-1.5 text-[11px] font-semibold uppercase tracking-wider">
                  Where the order stands
                </h3>
                <div className="border-border overflow-x-auto rounded-lg border">
                  <table className="subtable w-full">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="text-right">Ordered</th>
                        <th className="text-right">Received</th>
                        <th className="text-right">Rejected</th>
                        <th className="text-right">Into stock</th>
                        <th className="text-right">Still due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.map((row) => {
                        const due = Math.max(0, row.ordered - row.accepted)
                        return (
                          <tr key={row.code + row.name}>
                            <td>
                              <div className="text-foreground">{row.name}</div>
                              <div className="text-muted-foreground font-mono text-[10px]">
                                {row.code}
                              </div>
                            </td>
                            <td className="text-right tabular-nums">{qty(row.ordered)}</td>
                            <td className="text-right tabular-nums">{qty(row.received)}</td>
                            <td className="text-right tabular-nums">
                              {row.rejected > 0 ? (
                                <span className="text-red-400">{qty(row.rejected)}</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="text-right tabular-nums">
                              {qty(row.accepted)} {row.uom}
                            </td>
                            <td className="text-right tabular-nums">
                              {due > 0 ? (
                                <span className="text-amber-400">{qty(due)}</span>
                              ) : (
                                <span className="text-emerald-400">—</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {/* Short-closed lines read "still due —" here without ever
                  having been delivered in full. That is the order screen's
                  business to explain, not this one's, but the count of
                  deliveries belongs here so nobody reads one lorry as four. */}
                <p className="text-muted-foreground mt-1.5 text-[11px]">
                  {live} {live === 1 ? 'delivery' : 'deliveries'} counted
                  {receipts.length > live
                    ? ` · ${receipts.length - live} cancelled and not counted`
                    : ''}
                </p>
              </section>

              {/* ── Each delivery, as it happened ────────────────────── */}
              <section className="space-y-2.5">
                <h3 className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">
                  The deliveries
                </h3>

                {receipts.map((receipt) => {
                  const s = stage(receipt.status)
                  const off = receipt.status === 'CANCELLED'
                  return (
                    <div
                      key={receipt.id}
                      className={`border-border bg-card overflow-hidden rounded-lg border ${
                        off ? 'opacity-60' : ''
                      }`}
                    >
                      <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
                        <a
                          href={`/print/goods-receipt/${receipt.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs font-semibold text-teal-400 hover:underline"
                          title={`Open the printed sheet for ${receipt.grnNumber}`}
                        >
                          {receipt.grnNumber}
                        </a>
                        <span className={s.cls}>{s.label}</span>
                        <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                          <Calendar size={11} />
                          {onDate(receipt.grnDate)}
                        </span>
                        {receipt.challanNo && (
                          <span className="text-muted-foreground text-[11px]">
                            Challan{' '}
                            <span className="text-foreground font-mono">{receipt.challanNo}</span>
                            {receipt.challanDate ? ` · ${onDate(receipt.challanDate)}` : ''}
                          </span>
                        )}
                        {receipt.gateEntryNo && (
                          <span className="text-muted-foreground text-[11px]">
                            Gate {receipt.gateEntryNo}
                          </span>
                        )}
                        {receipt.createdBy?.name && (
                          <span className="text-muted-foreground ml-auto text-[11px]">
                            booked by {receipt.createdBy.name}
                          </span>
                        )}
                      </div>

                      <div className="overflow-x-auto">
                        <table className="subtable w-full">
                          <thead>
                            <tr>
                              <th>Item</th>
                              <th>Store</th>
                              <th className="text-right">Received</th>
                              <th className="text-right">Rejected</th>
                              <th className="text-right">Into stock</th>
                            </tr>
                          </thead>
                          <tbody>
                            {receipt.lines.map((line) => (
                              <tr key={line.id}>
                                <td>
                                  <div className="text-foreground">{line.item.name}</div>
                                  <div className="text-muted-foreground font-mono text-[10px]">
                                    {line.item.code}
                                    {line.batchNumber ? ` · batch ${line.batchNumber}` : ''}
                                  </div>
                                </td>
                                <td>{line.warehouse?.name ?? '—'}</td>
                                <td className="text-right tabular-nums">{qty(line.receivedQty)}</td>
                                <td className="text-right tabular-nums">
                                  {Number(line.rejectedQty) > 0 ? (
                                    <span className="text-red-400">{qty(line.rejectedQty)}</span>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="text-right tabular-nums">
                                  {qty(line.acceptedQty)} {line.item.uom?.symbol ?? ''}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {receipt.notes && (
                        <p className="border-border text-muted-foreground border-t px-3 py-2 text-xs">
                          {receipt.notes}
                        </p>
                      )}
                    </div>
                  )
                })}
              </section>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
