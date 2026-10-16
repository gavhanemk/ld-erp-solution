'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { api, ApiError } from '@/lib/api'

/**
 * The order's material and pieces, accounted for — the check before a
 * job-work order is closed.
 *
 * The customer's material, item by item, counting only what the documents tie
 * to this order: received on its posted receipts, issued to its production
 * (less floor returns), used and wasted in its cutting against what the BOM
 * allows, sent back to the customer, used up at job workers, and so what is
 * left for it. Beside it, the customer's whole stock of the item with us —
 * usable and held — with what came in on receipts with no order or for other
 * orders, which never count as this one's. Then our own material that went
 * into the order, at what it cost us — covered by the job charge or billed, as
 * the order says — and the pieces. A gap is shown, not hidden; while the
 * customer's material has one, the order is not closed except on a manager's
 * exception.
 */

interface Recon {
  sharedWithOtherOrders: number
  fabric: Array<{
    item: { code: string; name: string; uom: string | null }
    challan: number
    shortOnChallan: number
    received: number
    rejected: number
    released: number
    issued: number
    backFromFloor: number
    issuedNet: number
    used: number
    waste: number
    issuedNotCut: number
    returned: number
    returnedRejected: number
    usedAtJobWorkers: number
    leftForOrder: number
    drewFromOthers: number
    usableNow: number
    heldNow: number
    unassignedReceived: number
    otherOrdersReceived: number
    unaccounted: number
    bomForCut: number | null
    bomVariance: number | null
    bomForOrder: number | null
  }>
  ownMaterial?: {
    lines: Array<{ item: { code: string; name: string; uom: string | null }; qty: number; value: number }>
    value: number
    /** IN_JOB_CHARGE: the job charge covers it. BILLED: billed to the customer as a charge. */
    billing?: 'IN_JOB_CHARGE' | 'BILLED'
    billed?: number
    toBill?: number
  }
  pieces: { ordered: number; cut: number; good: number; bGrade: number; damaged: number; inProcess: number; sent: number }
  balanced: boolean
}

