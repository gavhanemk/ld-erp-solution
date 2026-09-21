'use client'

import { FileText, Package, Receipt, Truck, Undo2, User } from 'lucide-react'
import type { PurchaseBill } from './PurchaseBillDialog'
import { formatDate } from '@/lib/utils'

const inr = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qty = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })

const MODE_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  NEFT: 'NEFT',
  RTGS: 'RTGS',
  UPI: 'UPI',
  PDC: 'Post-dated cheque',
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground min-w-0">{value}</dd>
    </>
  )
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof FileText
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h4 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
        <Icon size={12} />
        {title}
      </h4>
      {children}
    </div>
  )
}

/**
 * Everything a purchase bill is made of, on one panel.
 *
 * Written because a bill on the list was a number and a total, and every
 * question anybody actually asks about one — which order did this answer,
 * which delivery, at whose rate, who booked it, what have we paid, did we
 * dispute any of it — needed somebody to open the edit form and read it out
 * of the boxes. An edit form is a bad place to answer a question: it invites
 * changing the thing you came to check.
 *
 * Read-only on purpose. Nothing here is a control.
 */
export function BillDetail({ bill }: { bill: PurchaseBill }) {
  const receipts = [
    ...new Set((bill.lines ?? []).map((l) => l.grnLine?.grn?.grnNumber).filter(Boolean)),
  ] as string[]

  const paid = Number(bill.paidAmount ?? 0)
  const balance = Number(bill.balanceAmount ?? 0)
  const tds = Number(bill.tdsAmount ?? 0)

  return (
    <div className="border-border bg-secondary/30 space-y-5 border-t px-4 py-4">
      {/* The trail: what this bill answers, and what it came from. */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Section icon={FileText} title="This bill">
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <Row
              label="Our number"
              value={<span className="font-mono text-teal-400">{bill.billNumber}</span>}
            />
            <Row
              label="Their invoice"
              value={
                bill.supplierInvoiceNo ? (
                  <span className="font-mono">{bill.supplierInvoiceNo}</span>
                ) : (
                  <span className="text-muted-foreground">Not given</span>
                )
              }
            />
            {bill.supplierInvoiceDate && (
              <Row label="Their date" value={formatDate(bill.supplierInvoiceDate)} />
            )}
            <Row label="Booked on" value={formatDate(bill.billDate)} />
            <Row
              label="Payment due"
              value={
                bill.dueDate ? (
                  formatDate(bill.dueDate)
                ) : (
                  <span className="text-muted-foreground">No terms given</span>
                )
              }
            />
          </dl>
        </Section>

        <Section icon={Truck} title="Who and what it came from">
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <Row label="Supplier" value={bill.supplier?.name ?? '—'} />
            {bill.supplier?.gstin && (
              <Row label="GSTIN" value={<span className="font-mono">{bill.supplier.gstin}</span>} />
            )}
            <Row
              label="Order"
              value={
                bill.po ? (
                  <span className="font-mono">{bill.po.poNumber}</span>
                ) : (
                  <span
                    className="text-muted-foreground"
                    title="Either typed by hand, or it gathers receipts from more than one order — the header cannot honestly name one then"
                  >
                    Not tied to one order
                  </span>
                )
              }
            />
            <Row
              label="Receipts"
              value={
                receipts.length ? (
                  <span className="font-mono">{receipts.join(', ')}</span>
                ) : (
                  <span
                    className="text-muted-foreground"
                    title="A service or transport bill — no goods came through the gate for it"
                  >
                    Direct, no receipt
                  </span>
                )
              }
            />
            {bill.isReverseCharge && (
              <Row
                label="Tax"
                value={<span className="text-amber-400">Reverse charge — we pay the GST</span>}
              />
            )}
          </dl>
        </Section>

        <Section icon={User} title="Who booked it">
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <Row label="Entered by" value={bill.createdBy?.name ?? '—'} />
            {bill.createdAt && <Row label="Entered on" value={formatDate(bill.createdAt)} />}
            {bill.tdsSection && (
              <Row
                label="TDS"
                value={`${bill.tdsSection} at ${Number(bill.tdsRate ?? 0)}% — ₹${inr(tds)} withheld`}
              />
            )}
            {bill.notes && <Row label="Notes" value={<span className="whitespace-pre-wrap">{bill.notes}</span>} />}
          </dl>
        </Section>
      </div>

      {/* The goods themselves, and which delivery each line settles. */}
      <Section icon={Package} title={`Items on this bill (${bill.lines?.length ?? 0})`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-xs">
            <thead>
              <tr className="border-border text-muted-foreground border-b text-left">
                <th className="py-1.5 pr-3 font-medium">Item</th>
                <th className="py-1.5 pr-3 font-medium">HSN</th>
                <th className="py-1.5 pr-3 font-medium">From receipt</th>
                <th className="py-1.5 pr-3 text-right font-medium">Qty</th>
                <th className="py-1.5 pr-3 text-right font-medium">Rate</th>
                <th className="py-1.5 pr-3 text-right font-medium">Taxable</th>
                <th className="py-1.5 pr-3 text-right font-medium">GST</th>
                <th className="py-1.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(bill.lines ?? []).map((l) => {
                const orderRate = l.grnLine?.unitRate != null ? Number(l.grnLine.unitRate) : null
                const billed = Number(l.unitPrice ?? 0)
                // Worth calling out: the rate that was booked is not always the
                // rate the supplier asked for.
                const heldToOrder =
                  orderRate != null && Math.abs(billed - orderRate) < 0.005 ? false : orderRate != null

                return (
                  <tr key={l.id} className="border-border/50 border-b last:border-0">
                    <td className="text-foreground py-1.5 pr-3">
                      {l.item?.name ?? '—'}
                      {l.item?.code && (
                        <span className="text-muted-foreground ml-1.5 font-mono text-[10px]">
                          {l.item.code}
                        </span>
                      )}
                      {l.description && (
                        <div className="text-muted-foreground text-[10px]">{l.description}</div>
                      )}
                    </td>
                    <td className="text-muted-foreground py-1.5 pr-3 font-mono">
                      {l.hsnCode ?? l.item?.hsnCode ?? '—'}
                    </td>
                    <td className="text-muted-foreground py-1.5 pr-3 font-mono">
                      {l.grnLine?.grn?.grnNumber ?? (
                        <span className="text-muted-foreground">Direct</span>
                      )}
                    </td>
                    <td className="text-foreground py-1.5 pr-3 text-right tabular-nums">
                      {qty(l.qty)}
                      {l.item?.uom?.symbol && (
                        <span className="text-muted-foreground ml-1">{l.item.uom.symbol}</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      <span className="text-foreground">₹{inr(billed)}</span>
                      {heldToOrder && (
                        <div
                          className="text-[10px] text-teal-400"
                          title="The order's rate was used, not the rate on the supplier's invoice"
                        >
                          order rate
                        </div>
                      )}
                    </td>
                    <td className="text-muted-foreground py-1.5 pr-3 text-right tabular-nums">
                      ₹{inr(l.taxableValue)}
                    </td>
                    <td className="text-muted-foreground py-1.5 pr-3 text-right tabular-nums">
                      {Number(l.gstRate ?? 0)}%
                    </td>
                    <td className="text-foreground py-1.5 text-right font-medium tabular-nums">
                      ₹{inr(l.amount)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {bill.charges && bill.charges.length > 0 && (
        <Section icon={Receipt} title="Extra charges">
          <div className="space-y-1 text-xs">
            {bill.charges.map((c) => (
              <div key={c.id} className="flex items-center justify-between">
                <span className="text-foreground">
                  {c.chargeType?.name ?? 'Charge'}
                  <span className="text-muted-foreground ml-1.5">
                    at {Number(c.gstRate ?? 0)}% GST
                  </span>
                </span>
                <span className="text-foreground tabular-nums">₹{inr(c.amount)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Money: what it adds up to, and what is left. */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section icon={Receipt} title="What it adds up to">
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
            <Row label="Goods" value={<span className="tabular-nums">₹{inr(bill.subtotal)}</span>} />
            {Number(bill.discountAmount ?? 0) > 0 && (
              <Row
                label="Less discount"
                value={<span className="tabular-nums">−₹{inr(bill.discountAmount)}</span>}
              />
            )}
            <Row
              label="Taxable value"
              value={<span className="tabular-nums">₹{inr(bill.taxableAmount)}</span>}
            />
            {Number(bill.cgst ?? 0) > 0 && (
              <>
                <Row label="CGST" value={<span className="tabular-nums">₹{inr(bill.cgst)}</span>} />
                <Row label="SGST" value={<span className="tabular-nums">₹{inr(bill.sgst)}</span>} />
              </>
            )}
            {Number(bill.igst ?? 0) > 0 && (
              <Row label="IGST" value={<span className="tabular-nums">₹{inr(bill.igst)}</span>} />
            )}
            {Number(bill.roundOff ?? 0) !== 0 && (
              <Row
                label="Round off"
                value={<span className="tabular-nums">₹{inr(bill.roundOff)}</span>}
              />
            )}
            <Row
              label={<span className="text-foreground font-semibold">Bill total</span>}
              value={
                <span className="text-foreground font-semibold tabular-nums">
                  ₹{inr(bill.totalAmount)}
                </span>
              }
            />
            {tds > 0 && (
              <Row
                label="Less TDS withheld"
                value={<span className="tabular-nums">−₹{inr(tds)}</span>}
              />
            )}
            <Row label="Paid so far" value={<span className="tabular-nums">₹{inr(paid)}</span>} />
            <Row
              label={<span className="text-foreground font-semibold">Still owed</span>}
              value={
                <span
                  className={`font-semibold tabular-nums ${
                    balance > 0 ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  ₹{inr(balance)}
                </span>
              }
            />
          </dl>
        </Section>

        <div className="space-y-4">
          <Section icon={Receipt} title={`Payments made (${bill.payments?.length ?? 0})`}>
            {bill.payments?.length ? (
              <div className="space-y-1 text-xs">
                {bill.payments.map((p) => (
                  <div key={p.id} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0">
                      <span className="font-mono text-teal-400">{p.paymentNumber}</span>
                      <span className="text-muted-foreground ml-1.5">
                        {formatDate(p.paymentDate)} · {MODE_LABEL[p.mode] ?? p.mode}
                        {p.referenceNo ? ` · ${p.referenceNo}` : ''}
                        {p.createdBy?.name ? ` · ${p.createdBy.name}` : ''}
                      </span>
                    </span>
                    <span className="text-foreground shrink-0 tabular-nums">₹{inr(p.amount)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">Nothing paid against this yet.</p>
            )}
          </Section>

          {bill.debitNotes && bill.debitNotes.length > 0 && (
            <Section icon={Undo2} title={`Claimed back (${bill.debitNotes.length})`}>
              <div className="space-y-1 text-xs">
                {bill.debitNotes.map((n) => (
                  <div key={n.id} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0">
                      <span className="font-mono text-amber-400">{n.noteNumber}</span>
                      <span className="text-muted-foreground ml-1.5">
                        {formatDate(n.noteDate)}
                        {n.reason ? ` · ${n.reason}` : ''}
                      </span>
                      {n.status === 'DRAFT' && (
                        <span className="ml-1.5 text-[10px] text-amber-400">
                          draft — not sent to the supplier
                        </span>
                      )}
                    </span>
                    <span className="text-foreground shrink-0 tabular-nums">
                      ₹{inr(n.totalAmount)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}
