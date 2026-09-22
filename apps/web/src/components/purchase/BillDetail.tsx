'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Building2,
  Calculator,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  Package,
  Paperclip,
  Percent,
  Receipt,
  Undo2,
  Wallet,
  X,
} from 'lucide-react'
import { Section } from './PurchaseOrderDialog'
import type { BillAttachment, PurchaseBill } from './PurchaseBillDialog'
import { api, ApiError } from '@/lib/api'
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

// Kept in step with the same map on the bills list, so a bill reads the same
// badge whether it is glanced at in the table or opened in full.
const STATUS: Record<string, { label: string; cls: string }> = {
  UNPAID: { label: 'Unpaid', cls: 'badge-warning' },
  PARTIAL: { label: 'Part paid', cls: 'badge-info' },
  PAID: { label: 'Paid', cls: 'badge-success' },
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
                <td className="text-muted-foreground py-2 pr-3 font-mono">{l.item?.code ?? '—'}</td>
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
                    <div className="text-muted-foreground text-[10px]">order ₹{inr(orderRate)}</div>
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
  )
}

/** A file behind a bill, tagged with which document it actually hangs off. */
export type BillFile = BillAttachment & { kind: 'order' | 'receipt'; source: string }

/**
 * Every file behind a bill, from its order and from each of its receipts.
 *
 * A bill carries no files of its own — the quotation was agreed on the order
 * and the challan came in on the receipt, and both stay where they were
 * attached. A receipt reached through several bill lines would otherwise
 * contribute its files once per line, so they are gathered by id.
 */
export interface FileTrail {
  po?: { poNumber: string; attachments?: BillAttachment[] } | null
  lines?: Array<{
    grnLine?: { grn: { grnNumber: string; attachments?: BillAttachment[] } } | null
  }>
}

export function billFiles(bill: FileTrail): BillFile[] {
  const seen = new Map<string, BillFile>()

  for (const f of bill.po?.attachments ?? []) {
    seen.set(f.id, { ...f, kind: 'order', source: bill.po!.poNumber })
  }
  for (const line of bill.lines ?? []) {
    const grn = line.grnLine?.grn
    if (!grn) continue
    for (const f of grn.attachments ?? []) {
      if (!seen.has(f.id)) seen.set(f.id, { ...f, kind: 'receipt', source: grn.grnNumber })
    }
  }

  return [...seen.values()]
}

const fileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The papers hanging off a bill's order and its receipts.
 *
 * A bill carries no files of its own — the quotation was agreed on the order
 * and the challan came in on the receipt, and both stay where they were
 * attached. Gathering them here is what saves opening two more screens to
 * check a bill against what was promised and what arrived.
 *
 * `kind` decides which endpoint signs the link: an order's files and a
 * receipt's files are different tables and different routes.
 */