const f = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const gap = (n: number) => Math.abs(n) > 0.0005

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
  const own = data.ownMaterial
  // Shown only when anything was used up at a job worker on this order.
  const jw = data.fabric.some((r) => r.usedAtJobWorkers > 0)

  return (
    <div className="space-y-3 text-xs">
      <p className={`flex items-center gap-1.5 font-medium ${data.balanced ? 'text-primary' : 'warn-text'}`}>
        {data.balanced ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
        {data.balanced ? 'Everything is accounted for.' : 'Not everything is accounted for yet — see the figures below.'}
      </p>

      {isJobWork && (
        <div className="border-border overflow-x-auto rounded-lg border">
          {data.fabric.length === 0 ? (
            <p className="text-muted-foreground p-3">No customer material posted against this order yet (Inventory → Customer Material, with this order picked).</p>
          ) : (
            <table className={`subtable w-full ${jw ? 'min-w-[820px]' : 'min-w-[740px]'}`}>
              <thead>
                <tr>
                  <th className="text-left">Customer&apos;s material — this order</th>
                  <th className="text-right">Received</th>
                  <th className="text-right" title="Issued to the cutting floor, less what came back unused">Issued (net)</th>
                  <th className="text-right" title="What the cutting used and wasted, against what the BOM allows for the pieces cut">Used · waste</th>
                  <th className="text-right">Back to them</th>
                  {jw && <th className="text-right" title="Used up at job workers on this order's challans">At job workers</th>}
                  <th className="text-right" title="Received, less issued, sent back and used at job workers: still with us for this order">Left for order</th>
                  <th className="text-right" title="The customer's whole stock of the item with us, all orders and receipts with no order">All theirs with us</th>
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
                      {r.bomForOrder != null && <div className="text-muted-foreground text-[10px]">BOM needs {f(r.bomForOrder)} {r.item.uom} for the whole order</div>}
                    </td>
                    <td className="text-right tabular-nums">
                      {f(r.received)}
                      {r.rejected > 0 && (
                        <div className="text-muted-foreground text-[10px]">
                          {f(r.rejected)} rejected{r.released > 0 ? `, ${f(r.released)} released` : ''}
                        </div>
                      )}
                    </td>
                    <td className="text-right tabular-nums" title={r.backFromFloor ? `${f(r.issued)} issued, ${f(r.backFromFloor)} back from the floor` : undefined}>
                      {f(r.issuedNet)}
                      {r.drewFromOthers > 0 && <div className="warn-text text-[10px]">{f(r.drewFromOthers)} more than its own receipts</div>}
                    </td>
                    <td className="text-right tabular-nums">
                      {f(r.used)} · {f(r.waste)}
                      {r.bomForCut != null && (
                        <div className={`text-[10px] ${r.bomVariance != null && r.bomVariance > 0.0005 ? 'warn-text' : 'text-muted-foreground'}`}>
                          BOM allows {f(r.bomForCut)}
                          {r.bomVariance != null && gap(r.bomVariance) ? ` (${r.bomVariance > 0 ? '+' : ''}${f(r.bomVariance)})` : ''}
                        </div>
                      )}
                      {gap(r.issuedNotCut) && <div className="text-muted-foreground text-[10px]">{f(r.issuedNotCut)} issued, not yet cut or returned</div>}
                    </td>
                    <td className="text-right tabular-nums">
                      {f(r.returned)}
                      {r.returnedRejected > 0 && <div className="text-muted-foreground text-[10px]">{f(r.returnedRejected)} as rejected</div>}
                    </td>
                    {jw && <td className="text-right tabular-nums">{r.usedAtJobWorkers ? f(r.usedAtJobWorkers) : '—'}</td>}
                    <td className="text-right font-semibold tabular-nums">{f(r.leftForOrder)}</td>
                    <td className="text-right tabular-nums">
                      {f(r.usableNow)}
                      {r.heldNow > 0 && <div className="text-amber-600 text-[10px]">+ {f(r.heldNow)} held (rejected)</div>}
                      {r.unassignedReceived > 0 && <div className="text-muted-foreground text-[10px]">{f(r.unassignedReceived)} came in with no order</div>}
                      {r.otherOrdersReceived > 0 && <div className="text-muted-foreground text-[10px]">{f(r.otherOrdersReceived)} came in for other orders</div>}
                    </td>
                    <td
                      className={`text-right font-semibold tabular-nums ${gap(r.unaccounted) ? 'text-destructive' : 'text-primary'}`}
                      title={gap(r.unaccounted) ? "This order's receipts say more should be left than the customer has with us at all: another order, or a correction, used it." : undefined}
                    >
                      {gap(r.unaccounted) ? f(r.unaccounted) : '0'} {r.item.uom}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.sharedWithOtherOrders > 0 && (
            <p className="text-muted-foreground border-border border-t px-3 py-1.5 text-[10px]">
              This customer has {data.sharedWithOtherOrders} other open job-work {data.sharedWithOtherOrders === 1 ? 'order' : 'orders'}. Their receipts count as theirs, and receipts with no order count as no one&apos;s, so nothing here is counted twice.
            </p>
          )}
        </div>
      )}

      {isJobWork && own && own.lines.length > 0 && (
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="subtable w-full min-w-[520px]">
            <thead>
              <tr>
                <th className="text-left">Our own material used on this order</th>
                <th className="text-right">Issued (net)</th>
                <th className="text-right">Cost to us</th>
              </tr>
            </thead>
            <tbody>
              {own.lines.map((m) => (
                <tr key={m.item.code}>
                  <td className="text-foreground">{m.item.name}</td>
                  <td className="text-right tabular-nums">
                    {f(m.qty)} {m.item.uom}
                  </td>
                  <td className="text-right tabular-nums">{inr(m.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {own.billing === 'BILLED' ? (
            <p className={`border-border border-t px-3 py-1.5 text-[10px] ${(own.toBill ?? 0) > 0.005 ? 'warn-text' : 'text-muted-foreground'}`}>
              Billed separately, as agreed: {inr(own.billed ?? 0)} billed so far on its invoices
              {(own.toBill ?? 0) > 0.005 ? `, ${inr(own.toBill ?? 0)} still to bill at cost — the next invoice offers it as a charge.` : ', nothing left to bill.'}
            </p>
          ) : (
            <p className="text-muted-foreground border-border border-t px-3 py-1.5 text-[10px]">
              {inr(own.value)} of our own material went into this job-work order, covered by the job charge as the order says. Its finished goods are the
              customer&apos;s at no value.
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
