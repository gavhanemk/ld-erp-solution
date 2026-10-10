'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ClipboardList,
  FilePenLine,
  History,
  Link2,
  Loader2,
  Pencil,
  Printer,
  Ruler,
  Scissors,
  ShoppingBag,
  Truck,
  X,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate, formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { OrderLinesView, type OrderLineView } from './OrderLinesView'
import { OPEN_ORDER_STATUSES, salesOrderStatus } from './status'
import { confirmOrder, dispatchHref, orderCan, postReasonAction, REASON_ACTIONS, type ReasonAction } from './orderActions'

interface Person {
  id: string
  name: string
}

export interface OrderDetailFull {
  id: string
  soNumber: string
  status: string
  version: number
  orderDate: string
  deliveryDate: string | null
  customerPORef: string | null
  customerPODate: string | null
  deliveryAddress: string | null
  billingAddress: string | null
  reference: string | null
  salesperson: string | null
  placeOfSupplyCode: string | null
  isJobWork: boolean
  notes: string | null
  terms: string | null
  otherCharges: string | number
  charges: Array<{ id: string; amount: string | number; gstRate: string | number; chargeType: { name: string } }>
  subtotal: string | number
  discountAmount: string | number
  taxableAmount: string | number
  cgst: string | number
  sgst: string | number
  igst: string | number
  roundOff: string | number
  totalAmount: string | number
  brokeragePercent: string | number | null
  brokerageAmount: string | number
  createdAt: string
  sentForApprovalAt: string | null
  approvedAt: string | null
  creditReleasedAt: string | null
  creditReleaseReason: string | null
  cancelledAt: string | null
  cancelReason: string | null
  shortClosedAt: string | null
  shortCloseReason: string | null
  customer: { id: string; name: string; gstin: string | null; billingCity: string | null; shippingCity: string | null }
  brand: { name: string; type: string }
  broker: { name: string; brokeragePercent: string | number | null } | null
  createdBy: Person | null
  approvedBy: Person | null
  creditReleasedBy: Person | null
  cancelledBy: Person | null
  shortClosedBy: Person | null
  revisions: Array<{ id: string; version: number; reason: string; changedAt: string; changedBy: Person }>
  lines: OrderLineView[]
  manufacturingOrders: Array<{ id: string; moNumber: string; status: string; totalPackedQty: string | number | null }>
  materialRequisitions: Array<{ id: string; mrNumber: string; status: string; closedAt: string | null }>
  deliveryChallans: Array<{ id: string; dcNumber: string; dcDate: string; status: string }>
  invoices: Array<{ id: string; invoiceNumber: string; invoiceDate: string; totalAmount: string | number; status: string }>
}

/** An earlier version, as the server kept it when the order was amended. */
interface Revision {
  version: number
  reason: string
  changedAt: string
  changedBy: Person
  snapshot: Pick<
    OrderDetailFull,
    'soNumber' | 'deliveryDate' | 'customerPORef' | 'deliveryAddress' | 'taxableAmount' | 'totalAmount'
  > & { lines: OrderLineView[] }
}

const words = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ')
const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground min-w-0 break-words">{children}</dd>
    </>
  )
}

/**
 * One sales order, read: where it stands, what is on it, what came of it, and
 * who did what to it. The way into the next step — send, amend, cancel,
 * short-close — from the one place that shows whether that step makes sense.
 *
 * Built on the same full-height card as the order form, opened from View on
 * the order list or from the order number.
 */
