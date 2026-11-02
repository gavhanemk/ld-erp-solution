'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Ban, BookOpenCheck, History, Pencil, X } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { useEscape } from '@/lib/useEscape'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { modeLabel } from '@/components/sales/status'
import { BILL_KIND_LABEL, KIND_BADGE, amountOrBlank, day, inr, type BillKind, type ManualKind, type VoucherKind } from './books'

interface Detail {
  id: string
  kind: VoucherKind
  kindLabel: string
  voucherNo: string
  date: string
  narration: string | null
  amount: number
  mode: string | null
  referenceNo: string | null
  chequeNo: string | null
  chequeDate: string | null
  sourceType: string | null
  status: 'POSTED' | 'CANCELLED'
  cancelledAt: string | null
  cancelReason: string | null
  cancelledBy: { name: string } | null
  createdAt: string
  createdBy: { name: string } | null
  updatedAt: string
  updatedBy: { name: string } | null
  lines: Array<{
    id: string
    debit: number
    credit: number
    narration: string | null
    costCentre: { name: string } | null
    ledger: { id: string; name: string; group: string }
    bills: Array<{ kind: BillKind; billNo: string; billDate: string; dueDate: string | null; amount: number }>
  }>
  history: Array<{
    id: string
    action: string
    createdAt: string
    before: { amount?: number } | null
    after: { status?: string; reason?: string; amount?: number } | null
    user: { name: string }
  }>
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

/**
 * One voucher as it stands: its lines, the bills each settles, and its
 * history — who entered it, who altered it and when, who cancelled it and
 * why. A voucher typed in Accounts can be altered or cancelled from here; one
 * written by a sales or purchase document only changes with its document.
 */
export function VoucherView({
  voucherId,
  onClose,
  onAlter,
  onChanged,
  onOpenLedger,
}: {
  voucherId: string | null
  onClose: () => void
  onAlter: (id: string, kind: ManualKind) => void
  onChanged: (message: string) => void
  onOpenLedger?: (ledgerId: string) => void
}) {
  const [v, setV] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEscape(() => {
    if (!cancelling) onClose()
  }, !!voucherId)

  useEffect(() => {
    if (!voucherId) return
    setV(null)
    setError(null)
    api
      .get<{ data: Detail }>(`/accounts/vouchers/${voucherId}`)
      .then((r) => setV(r.data))
      .catch((err) => setError(apiErrorMessage(err, 'Could not load the voucher.')))
  }, [voucherId])

  if (!voucherId || !mounted) return null
  const typedHere = v && !v.sourceType
  const live = v?.status === 'POSTED'

  const cancel = async (reason: string) => {
    if (!v) return
    setBusy(true)
    try {
      const res = await api.post<{ message: string }>(`/accounts/vouchers/${v.id}/cancel`, { reason })
      setCancelling(false)
      onChanged(res.message)
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not cancel the voucher.'))
      setCancelling(false)
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-6" onClick={onClose}>
      <div className="glass-card flex max-h-full w-full max-w-4xl flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="vv-title" onClick={(e) => e.stopPropagation()}>
        <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <BookOpenCheck size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="vv-title" className="text-foreground flex items-center gap-2 truncate text-xl font-semibold tracking-tight">
                <span className="font-mono">{v?.voucherNo ?? 'Voucher'}</span>
                {v && <span className={KIND_BADGE[v.kind]}>{v.kindLabel}</span>}
                {v?.status === 'CANCELLED' && <span className="badge-danger">Cancelled</span>}
              </h2>
              {v && (
                <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                  {day(v.date)} · ₹{inr(v.amount)}
                  {v.mode && ` · ${modeLabel(v.mode)}`}
                  {v.chequeNo && ` · cheque ${v.chequeNo}${v.chequeDate ? ` of ${day(v.chequeDate)}` : ''}`}
                  {v.referenceNo && ` · ${v.referenceNo}`}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {typedHere && live && can('accounts', 'edit') && (
              <button type="button" className="btn-secondary" onClick={() => onAlter(v.id, v.kind as ManualKind)}>
                <Pencil size={15} /> Alter
              </button>
            )}
            {typedHere && live && can('accounts', 'delete') && (
              <button type="button" className="btn-danger" onClick={() => setCancelling(true)}>
                <Ban size={15} /> Cancel
              </button>
            )}
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error && (
            <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
              <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}
          {!v && !error && <div className="skeleton h-48 w-full rounded-xl" />}
          {v && (
            <>
              {v.sourceType && (
                <p className="text-muted-foreground text-xs">Written by its {v.kindLabel.toLowerCase()} document; it changes when the document does.</p>
              )}
              {v.status === 'CANCELLED' && (
                <div className="border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-sm">
                  <p className="text-destructive font-medium">Cancelled{v.cancelledBy ? ` by ${v.cancelledBy.name}` : ''}{v.cancelledAt ? ` on ${when(v.cancelledAt)}` : ''}</p>
                  {v.cancelReason && <p className="text-muted-foreground mt-0.5">{v.cancelReason}</p>}
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="data-table table-totals w-full">
                  <thead>
                    <tr>
                      <th>Ledger</th>
                      <th>Brand</th>
                      <th className="text-right">Debit ₹</th>
                      <th className="text-right">Credit ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.lines.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {onOpenLedger ? (
                            <button type="button" className="text-primary text-left hover:underline" onClick={() => onOpenLedger(l.ledger.id)}>
                              {l.ledger.name}
                            </button>
                          ) : (
                            <span className="text-foreground">{l.ledger.name}</span>
                          )}
                          <p className="text-muted-foreground text-[11px]">{l.ledger.group}</p>
                          {l.bills.length > 0 && (
                            <ul className="text-muted-foreground mt-1 space-y-0.5 text-[11px]">
                              {l.bills.map((b, i) => (
                                <li key={i}>
                                  {BILL_KIND_LABEL[b.kind]} <span className="font-mono">{b.billNo}</span>
                                  {b.kind === 'AGAINST_REF' && ` of ${day(b.billDate)}`}
                                  {b.dueDate && b.kind === 'NEW_REF' && `, due ${day(b.dueDate)}`} — ₹{inr(b.amount)}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="text-muted-foreground">{l.costCentre?.name ?? ''}</td>
                        <td className="text-right tabular-nums">{amountOrBlank(l.debit)}</td>
                        <td className="text-right tabular-nums">{amountOrBlank(l.credit)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2} className="text-muted-foreground text-xs">
                        Total
                      </td>
                      <td className="text-right font-semibold tabular-nums">{inr(v.amount)}</td>
                      <td className="text-right font-semibold tabular-nums">{inr(v.amount)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {v.narration && (
                <div>
                  <p className="form-label">Narration</p>
                  <p className="text-foreground text-sm">{v.narration}</p>
                </div>
              )}
              <div>
                <p className="form-label flex items-center gap-1.5">
                  <History size={13} /> History
                </p>
                <ul className="text-muted-foreground space-y-1 text-xs">
                  <li>
                    Entered by {v.createdBy?.name ?? 'the system'} on {when(v.createdAt)}
                  </li>
                  {v.history
                    .filter((h) => h.action !== 'CREATE')
                    .map((h) => (
                      <li key={h.id}>
                        {h.after?.status === 'CANCELLED' ? 'Cancelled' : 'Altered'} by {h.user.name} on {when(h.createdAt)}
                        {h.after?.reason ? ` — ${h.after.reason}` : ''}
                        {h.before?.amount !== undefined && h.after?.amount !== undefined && h.before.amount !== h.after.amount
                          ? ` — ₹${inr(h.before.amount)} → ₹${inr(h.after.amount)}`
                          : ''}
                      </li>
                    ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
      {cancelling && v && (
        <ReasonDialog
          title={`Cancel ${v.voucherNo}?`}
          description="The voucher keeps its number and stays in the day book marked cancelled; its amounts stop counting. This cannot be undone."
          confirmLabel="Cancel voucher"
          danger
          minLength={3}
          busy={busy}
          onConfirm={(reason) => void cancel(reason)}
          onCancel={() => setCancelling(false)}
        />
      )}
    </div>,
    document.body,
  )
}