function Attachments({ files }: { files: BillFile[] }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = async (file: { id: string; kind: 'order' | 'receipt' }) => {
    setBusy(file.id)
    setError(null)
    try {
      // The link is signed and short-lived, so it is fetched at the moment it
      // is wanted rather than put in the page and left to go stale.
      const path = file.kind === 'order' ? 'attachments' : 'grn-attachments'
      const res = await api.get<{ data: { url: string } }>(`/purchase/${path}/${file.id}/link`)
      window.open(res.data.url, '_blank', 'noopener')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that file. Try again.')
    } finally {
      setBusy(null)
    }
  }

  if (!files.length) {
    return <p className="text-muted-foreground text-sm">No files on the order or its receipts.</p>
  }

  return (
    <>
      {error && (
        <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-border text-muted-foreground border-b text-left">
              <th className="py-2 pr-3 font-medium">File</th>
              <th className="py-2 pr-3 font-medium">On</th>
              <th className="py-2 pr-3 font-medium">Added</th>
              <th className="py-2 pr-3 text-right font-medium">Size</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id} className="border-border/50 border-b last:border-0">
                <td className="text-foreground py-2 pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <Paperclip size={12} className="text-muted-foreground shrink-0" />
                    {f.fileName}
                  </span>
                </td>
                <td className="text-muted-foreground py-2 pr-3 font-mono">{f.source}</td>
                <td className="text-muted-foreground py-2 pr-3">{formatDate(f.createdAt)}</td>
                <td className="text-muted-foreground py-2 pr-3 text-right tabular-nums">
                  {fileSize(f.sizeBytes)}
                </td>
                <td className="py-2 text-right">
                  <button
                    className="btn-ghost p-1"
                    onClick={() => void open(f)}
                    disabled={busy === f.id}
                    title={`Open ${f.fileName}`}
                    aria-label={`Open ${f.fileName}`}
                  >
                    {busy === f.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Field({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-[11px]">{label}</dt>
      <dd className="text-foreground mt-0.5 text-sm">{value}</dd>
    </div>
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

  const files = billFiles(bill)

  return createPortal(
    // The same shell the order, receipt and bill forms use: offset past the
    // sidebar, filling the height, header and footer fixed with only the
    // middle scrolling. This was a centred 5xl card with its own 75vh cap,
    // which is a fourth idea of a dialog in a module that already had three.
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3"
      onClick={onClose}
    >
      <div
        className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bill-detail-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="border-border flex shrink-0 items-start justify-between gap-4 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="bg-primary/10 border-primary/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
              <Receipt size={16} className="text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="bill-detail-title" className="text-foreground text-base font-semibold">
                  {bill.supplierInvoiceNo || bill.billNumber}
                </h2>
                <span className={(STATUS[bill.status] ?? { cls: 'badge-neutral' }).cls}>
                  {STATUS[bill.status]?.label ?? bill.status}
                </span>
                {bill.isReverseCharge && <span className="badge-purple">RCM</span>}
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {bill.supplier?.name} · our reference {bill.billNumber}
              </p>
            </div>
          </div>
          <button className="btn-ghost shrink-0 p-1.5" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-2.5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Bill total', value: `₹${inr(bill.totalAmount)}`, color: 'text-foreground' },
              { label: 'Paid so far', value: `₹${inr(paid)}`, color: 'text-emerald-400' },
              {
                label: 'Still owed',
                value: `₹${inr(balance)}`,
                color: balance > 0 ? 'text-amber-400' : 'text-emerald-400',
              },
              { label: 'Items', value: String(bill.lines?.length ?? 0), color: 'text-teal-400' },
            ].map((s) => (
              <div
                key={s.label}
                className="border-border bg-card rounded-xl border p-3 text-center"
              >
                <p className={`text-lg font-bold tabular-nums ${s.color}`}>{s.value}</p>
                <p className="text-muted-foreground mt-0.5 text-[11px] uppercase tracking-wide">
                  {s.label}
                </p>
              </div>
            ))}
          </div>

          {/* The paperwork, and the trail behind it. */}
          <Section icon={FileText} title="The bill">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Field
                label="Bill no. (the supplier's)"
                value={
                  <span className="font-mono text-teal-400">
                    {bill.supplierInvoiceNo || bill.billNumber}
                  </span>
                }
              />
              <Field
                label="Bill date"
                value={
                  bill.supplierInvoiceDate ? (
                    formatDate(bill.supplierInvoiceDate)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
              <Field
                label="Our reference"
                value={<span className="font-mono">{bill.billNumber}</span>}
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
          </Section>

          <Section icon={Building2} title="The supplier">
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
          </Section>

          <Section icon={Package} title={`Items (${bill.lines?.length ?? 0})`}>
            <BillItems bill={bill} />
          </Section>

          {bill.charges && bill.charges.length > 0 && (
            <Section icon={Percent} title="Extra charges">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-border text-muted-foreground border-b text-left">
                      <th className="py-2 pr-3 font-medium">Charge</th>
                      <th className="py-2 pr-3 text-right font-medium">GST</th>
                      <th className="py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bill.charges.map((c) => (
                      <tr key={c.id} className="border-border/50 border-b last:border-0">
                        <td className="text-foreground py-2 pr-3">
                          {c.chargeType?.name ?? 'Charge'}
                        </td>
                        <td className="text-muted-foreground py-2 pr-3 text-right tabular-nums">
                          {Number(c.gstRate ?? 0)}%
                        </td>
                        <td className="text-foreground py-2 text-right tabular-nums">
                          ₹{inr(c.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Section icon={Calculator} title="What it adds up to">
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
                  ...(Number(bill.roundOff ?? 0) !== 0 ? [['Round off', inr(bill.roundOff)]] : []),
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
            </Section>

            <Section icon={Wallet} title={`Payment history (${payments.length})`}>
              {payments.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-border text-muted-foreground border-b text-left">
                        <th className="py-2 pr-3 font-medium">Payment</th>
                        <th className="py-2 pr-3 font-medium">Date</th>
                        <th className="py-2 pr-3 font-medium">Mode</th>
                        <th className="py-2 pr-3 font-medium">Reference</th>
                        <th className="py-2 pr-3 font-medium">By</th>
                        <th className="py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id} className="border-border/50 border-b last:border-0">
                          <td className="py-2 pr-3 font-mono text-teal-400">{p.paymentNumber}</td>
                          <td className="text-muted-foreground py-2 pr-3">
                            {formatDate(p.paymentDate)}
                          </td>
                          <td className="text-foreground py-2 pr-3">
                            {MODE_LABEL[p.mode] ?? p.mode}
                            {p.chequeDate && (
                              <div className="text-muted-foreground text-[10px]">
                                dated {formatDate(p.chequeDate)}
                              </div>
                            )}
                          </td>
                          <td className="text-muted-foreground py-2 pr-3 font-mono">
                            {p.referenceNo ?? '—'}
                          </td>
                          <td className="text-muted-foreground py-2 pr-3">
                            {p.createdBy?.name ?? '—'}
                          </td>
                          <td className="text-foreground py-2 text-right font-medium tabular-nums">
                            ₹{inr(p.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-border border-t">
                        <td colSpan={5} className="text-muted-foreground py-2 pr-3">
                          Paid against this bill
                        </td>
                        <td className="text-foreground py-2 text-right font-semibold tabular-nums">
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
            </Section>
          </div>

          {notes.length > 0 && (
            <Section icon={Undo2} title={`Claimed back from the supplier (${notes.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-border text-muted-foreground border-b text-left">
                      <th className="py-2 pr-3 font-medium">Note</th>
                      <th className="py-2 pr-3 font-medium">Date</th>
                      <th className="py-2 pr-3 font-medium">Why</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                      <th className="py-2 text-right font-medium">Amount</th>
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
                          <td className="py-2 pr-3 font-mono text-amber-400">{n.noteNumber}</td>
                          <td className="text-muted-foreground py-2 pr-3">
                            {formatDate(n.noteDate)}
                          </td>
                          <td className="text-foreground py-2 pr-3">{n.reason ?? '—'}</td>
                          <td className="py-2 pr-3">
                            <span className={st.cls}>{st.label}</span>
                            {n.status === 'DRAFT' && (
                              <div className="text-muted-foreground mt-0.5 text-[10px]">
                                not sent to the supplier
                              </div>
                            )}
                          </td>
                          <td className="text-foreground py-2 text-right font-medium tabular-nums">
                            ₹{inr(n.totalAmount)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <Section icon={Paperclip} title={`Attachments (${files.length})`}>
            <Attachments files={files} />
          </Section>

          {bill.notes && (
            <Section icon={MessageSquare} title="Notes">
              <p className="text-foreground whitespace-pre-wrap text-sm">{bill.notes}</p>
            </Section>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-3 border-t px-4 py-3">
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * Just the papers behind a bill, and nothing else.
 *
 * The paperclip in the list used to open the whole detail window scrolled to
 * its attachments panel. That answers "tell me everything about this bill"
 * when the question asked was "let me see the challan" — eight panels of
 * figures to scroll past, and the window it opened is the one the Actions
 * menu already opens. A paperclip should open the files.
 *
 * Shaped like the order and receipt file viewers rather than like the four
 * purchase forms: a centred card, because a list of two or three files does
 * not need the full height of the screen. Wider than those two by one step,
 * since a bill's files come from more than one document and so carry a
 * column saying which.
 */
export function BillFilesDialog({
  trail,
  label,
  onClose,
}: {
  trail: FileTrail
  /** The document number this is shown under — a bill number, usually. */
  label: string
  onClose: () => void
}) {
  const files = billFiles(trail)

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-card flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bill-files-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="border-border flex shrink-0 items-start justify-between gap-4 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="bg-primary/10 border-primary/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
              <Paperclip size={16} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="bill-files-title" className="text-foreground text-base font-semibold">
                Attachments
              </h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {files.length === 0
                  ? 'Nothing scanned onto this bill’s order or its receipts'
                  : `${files.length} ${
                      files.length === 1 ? 'file' : 'files'
                    } on ${label} — from its order and its receipts`}
              </p>
            </div>
          </div>
          <button className="btn-ghost shrink-0 p-1.5" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <Attachments files={files} />
        </div>
      </div>
    </div>,
    document.body
  )
}