export function SalesOrderDetailDialog({
  orderId,
  onClose,
  onEdit,
  onAmend,
  onChanged,
}: {
  orderId: string | null
  onClose: () => void
  onEdit: (id: string) => void
  onAmend: (id: string) => void
  /** Something was done to the order here; the list should reload. */
  onChanged: (message: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [order, setOrder] = useState<OrderDetailFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<ReasonAction | null>(null)
  /** The server's figures when confirming needs a reason to release a credit hold. */
  const [holdNote, setHoldNote] = useState<string | null>(null)
  const [revision, setRevision] = useState<Revision | 'loading' | null>(null)

  const load = useCallback(async (id: string) => {
    setError(null)
    try {
      const res = await api.get<{ data: OrderDetailFull }>(`/sales/orders/${id}`)
      setOrder(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the order.')
    }
  }, [])

  useEffect(() => {
    setOrder(null)
    setMessage(null)
    setRevision(null)
    if (orderId) void load(orderId)
  }, [orderId, load])

  useEffect(() => {
    if (!orderId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !asking && !revision) onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [orderId, onClose, asking, revision])

  if (!orderId || !mounted) return null

  const act = async (run: () => Promise<{ message?: string }>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await run()
      const msg = res.message ?? fallback
      setMessage(msg)
      onChanged(msg)
      await load(orderId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be done.')
    } finally {
      setBusy(false)
      setAsking(null)
    }
  }

  /*
   * Confirm the draft. Within the credit limit that is all; over it the server
   * puts it on hold for a manager and says so, or — for someone who may release
   * it — answers CREDIT_HOLD, and the reason is asked for.
   */
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await confirmOrder(orderId)
      const msg = res.message ?? 'Order confirmed'
      setMessage(msg)
      onChanged(msg)
      await load(orderId)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CREDIT_HOLD') {
        setHoldNote(err.message)
        setAsking('release')
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not confirm the order.')
      }
    } finally {
      setBusy(false)
    }
  }

  const openRevision = async (version: number) => {
    setRevision('loading')
    try {
      const res = await api.get<{ data: Revision }>(`/sales/orders/${orderId}/revisions/${version}`)
      setRevision(res.data)
    } catch (err) {
      setRevision(null)
      setError(err instanceof ApiError ? err.message : 'Could not open that version.')
    }
  }

  const o = order
  const look = o ? salesOrderStatus(o) : null
  const dispatched = o ? o.lines.reduce((s, l) => s + Number(l.deliveredQty), 0) : 0
  const pieces = o ? o.lines.reduce((s, l) => s + Number(l.totalQty), 0) : 0
  const started = o ? o.manufacturingOrders.length > 0 || o.deliveryChallans.length > 0 || dispatched > 0 : false
  const late =
    o && o.deliveryDate && OPEN_ORDER_STATUSES.includes(o.status) && new Date(o.deliveryDate) < new Date(new Date().toDateString())
  const rejected = o?.status === 'CANCELLED' && !o.approvedAt && !!o.sentForApprovalAt

  /*
   * The road an order travels, each step with when and what moved it. A
   * cancelled order stops where it was stopped, and says so.
   */
  const steps = o
    ? [
        { label: 'Draft', done: true, note: `${formatDate(o.createdAt)}${o.createdBy ? ` · ${o.createdBy.name}` : ''}` },
        {
          label: 'Confirmed',
          done: !!o.approvedAt,
          note: o.approvedAt
            ? `${formatDate(o.approvedAt)}${o.approvedBy ? ` · ${o.approvedBy.name}` : ''}`
            : o.sentForApprovalAt && o.status === 'DRAFT'
              ? `on credit hold since ${formatDate(o.sentForApprovalAt)}`
              : '',
        },
        {
          label: 'In production',
          done: o.manufacturingOrders.length > 0 || ['IN_PRODUCTION', 'PARTIALLY_DISPATCHED', 'COMPLETED'].includes(o.status),
          note: o.manufacturingOrders[0] ? o.manufacturingOrders.map((m) => m.moNumber).join(', ') : '',
        },
        {
          label: 'Dispatched',
          done: dispatched > 0,
          note: dispatched > 0 ? `${dispatched.toLocaleString('en-IN')} of ${pieces.toLocaleString('en-IN')} pcs` : '',
        },
        {
          label: o.shortClosedAt ? 'Short-closed' : 'Completed',
          done: o.status === 'COMPLETED',
          note: o.shortClosedAt ? formatDate(o.shortClosedAt) : '',
        },
      ]
    : []
  const stoppedAt = o?.status === 'CANCELLED' ? steps.filter((s) => s.done).length : -1

  /* Everything that happened to the order, oldest first. */
  const history = o
    ? [
        { at: o.createdAt, text: `Raised${o.createdBy ? ` by ${o.createdBy.name}` : ''}`, version: null as number | null },
        ...(o.sentForApprovalAt
          ? [
              {
                at: o.sentForApprovalAt,
                text: 'Put on credit hold: over the credit limit or blacklisted, so a manager has to OK it',
                version: null,
              },
            ]
          : []),
        ...(o.approvedAt
          ? [
              {
                at: o.approvedAt,
                // Approved when a manager OK'd a credit hold; otherwise simply confirmed.
                text: `${o.sentForApprovalAt ? 'Approved' : 'Confirmed'}${o.approvedBy ? ` by ${o.approvedBy.name}` : ''}`,
                version: null,
              },
            ]
          : []),
        ...(o.creditReleasedAt
          ? [
              {
                at: o.creditReleasedAt,
                text: `Credit hold released${o.creditReleasedBy ? ` by ${o.creditReleasedBy.name}` : ''}: ${o.creditReleaseReason ?? ''}`,
                version: null,
              },
            ]
          : []),
        ...o.revisions.map((r) => ({
          at: r.changedAt,
          text: `Amended to version ${r.version + 1} by ${r.changedBy.name}: ${r.reason}`,
          version: r.version,
        })),
        ...(o.cancelledAt
          ? [
              {
                at: o.cancelledAt,
                text: `${rejected ? 'Rejected' : 'Cancelled'}${o.cancelledBy ? ` by ${o.cancelledBy.name}` : ''}: ${o.cancelReason ?? ''}`,
                version: null,
              },
            ]
          : []),
        ...(o.shortClosedAt
          ? [
              {
                at: o.shortClosedAt,
                text: `Short-closed${o.shortClosedBy ? ` by ${o.shortClosedBy.name}` : ''}: ${o.shortCloseReason ?? ''}`,
                version: null,
              },
            ]
          : []),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    : []

  const linked = o
    ? [
        ...o.manufacturingOrders.map((m) => ({
          key: m.id,
          kind: 'Production order',
          number: m.moNumber,
          detail: m.totalPackedQty ? `${Number(m.totalPackedQty).toLocaleString('en-IN')} packed` : '',
          status: words(m.status),
        })),
        ...o.materialRequisitions.map((m) => ({
          key: m.id,
          kind: 'Requisition',
          number: m.mrNumber,
          detail: '',
          status: m.closedAt ? 'Closed' : words(m.status),
        })),
        ...o.deliveryChallans.map((d) => ({
          key: d.id,
          kind: 'Delivery challan',
          number: d.dcNumber,
          detail: formatDate(d.dcDate),
          status: words(d.status),
        })),
        ...o.invoices.map((i) => ({
          key: i.id,
          kind: 'Tax invoice',
          number: i.invoiceNumber,
          detail: `${formatDate(i.invoiceDate)} · ${formatRupees(i.totalAmount)}`,
          status: words(i.status),
        })),
      ]
    : []

  const intra = o ? Number(o.igst) === 0 && (Number(o.cgst) > 0 || Number(o.sgst) > 0) : false

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
        <div
          className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-labelledby="so-detail-title"
        >
          {/* Header: which order, where it stands, and what can be done next. */}
          <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
                <ShoppingBag size={19} className="text-primary" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="so-detail-title" className="text-foreground font-mono text-xl font-semibold tracking-tight">
                    {o?.soNumber ?? 'Sales order'}
                  </h2>
                  {look && <span className={look.cls}>{look.label}</span>}
                  {late && <span className="badge-danger">Overdue</span>}
                  {o?.isJobWork && <span className="badge-purple">Job work</span>}
                </div>
                {o && (
                  <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                    {o.customer.name} · {o.brand.name} · version {o.version}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {o && (
                <a
                  className="btn-secondary"
                  href={`/print/sales-order/${o.id}`}
                  target="_blank"
                  rel="noreferrer"
                  title="The order confirmation for the buyer"
                >
                  <Printer size={15} /> Print
                </a>
              )}
              {o && orderCan.edit(o) && (
                <button className="btn-secondary" onClick={() => onEdit(o.id)} disabled={busy}>
                  <Pencil size={15} /> Edit draft
                </button>
              )}
              {o && orderCan.confirm(o) && (
                <button className="btn-primary" onClick={() => void confirm()} disabled={busy}>
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Confirm order
                </button>
              )}
              {o && orderCan.dispatch(o) && dispatched < pieces && (
                <a className="btn-primary" href={dispatchHref(o.id)} title="Raise a delivery challan for what is still to send">
                  <Truck size={15} /> Dispatch
                </a>
              )}
              {o && orderCan.amend(o) && (
                <button className="btn-secondary" onClick={() => onAmend(o.id)} disabled={busy}>
                  <FilePenLine size={15} /> Amend
                </button>
              )}
              {o && orderCan.shortClose(o) && started && (
                <button className="btn-secondary" onClick={() => setAsking('short-close')} disabled={busy}>
                  <Scissors size={15} /> Short-close
                </button>
              )}
              {o && orderCan.cancel(o) && !started && (
                <button className="btn-ghost text-destructive" onClick={() => setAsking('cancel')} disabled={busy}>
                  <Ban size={15} /> Cancel order
                </button>
              )}
              <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {error && (
              <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
                <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
                <p className="text-destructive text-sm">{error}</p>
              </div>
            )}
            {message && (
              <div className="border-primary/40 bg-primary/5 flex items-start gap-3 rounded-lg border p-3">
                <CheckCircle2 size={16} className="text-primary mt-0.5 shrink-0" />
                <p className="text-primary text-sm">{message}</p>
              </div>
            )}

            {!o ? (
              !error && (
                <div className="space-y-3">
                  <div className="skeleton h-20 w-full rounded-xl" />
                  <div className="skeleton h-64 w-full rounded-xl" />
                </div>
              )
            ) : (
              <>
                {/* The road, step by step. */}
                <ol className="glass-card grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-5">
                  {steps.map((s, i) => {
                    const stopped = stoppedAt >= 0 && i === stoppedAt
                    return (
                      <li key={s.label} className="flex min-w-0 items-start gap-2">
                        <span
                          className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full border ${
                            stopped
                              ? 'border-destructive bg-destructive'
                              : s.done
                                ? 'border-primary bg-primary'
                                : 'border-border bg-transparent'
                          }`}
                          aria-hidden
                        />
                        <div className="min-w-0">
                          <p className={`text-xs font-medium ${s.done || stopped ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {stopped ? (rejected ? 'Rejected' : 'Cancelled') : s.label}
                          </p>
                          <p className="text-muted-foreground truncate text-[11px]">
                            {stopped && o.cancelledAt ? formatDate(o.cancelledAt) : s.note}
                          </p>
                        </div>
                      </li>
                    )
                  })}
                </ol>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
                  <div className="min-w-0 space-y-3">
                    <Section icon={Ruler} title="Lines and sizes">
                      <div className="border-border bg-secondary/40 -m-1 rounded-lg border">
                        <OrderLinesView lines={o.lines} />
                      </div>
                    </Section>

                    <Section icon={Link2} title="Linked documents">
                      {linked.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          Nothing yet. Production orders, requisitions, challans and invoices raised against this order
                          appear here.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="subtable w-full">
                            <thead>
                              <tr>
                                <th className="text-left">Document</th>
                                <th className="text-left">Number</th>
                                <th className="text-left">Detail</th>
                                <th className="text-left">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {linked.map((d) => (
                                <tr key={d.key}>
                                  <td className="text-muted-foreground text-xs">{d.kind}</td>
                                  <td className="font-mono text-xs">{d.number}</td>
                                  <td className="text-xs">{d.detail || '—'}</td>
                                  <td className="text-xs">{d.status}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </Section>

                    <Section icon={History} title="History">
                      <ol className="space-y-2">
                        {history.map((h, i) => (
                          <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
                            <span className="text-muted-foreground w-24 shrink-0 tabular-nums">{formatDate(h.at)}</span>
                            <span className="text-foreground min-w-0 flex-1 break-words">{h.text}</span>
                            {h.version !== null && (
                              <button
                                type="button"
                                className="text-primary text-xs underline underline-offset-2"
                                onClick={() => void openRevision(h.version!)}
                              >
                                View version {h.version}
                              </button>
                            )}
                          </li>
                        ))}
                      </ol>
                    </Section>
                  </div>

                  <div className="min-w-0 space-y-3">
                    <Section icon={ClipboardList} title="Order">
                      <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                        <Fact label="Customer">
                          {o.customer.name}
                          {o.customer.gstin && (
                            <span className="text-muted-foreground block font-mono text-[10px]">{o.customer.gstin}</span>
                          )}
                        </Fact>
                        <Fact label="Buyer PO">
                          {o.customerPORef || '—'}
                          {o.customerPODate && (
                            <span className="text-muted-foreground"> · {formatDate(o.customerPODate)}</span>
                          )}
                        </Fact>
                        <Fact label="Order date">{formatDate(o.orderDate)}</Fact>
                        <Fact label="Delivery date">
                          {o.deliveryDate ? (
                            <span className={late ? 'text-destructive font-medium' : undefined}>
                              {formatDate(o.deliveryDate)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </Fact>
                        <Fact label="Deliver to">{o.deliveryAddress || '—'}</Fact>
                        {o.billingAddress && <Fact label="Bill to">{o.billingAddress}</Fact>}
                        {o.reference && <Fact label="Reference">{o.reference}</Fact>}
                        <Fact label="Place of supply">
                          {o.placeOfSupplyCode
                            ? `${o.placeOfSupplyCode} · ${intra ? 'CGST + SGST' : 'IGST'}`
                            : '—'}
                        </Fact>
                        <Fact label="Broker">
                          {o.broker
                            ? `${o.broker.name}${o.brokeragePercent != null ? ` · ${Number(o.brokeragePercent)}%` : ''}`
                            : 'Direct'}
                        </Fact>
                        <Fact label="Salesperson">{o.salesperson || '—'}</Fact>
                        {o.notes && <Fact label="Notes">{o.notes}</Fact>}
                        {o.terms && <Fact label="Terms">{o.terms}</Fact>}
                      </dl>
                    </Section>

                    <Section icon={ClipboardList} title="Totals">
                      <dl className="space-y-1.5 text-sm">
                        {[
                          ['Value', money(o.subtotal)],
                          ...(Number(o.discountAmount) > 0 ? [['Discount', `− ${money(o.discountAmount)}`]] : []),
                          ['Value before GST', money(o.taxableAmount)],
                          ...(o.charges ?? []).map((c) => [`${c.chargeType.name} @ ${Number(c.gstRate)}%`, money(c.amount)]),
                          ...(intra
                            ? [
                                ['CGST', money(o.cgst)],
                                ['SGST', money(o.sgst)],
                              ]
                            : [['IGST', money(o.igst)]]),
                          ...(Number(o.otherCharges) > 0 ? [['Other charges', money(o.otherCharges)]] : []),
                          ...(Math.abs(Number(o.roundOff)) >= 0.005 ? [['Rounding', money(o.roundOff)]] : []),
                        ].map(([label, value]) => (
                          <div key={label} className="flex items-center justify-between gap-3">
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className="text-foreground tabular-nums">{value}</dd>
                          </div>
                        ))}
                        <div className="border-primary/20 bg-primary/5 mt-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                          <dt className="text-foreground font-semibold">Order total</dt>
                          <dd className="text-foreground text-lg font-semibold tabular-nums">{formatRupees(o.totalAmount)}</dd>
                        </div>
                        {Number(o.brokerageAmount) > 0 && (
                          <p className="text-muted-foreground pt-1 text-xs">
                            Brokerage {formatRupees(o.brokerageAmount)} (internal, not printed).
                          </p>
                        )}
                      </dl>
                    </Section>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {asking && o && (
        <ReasonDialog
          title={REASON_ACTIONS[asking].title(o.soNumber)}
          description={asking === 'release' && holdNote ? holdNote : REASON_ACTIONS[asking].description}
          confirmLabel={REASON_ACTIONS[asking].confirmLabel}
          placeholder={REASON_ACTIONS[asking].placeholder}
          danger={asking === 'cancel'}
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={(reason) => void act(() => postReasonAction(o.id, asking, reason), `${o.soNumber} updated`)}
        />
      )}

      {/* An earlier version, read-only, over the order. */}
      {revision && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm">
          <div className="glass-card flex max-h-full w-full max-w-3xl flex-col overflow-hidden" role="dialog" aria-modal="true">
            <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
              <div className="min-w-0">
                <h3 className="text-foreground text-base font-semibold">
                  {revision === 'loading' ? 'Opening the earlier version…' : `${revision.snapshot.soNumber}, version ${revision.version}`}
                </h3>
                {revision !== 'loading' && (
                  <p className="text-muted-foreground truncate text-xs">
                    As it stood before {revision.changedBy.name} amended it on {formatDate(revision.changedAt)}:{' '}
                    {revision.reason}
                  </p>
                )}
              </div>
              <button className="btn-ghost p-2" onClick={() => setRevision(null)} aria-label="Close version">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {revision === 'loading' ? (
                <div className="skeleton h-40 w-full rounded-lg" />
              ) : (
                <>
                  <dl className="mb-3 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    <Fact label="Buyer PO">{revision.snapshot.customerPORef || '—'}</Fact>
                    <Fact label="Delivery date">
                      {revision.snapshot.deliveryDate ? formatDate(revision.snapshot.deliveryDate) : '—'}
                    </Fact>
                    <Fact label="Deliver to">{revision.snapshot.deliveryAddress || '—'}</Fact>
                    <Fact label="Value before GST">{formatRupees(revision.snapshot.taxableAmount)}</Fact>
                    <Fact label="Order total">{formatRupees(revision.snapshot.totalAmount)}</Fact>
                  </dl>
                  <div className="border-border bg-secondary/40 rounded-lg border">
                    <OrderLinesView lines={revision.snapshot.lines} showProgress={false} />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  )
}
