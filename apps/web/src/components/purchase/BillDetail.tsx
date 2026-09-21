'use client'

import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { PurchaseBill } from './PurchaseBillDialog'
import { formatDate } from '@/lib/utils'

const inr = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qtyFmt = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })

const MODE_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  NEFT: 'NEFT',
  RTGS: 'RTGS',
  UPI: 'UPI',
  PDC: 'Post-dated cheque',
}

const NOTE_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-warning' },
  ISSUED: { label: 'Issued', cls: 'badge-info' },
  SETTLED: { label: 'Settled', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

/**
 * The goods on a bill, as a table.
 *
 * This is what opens under a row in the list, and it is deliberately only the
 * items — the question somebody asks of a list is "what was on this one", and
 * answering it with six more panels of money and payment history turns a list
 * into a report. The rest lives behind View details.
 */
export function BillItems({ bill }: { bill: PurchaseBill }) {
  const lines = bill.lines ?? []

  return (
    <div className="border-border bg-secondary/30 border-t px-4 py-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-xs">
          <thead>
            <tr className="border-border text-muted-foreground border-b text-left">
              <th className="py-2 pr-3 font-medium">Item code</th>
              <th className="py-2 pr-3 font-medium">Item</th>
              <th className="py-2 pr-3 font-medium">HSN</th>
              <th className="py-2 pr-3 font-medium">From receipt</th>
              <th className="py-2 pr-3 text-right font-medium">Qty</th>
              <th className="py-2 pr-3 text-right font-medium">Rate</th>
              <th className="py-2 pr-3 text-right font-medium">Taxable</th>
              <th className="py-2 pr-3 text-right font-medium">GST</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const orderRate = l.grnLine?.unitRate != null ? Number(l.grnLine.unitRate) : null
              const billed = Number(l.unitPrice ?? 0)
              // The rate booked is not always the rate the supplier asked for.
              const heldToOrder = orderRate != null && Math.abs(billed - orderRate) < 0.005

              return (
                <tr key={l.id} className="border-border/50 border-b last:border-0">
                  <td className="text-muted-foreground py-2 pr-3 font-mono">
                    {l.item?.code ?? '—'}
                  </td>
                  <td className="text-foreground py-2 pr-3">
                    {l.item?.name ?? '—'}
                    {l.description && (
                      <div className="text-muted-foreground text-[10px]">{l.description}</div>
                    )}
                  </td>
                  <td className="text-muted-foreground py-2 pr-3 font-mono">
                    {l.hsnCode ?? l.item?.hsnCode ?? '—'}
                  </td>
                  <td className="text-muted-foreground py-2 pr-3 font-mono">
                    {l.grnLine?.grn?.grnNumber ?? 'Direct'}
                  </td>
                  <td className="text-foreground py-2 pr-3 text-right tabular-nums">
                    {qtyFmt(l.qty)}
                    {l.item?.uom?.symbol && (
                      <span className="text-muted-foreground ml-1">{l.item.uom.symbol}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    <span className="text-foreground">₹{inr(billed)}</span>
                    {orderRate != null && !heldToOrder && (
                      <div className="text-muted-foreground text-[10px]">
                        order ₹{inr(orderRate)}
                      </div>
                    )}
                  </td>
                  <td className="text-muted-foreground py-2 pr-3 text-right tabular-nums">
                    ₹{inr(l.taxableValue)}
                  </td>
                  <td className="text-muted-foreground py-2 pr-3 text-right tabular-nums">
                    {Number(l.gstRate ?? 0)}%
                  </td>
                  <td className="text-foreground py-2 text-right font-medium tabular-nums">
                    ₹{inr(l.amount)}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-border border-t">
              <td colSpan={6} />
              <td className="text-muted-foreground py-2 pr-3 text-right tabular-nums">
                ₹{inr(bill.taxableAmount)}
              </td>
              <td />
              <td className="text-foreground py-2 text-right font-semibold tabular-nums">
                ₹{inr(bill.totalAmount)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-[11px]">{label}</dt>
      <dd className="text-foreground mt-0.5 text-sm">{value}</dd>
    </div>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wide">
      {children}
    </h3>
  )
}

/**
 * Everything a bill is, in one read-only window.
 *
 * Opened from the row's actions rather than from the row itself, because this
 * is the answer to "tell me everything about this one" and not the answer to
 * "what is on this list". Nothing in here is a control — somebody who came to
 * check a figure should not be one slip away from changing it.
 */
export function BillDetailDialog({ bill, onClose }: { bill: PurchaseBill; onClose: () => void }) {
  const receipts = [
    ...new Set((bill.lines ?? []).map((l) => l.grnLine?.grn?.grnNumber).filter(Boolean)),
  ] as string[]

  const paid = Number(bill.paidAmount ?? 0)
  const balance = Number(bill.balanceAmount ?? 0)
  const tds = Number(bill.tdsAmount ?? 0)
  const payments = bill.payments ?? []
  const notes = bill.debitNotes ?? []

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="glass-card my-auto w-full max-w-5xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bill-detail-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="border-border flex items-start justify-between gap-4 border-b px-6 py-4">
          <div className="min-w-0">
            <h2 id="bill-detail-title" className="text-foreground text-lg font-semibold">
              {bill.billNumber}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {bill.supplier?.name}
              {bill.supplierInvoiceNo ? ` · their invoice ${bill.supplierInvoiceNo}` : ''}
            </p>
          </div>
          <button className="btn-ghost p-1.5" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[75vh] space-y-6 overflow-y-auto px-6 py-5">
          {/* The paperwork, and the trail behind it. */}
          <section>
            <Heading>The bill</Heading>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Field
                label="Our number"
                value={<span className="font-mono text-teal-400">{bill.billNumber}</span>}
              />
              <Field
                label="Their invoice"
                value={
                  bill.supplierInvoiceNo ? (
                    <span className="font-mono">{bill.supplierInvoiceNo}</span>
                  ) : (
                    <span className="text-muted-foreground">Not given</span>
                  )
                }
              />
              <Field
                label="Their invoice date"
                value={
                  bill.supplierInvoiceDate ? (
                    formatDate(bill.supplierInvoiceDate)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
              <Field label="Booked on" value={formatDate(bill.billDate)} />
              <Field
                label="Payment due"
                value={
                  bill.dueDate ? (
                    formatDate(bill.dueDate)
                  ) : (
                    <span className="text-muted-foreground">No terms given</span>
                  )
                }
              />
              <Field
                label="Against order"
                value={
                  bill.po ? (
                    <span className="font-mono">{bill.po.poNumber}</span>
                  ) : (
                    <span
                      className="text-muted-foreground"
                      title="Typed by hand, or it gathers receipts from more than one order — the header cannot honestly name one then"
                    >
                      Not one order
                    </span>
                  )
                }
              />
              <Field
                label="Against receipts"
                value={
                  receipts.length ? (
                    <span className="font-mono">{receipts.join(', ')}</span>
                  ) : (
                    <span className="text-muted-foreground">Direct, no receipt</span>
                  )
                }
              />
              <Field label="Entered by" value={bill.createdBy?.name ?? '—'} />
            </dl>
          </section>

          <section>
            <Heading>The supplier</Heading>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Field label="Name" value={bill.supplier?.name ?? '—'} />
              <Field
                label="GSTIN"
                value={
                  bill.supplier?.gstin ? (
                    <span className="font-mono text-xs">{bill.supplier.gstin}</span>
                  ) : (
                    <span
                      className="text-muted-foreground"
                      title="An unregistered supplier — there is no tax split to make and none is charged"
                    >
                      Unregistered
                    </span>
                  )
                }
              />
              <Field
                label="Tax"
                value={
                  bill.isReverseCharge ? (
                    <span className="text-amber-400">Reverse charge — we pay the GST</span>
                  ) : Number(bill.igst ?? 0) > 0 ? (
                    'IGST — across states'
                  ) : Number(bill.cgst ?? 0) > 0 ? (
                    'CGST + SGST — inside the state'
                  ) : (
                    <span className="text-muted-foreground">No tax on this bill</span>
                  )
                }
              />
              <Field
                label="TDS"
                value={
                  bill.tdsSection ? (
                    `${bill.tdsSection} at ${Number(bill.tdsRate ?? 0)}% — ₹${inr(tds)} withheld`
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )
                }
              />
            </dl>
          </section>

          <section>
            <Heading>Items ({bill.lines?.length ?? 0})</Heading>
            <div className="border-border overflow-hidden rounded-lg border">
              <BillItems bill={bill} />
            </div>
          </section>

          {bill.charges && bill.charges.length > 0 && (
            <section>
              <Heading>Extra charges</Heading>
              <div className="border-border overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-border text-muted-foreground border-b text-left">
                      <th className="px-3 py-2 font-medium">Charge</th>
                      <th className="px-3 py-2 text-right font-medium">GST</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bill.charges.map((c) => (
                      <tr key={c.id} className="border-border/50 border-b last:border-0">
                        <td className="text-foreground px-3 py-2">
                          {c.chargeType?.name ?? 'Charge'}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-right tabular-nums">
                          {Number(c.gstRate ?? 0)}%
                        </td>
                        <td className="text-foreground px-3 py-2 text-right tabular-nums">
                          ₹{inr(c.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <Heading>What it adds up to</Heading>
              <dl className="space-y-1.5 text-sm">
                {[
                  ['Goods', inr(bill.subtotal)],
                  ...(Number(bill.discountAmount ?? 0) > 0
                    ? [['Less discount', `−${inr(bill.discountAmount)}`]]
                    : []),
                  ['Taxable value', inr(bill.taxableAmount)],
                  ...(Number(bill.cgst ?? 0) > 0
                    ? [
                        ['CGST', inr(bill.cgst)],
                        ['SGST', inr(bill.sgst)],
                      ]
                    : []),
                  ...(Number(bill.igst ?? 0) > 0 ? [['IGST', inr(bill.igst)]] : []),
                  ...(Number(bill.roundOff ?? 0) !== 0
                    ? [['Round off', inr(bill.roundOff)]]
                    : []),
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-foreground tabular-nums">₹{value}</dd>
                  </div>
                ))}

                <div className="border-border flex justify-between gap-4 border-t pt-1.5">
                  <dt className="text-foreground font-semibold">Bill total</dt>
                  <dd className="text-foreground font-semibold tabular-nums">
                    ₹{inr(bill.totalAmount)}
                  </dd>
                </div>

                {tds > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Less TDS withheld</dt>
                    <dd className="text-foreground tabular-nums">−₹{inr(tds)}</dd>
                  </div>
                )}

                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Paid so far</dt>
                  <dd className="text-foreground tabular-nums">₹{inr(paid)}</dd>
                </div>

                <div className="border-border flex justify-between gap-4 border-t pt-1.5">
                  <dt className="text-foreground font-semibold">Still owed</dt>
                  <dd
                    className={`font-semibold tabular-nums ${
                      balance > 0 ? 'text-amber-400' : 'text-emerald-400'
                    }`}
                  >
                    ₹{inr(balance)}
                  </dd>
                </div>
              </dl>
            </section>

            <section>
              <Heading>Payment history ({payments.length})</Heading>
              {payments.length ? (
                <div className="border-border overflow-x-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-border text-muted-foreground border-b text-left">
                        <th className="px-3 py-2 font-medium">Payment</th>
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium">Mode</th>
                        <th className="px-3 py-2 font-medium">Reference</th>
                        <th className="px-3 py-2 font-medium">By</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id} className="border-border/50 border-b last:border-0">
                          <td className="px-3 py-2 font-mono text-teal-400">{p.paymentNumber}</td>
                          <td className="text-muted-foreground px-3 py-2">
                            {formatDate(p.paymentDate)}
                          </td>
                          <td className="text-foreground px-3 py-2">
                            {MODE_LABEL[p.mode] ?? p.mode}
                            {p.chequeDate && (
                              <div className="text-muted-foreground text-[10px]">
                                dated {formatDate(p.chequeDate)}
                              </div>
                            )}
                          </td>
                          <td className="text-muted-foreground px-3 py-2 font-mono">
                            {p.referenceNo ?? '—'}
                          </td>
                          <td className="text-muted-foreground px-3 py-2">
                            {p.createdBy?.name ?? '—'}
                          </td>
                          <td className="text-foreground px-3 py-2 text-right font-medium tabular-nums">
                            ₹{inr(p.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-border border-t">
                        <td colSpan={5} className="text-muted-foreground px-3 py-2">
                          Paid against this bill
                        </td>
                        <td className="text-foreground px-3 py-2 text-right font-semibold tabular-nums">
                          ₹{inr(paid)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Nothing has been paid against this bill yet.
                </p>
              )}
            </section>
          </div>

          {notes.length > 0 && (
            <section>
              <Heading>Claimed back from the supplier ({notes.length})</Heading>
              <div className="border-border overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-border text-muted-foreground border-b text-left">
                      <th className="px-3 py-2 font-medium">Note</th>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Why</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {notes.map((n) => {
                      const st = NOTE_STATUS[n.status] ?? {
                        label: n.status,
                        cls: 'badge-neutral',
                      }
                      return (
                        <tr key={n.id} className="border-border/50 border-b last:border-0">
                          <td className="px-3 py-2 font-mono text-amber-400">{n.noteNumber}</td>
                          <td className="text-muted-foreground px-3 py-2">
                            {formatDate(n.noteDate)}
                          </td>
                          <td className="text-foreground px-3 py-2">{n.reason ?? '—'}</td>
                          <td className="px-3 py-2">
                            <span className={st.cls}>{st.label}</span>
                            {n.status === 'DRAFT' && (
                              <div className="text-muted-foreground mt-0.5 text-[10px]">
                                not sent to the supplier
                              </div>
                            )}
                          </td>
                          <td className="text-foreground px-3 py-2 text-right font-medium tabular-nums">
                            ₹{inr(n.totalAmount)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {bill.notes && (
            <section>
              <Heading>Notes</Heading>
              <p className="text-foreground whitespace-pre-wrap text-sm">{bill.notes}</p>
            </section>
          )}
        </div>

        <div className="border-border flex justify-end border-t px-6 py-3">
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
