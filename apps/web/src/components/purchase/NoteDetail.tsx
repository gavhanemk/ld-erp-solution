'use client'

import { useState } from 'react'
import { Download, FileText, Loader2, Paperclip } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import {
  NOTE_STATUS,
  REASON_WORDS,
  money,
  qtyText,
  type PurchaseNote,
} from '@/components/purchase/noteTypes'

/**
 * Everything about one note, under its row.
 *
 * Three blocks in the order somebody reads them: what is being claimed and
 * against which lines; what the note comes to; and who has touched it. The
 * trail is last and always present — a document that moves money through four
 * hands has to say which four, and a panel that only shows the trail once
 * something has gone wrong is a panel nobody thinks to look at.
 */
export function NoteDetail({ note }: { note: PurchaseNote }) {
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  const tax = Number(note.cgst) + Number(note.sgst) + Number(note.igst)

  const openFile = async (id: string) => {
    setBusyFile(id)
    setFileError(null)
    try {
      const res = await api.get<{ data: { url: string } }>(`/purchase/notes/attachments/${id}/link`)
      window.open(res.data.url, '_blank', 'noopener')
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : 'Could not open that file.')
    } finally {
      setBusyFile(null)
    }
  }

  /* The trail, built from whichever stamps are actually set. A fixed list of
     five with three blanks in it reads as a form nobody filled in. */
  const trail = [
    { when: note.createdAt, who: note.createdBy?.name, what: 'Raised' },
    { when: note.submittedAt, who: note.submittedBy?.name, what: 'Sent for approval' },
    { when: note.approvedAt, who: note.approvedBy?.name, what: 'Approved' },
    { when: note.postedAt, who: note.postedBy?.name, what: 'Posted to the bill' },
    {
      when: note.closedAt,
      who: note.closedBy?.name,
      what: note.status === 'REJECTED' ? 'Sent back' : 'Cancelled',
      why: note.closedReason,
    },
  ].filter((s) => Boolean(s.when))

  return (
    <div className="space-y-3 p-3">
      {/* ── What is coming off ──────────────────────────────────────────── */}
      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[44rem] text-xs">
          <thead>
            <tr className="border-border bg-secondary border-b text-left">
              <th className="text-muted-foreground px-2 py-1.5 font-medium">Item</th>
              <th className="text-muted-foreground px-2 py-1.5 text-right font-medium">Billed</th>
              <th className="text-muted-foreground px-2 py-1.5 text-right font-medium">Adjusted</th>
              <th className="text-muted-foreground px-2 py-1.5 text-right font-medium">Rate</th>
              <th className="text-muted-foreground px-2 py-1.5 text-right font-medium">Taxable</th>
              <th className="text-muted-foreground px-2 py-1.5 text-right font-medium">GST</th>
              <th className="text-muted-foreground px-2 py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {note.lines.map((l) => (
              <tr key={l.id} className="border-border/60 border-b last:border-0">
                <td className="px-2 py-1.5">
                  <p className="text-foreground font-medium">{l.item.name}</p>
                  <p className="text-muted-foreground">
                    {l.item.code}
                    {l.hsnCode ? ` · HSN ${l.hsnCode}` : ''}
                  </p>
                  {l.remarks && <p className="text-muted-foreground italic">{l.remarks}</p>}
                </td>
                <td className="text-muted-foreground px-2 py-1.5 text-right tabular-nums">
                  {l.originalQty != null ? (
                    <>
                      {qtyText(l.originalQty)}
                      {l.item.uom ? ` ${l.item.uom.symbol}` : ''}
                      {l.originalRate != null && (
                        <span className="block opacity-70">@ ₹{money(l.originalRate)}</span>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="text-foreground px-2 py-1.5 text-right font-medium tabular-nums">
                  {qtyText(l.qty)}
                  {l.item.uom ? ` ${l.item.uom.symbol}` : ''}
                </td>
                <td className="text-foreground px-2 py-1.5 text-right tabular-nums">
                  ₹{money(l.unitPrice)}
                </td>
                <td className="text-foreground px-2 py-1.5 text-right tabular-nums">
                  ₹{money(l.taxableValue)}
                </td>
                <td className="text-muted-foreground px-2 py-1.5 text-right tabular-nums">
                  {Number(l.gstRate)}%
                </td>
                <td className="text-foreground px-2 py-1.5 text-right font-semibold tabular-nums">
                  ₹{money(l.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {/* ── The facts ─────────────────────────────────────────────────── */}
        <div className="border-border bg-card space-y-1.5 rounded-lg border p-3 lg:col-span-2">
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="What happened" value={REASON_WORDS[note.reason] ?? note.reason} />
            <Fact
              label="Document"
              value={note.noteType === 'DEBIT' ? 'Our debit note' : "Supplier's credit note"}
              sub={note.supplierDocNo ? `No. ${note.supplierDocNo}` : undefined}
            />
            <Fact
              label="Effect"
              value={
                note.effect === 'REDUCES_PAYABLE' ? 'Reduces what we owe' : 'Increases what we owe'
              }
            />
            {note.bill ? (
              <Fact
                label="Against bill"
                value={note.bill.billNumber}
                sub={`₹${money(note.bill.balanceAmount)} still owed`}
              />
            ) : (
              <Fact
                label="Against bill"
                value="None linked"
                sub={note.withoutBillReason ?? undefined}
              />
            )}
            {note.po && <Fact label="Order" value={note.po.poNumber} />}
            {note.grn && <Fact label="Receipt" value={note.grn.grnNumber} />}
            {note.warehouse && (
              <Fact
                label="Godown"
                value={note.warehouse.name}
                sub={note.status === 'POSTED' ? 'stock taken out' : 'stock moves on posting'}
              />
            )}
            {note.supplierDocDate && (
              <Fact label="Their document dated" value={formatDate(note.supplierDocDate)} />
            )}
            {(note.lrNumber || note.vehicleNo) && (
              <Fact
                label="Transport"
                value={[note.lrNumber, note.vehicleNo].filter(Boolean).join(' · ')}
              />
            )}
            {note.otherRef && <Fact label="Other reference" value={note.otherRef} />}
          </div>

          {note.reasonNote && (
            <p className="text-muted-foreground border-border/70 mt-2 border-t pt-2 text-[11px]">
              {note.reasonNote}
            </p>
          )}
          {note.notes && <p className="text-muted-foreground text-[11px] italic">{note.notes}</p>}

          {/* ── Files ──────────────────────────────────────────────────── */}
          {note.attachments.length > 0 && (
            <div className="border-border/70 mt-2 border-t pt-2">
              <p className="text-muted-foreground mb-1 flex items-center gap-1 text-[11px]">
                <Paperclip size={11} /> Evidence
              </p>
              <div className="flex flex-wrap gap-1.5">
                {note.attachments.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => void openFile(f.id)}
                    disabled={busyFile === f.id}
                    className="border-border bg-secondary hover:border-primary/40 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors"
                  >
                    {busyFile === f.id ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <FileText size={11} className="text-muted-foreground" />
                    )}
                    <span className="max-w-[12rem] truncate">{f.fileName}</span>
                    <Download size={10} className="text-muted-foreground" />
                  </button>
                ))}
              </div>
              {fileError && <p className="mt-1 text-[11px] text-red-400">{fileError}</p>}
            </div>
          )}
        </div>

        {/* ── Totals and trail ──────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="border-border bg-card space-y-1 rounded-lg border p-3">
            <Line label="Taxable value" value={Number(note.taxableAmount)} />
            {note.isIntraState ? (
              <>
                <Line label="CGST" value={Number(note.cgst)} />
                <Line label="SGST" value={Number(note.sgst)} />
              </>
            ) : (
              <Line label="IGST" value={Number(note.igst)} />
            )}
            {Number(note.otherCharges) !== 0 && (
              <Line label="Other charges" value={Number(note.otherCharges)} />
            )}
            {Number(note.discountAmount) !== 0 && (
              <Line label="Less discount" value={-Number(note.discountAmount)} />
            )}
            {Number(note.roundOff) !== 0 && (
              <Line label="Round off" value={Number(note.roundOff)} />
            )}
            <div className="border-border/70 flex items-center justify-between border-t pt-1.5">
              <span className="text-foreground text-xs font-semibold">Note total</span>
              <span className="text-primary text-sm font-semibold tabular-nums">
                ₹{money(note.totalAmount)}
              </span>
            </div>
            <p className="text-muted-foreground pt-0.5 text-[10px]">
              Tax of ₹{money(tax)} on {note.isIntraState ? 'CGST + SGST' : 'IGST'}, following the
              bill it adjusts
            </p>
          </div>

          <div className="border-border bg-card rounded-lg border p-3">
            <p className="text-muted-foreground mb-1.5 text-[11px] font-medium">
              {NOTE_STATUS[note.status].hint}
            </p>
            <ol className="space-y-1.5">
              {trail.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-[11px]">
                  <span className="bg-primary/60 mt-1 h-1.5 w-1.5 shrink-0 rounded-full" />
                  <span className="min-w-0">
                    <span className="text-foreground font-medium">{s.what}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      {s.who ? `by ${s.who}` : ''} · {formatDate(s.when!)}
                    </span>
                    {'why' in s && s.why && (
                      <span className="text-muted-foreground block italic">{s.why}</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-[10px]">{label}</p>
      <p className="text-foreground truncate text-[12px] font-medium">{value}</p>
      {sub && <p className="text-muted-foreground truncate text-[10px]">{sub}</p>}
    </div>
  )
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground tabular-nums">₹{money(value)}</span>
    </div>
  )
}
