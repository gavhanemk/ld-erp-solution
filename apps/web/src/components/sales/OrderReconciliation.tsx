'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { api, ApiError } from '@/lib/api'

/**
 * The order's material and pieces, accounted for — the check before a
 * job-work order is closed.
 *
 * The customer's fabric, item by item: what came in on the order's customer
 * GRNs, what was issued to its manufacturing (less floor returns), what the
 * cutting used and wasted, what went back to the customer, count differences,
 * and what of theirs is still in our stores. Then the pieces: cut, packed
 * good and B-grade, damaged at job workers, sent. A gap is shown, not hidden.
 */

interface Recon {
  sharedWithOtherOrders: number
  fabric: Array<{
    item: { code: string; name: string; uom: string | null }
    challan: number
    shortOnChallan: number
    received: number
    rejected: number
    issued: number
    backFromFloor: number
    issuedNet: number
    used: number
    waste: number
    issuedNotCut: number
    returned: number
    adjusted: number
    heldNow: number
    unaccounted: number
  }>
  pieces: { ordered: number; cut: number; good: number; bGrade: number; damaged: number; inProcess: number; sent: number }
  balanced: boolean
}

const f = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })

export function OrderReconciliation({ orderId, isJobWork }: { orderId: string; isJobWork: boolean }) {
  const [data, setData] = useState<Recon | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .get<{ data: Recon }>(`/sales/orders/${orderId}/reconciliation`)
      .then((res) => alive && setData(res.data))
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not work out the reconciliation.'))
    return () => {
      alive = false
    }
  }, [orderId])

  if (error) return <p className="text-destructive text-xs">{error}</p>
  if (!data) return <div className="skeleton h-24 w-full rounded-lg" />
  const p = data.pieces
  const piecesGap = p.cut > 0 ? p.cut - p.good - p.bGrade - p.damaged : 0

  return (
    <div className="space-y-3 text-xs">
      <p className={`flex items-center gap-1.5 font-medium ${data.balanced ? 'text-primary' : 'warn-text'}`}>
        {data.balanced ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
        {data.balanced ? 'Everything is accounted for.' : 'Not everything is accounted for yet — see the figures below.'}
      </p>

      {isJobWork && (
        <div className="border-border overflow-x-auto rounded-lg border">
          {data.fabric.length === 0 ? (
            <p className="text-muted-foreground p-3">No customer material received against this order yet (Inventory → Customer Material, with this order picked).</p>
          ) : (
            <table className="subtable w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className="text-left">Customer&apos;s material</th>
                  <th className="text-right">Received</th>
                  <th className="text-right" title="Issued to the cutting floor, less what came back unused">Issued (net)</th>
                  <th className="text-right">Used · waste</th>
                  <th className="text-right">Returned to them</th>
                  <th className="text-right" title="Count differences on this customer's stock">Count diff.</th>
                  <th className="text-right">Still with us</th>
                  <th className="text-right">Unaccounted</th>
                </tr>
              </thead>
              <tbody>
                {data.fabric.map((r) => (
                  <tr key={r.item.code}>
                    <td>
                      <div className="text-foreground">{r.item.name}</div>
                      {r.shortOnChallan > 0 && (
                        <div className="warn-text text-[10px]">
                          {f(r.shortOnChallan)} {r.item.uom} short against their challan of {f(r.challan)}
                        </div>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{f(r.received)}</td>
                    <td className="text-right tabular-nums" title={r.backFromFloor ? `${f(r.issued)} issued, ${f(r.backFromFloor)} back from the floor` : undefined}>
                      {f(r.issuedNet)}
                    </td>
                    <td className="text-right tabular-nums">
                      {f(r.used)} · {f(r.waste)}
                      {Math.abs(r.issuedNotCut) > 0.0005 && <div className="text-muted-foreground text-[10px]">{f(r.issuedNotCut)} issued, not yet cut or returned</div>}
                    </td>
                    <td className="text-right tabular-nums">{f(r.returned)}</td>
                    <td className="text-right tabular-nums">{r.adjusted ? (r.adjusted > 0 ? '+' : '') + f(r.adjusted) : '—'}</td>
                    <td className="text-right tabular-nums">{f(r.heldNow)}</td>
                    <td className={`text-right font-semibold tabular-nums ${Math.abs(r.unaccounted) > 0.0005 ? 'text-destructive' : 'text-primary'}`}>
                      {Math.abs(r.unaccounted) > 0.0005 ? f(r.unaccounted) : '0'} {r.item.uom}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.sharedWithOtherOrders > 0 && (
            <p className="text-muted-foreground border-border border-t px-3 py-1.5 text-[10px]">
              This customer has {data.sharedWithOtherOrders} other open job-work {data.sharedWithOtherOrders === 1 ? 'order' : 'orders'}: count differences and stock still with us cover all of them.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
        {[
          ['Ordered', p.ordered],
          ['Cut', p.cut],
          ['Packed good', p.good],
          ['B-grade', p.bGrade],
          ['Damaged outside', p.damaged],
          ['On the floor', p.inProcess],
          ['Sent', p.sent],
        ].map(([label, value]) => (
          <div key={label as string} className="border-border bg-card rounded-lg border px-2 py-1.5">
            <div className="text-muted-foreground text-[10px]">{label}</div>
            <div className="text-foreground text-sm font-semibold tabular-nums">{(value as number).toLocaleString('en-IN')}</div>
          </div>
        ))}
      </div>
      {piecesGap > 0 && p.inProcess === 0 && <p className="warn-text">{piecesGap} pieces cut are not packed or written off.</p>}
    </div>
  )
}
