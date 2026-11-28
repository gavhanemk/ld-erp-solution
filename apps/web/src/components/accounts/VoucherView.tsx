'use client'

import { useEffect, useState } from 'react'
import { Ban, BookOpenCheck, History, Pencil, Printer, Undo2 } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { modeLabel } from '@/components/sales/status'
import Link from 'next/link'
import { BILL_KIND_LABEL, KIND_BADGE, SOURCE_LABEL, amountOrBlank, day, inr, sourceLink, todayIst, type BillKind, type ManualKind, type VoucherKind } from './books'

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
  /** Every change since revisions were kept: each holds the voucher as it stood before it. */
  revisions: Array<{
    revision: number
    action: RevisionAction
    reason: string | null
    source: string
    changedByName: string | null
    changedAt: string
    periodEventId: string | null
    /** What the change did, in words: "Amount ₹500.00 → ₹750.00". Empty when no figure changed. */
    changes: string[]
  }>
  /** The voucher this reversing entry undoes. */
  reversalOf: { id: string; voucherNo: string; date: string } | null
  /** The reversing entries made against it (a cancelled one no longer undoes it). */
  reversals: Array<{ id: string; voucherNo: string; date: string; status: 'POSTED' | 'CANCELLED' }>
}

type RevisionAction = 'ALTERED' | 'REWRITTEN' | 'BILLS_CHANGED' | 'CANCELLED' | 'REINSTATED' | 'REMOVED' | 'BANK_DATES' | 'REVERSED'

const REVISION_LABEL: Record<RevisionAction, string> = {
  ALTERED: 'Altered',
  REWRITTEN: 'Rewritten with its document',
  BILLS_CHANGED: 'The bills it settles changed',
  CANCELLED: 'Cancelled',
  REINSTATED: 'Stood again with its document',
  REMOVED: 'Taken out of the books',
  BANK_DATES: 'Bank dates set',
  REVERSED: 'Reversed',
}

/** Where a change came from, in words; nothing for a voucher typed in Accounts. */
const sourceWords = (source: string) =>
  source === 'accounts' ? '' : source === 'repost' ? 'posted again from the Day Book' : source === 'bank-reco' ? 'bank reconciliation' : (SOURCE_LABEL[source] ?? source).toLowerCase()

/** A voucher as it stood before one change. */
interface AsItWas {
  revision: number
  voucher: {
    voucherNo: string
    date: string
    narration: string | null
    amount: number
    status: 'POSTED' | 'CANCELLED'
    cancelReason: string | null
    lines: Array<{ ledger: string | null; debit: number; credit: number; costCentre: string | null; department: string | null; bankDate: string | null; bills: Array<{ kind: BillKind; billNo: string; amount: number }> }>
  }
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

/** A titled block of the window, the way the other document windows set theirs out. */
function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-border overflow-hidden rounded-xl border">
      <div className="border-border bg-secondary/40 flex items-center justify-between gap-3 border-b px-4 py-2">
        <h3 className="text-foreground text-xs font-semibold uppercase tracking-wider">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** One labelled figure of the voucher's details. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">{label}</dt>
      <dd className="text-foreground mt-0.5 break-words text-sm">{children}</dd>
    </div>
  )
}

/**
 * One voucher as it stands, in the same frame as every other document
 * window: its details, its entries and the bills each settles, the
 * narration, and everything that happened to it — who entered it, who
 * altered, reversed or cancelled it, when, why and what changed. A voucher
 * typed in Accounts can be altered, reversed or cancelled from here; one
 * written by a sales or purchase document changes only with its document.
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
  // A voucher and its reversing entry open each other: the one shown, starting with the one asked for.
  const [shownId, setShownId] = useState<string | null>(voucherId)
  useEffect(() => setShownId(voucherId), [voucherId])
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [reversing, setReversing] = useState(false)
  const [reverseOn, setReverseOn] = useState(todayIst())
  const [asItWas, setAsItWas] = useState<AsItWas | null>(null)
  const [busy, setBusy] = useState(false)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!shownId) return
    setV(null)
    setError(null)
    setAsItWas(null)
    api
      .get<{ data: Detail }>(`/accounts/vouchers/${shownId}`)
      .then((r) => setV(r.data))
      .catch((err) => setError(apiErrorMessage(err, 'Could not load the voucher.')))
  }, [shownId])

  if (!voucherId || !mounted) return null
  const typedHere = v && !v.sourceType
  const live = v?.status === 'POSTED'
  // Undone by a reversing entry that stands: it stays as it was until that is cancelled.
  const reversedBy = v?.reversals.find((r) => r.status === 'POSTED') ?? null
  const mayAlter = !!(typedHere && live && !reversedBy && !v?.reversalOf && can('accounts', 'edit'))
  const mayReverse = !!(typedHere && live && !reversedBy && !v?.reversalOf && can('accounts', 'delete'))
  const mayCancel = !!(typedHere && live && !reversedBy && can('accounts', 'delete'))

  const showRevision = async (n: number) => {
    if (!v) return
    if (asItWas?.revision === n) return setAsItWas(null)
    try {
      setAsItWas((await api.get<{ data: AsItWas }>(`/accounts/vouchers/${v.id}/revisions/${n}`)).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load that revision.'))
    }
  }

  const reverse = async (reason: string) => {
    if (!v) return
    setBusy(true)
    try {
      const res = await api.post<{ message: string }>(`/accounts/vouchers/${v.id}/reverse`, { date: reverseOn, reason })
      setReversing(false)
      onChanged(res.message)
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not reverse the voucher.'))
      setReversing(false)
    } finally {
      setBusy(false)
    }
  }

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

  const totalDr = v ? v.lines.reduce((t, l) => t + l.debit, 0) : 0
  const totalCr = v ? v.lines.reduce((t, l) => t + l.credit, 0) : 0

  return (
    <>
      <FormFrame
        icon={BookOpenCheck}
        title={v ? `${v.kindLabel} ${v.voucherNo}` : 'Voucher'}
        subtitle={
          v ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className={KIND_BADGE[v.kind]}>{v.kindLabel}</span>
              {v.status === 'CANCELLED' && <span className="badge-danger">Cancelled</span>}
              {reversedBy && <span className="badge-warning">Reversed</span>}
              {v.reversalOf && <span className="badge-neutral">Reversing entry</span>}
              <span>
                {day(v.date)} · ₹{inr(v.amount)}
              </span>
            </span>
          ) : undefined
        }
        primary={
          v ? (
            <a className="btn-primary" href={`/print/voucher/${v.id}`} target="_blank" rel="noreferrer" title="The voucher as it is filed, with room to sign">
              <Printer size={15} /> Print
            </a>
          ) : (
            <button type="button" className="btn-primary" disabled>
              <Printer size={15} /> Print
            </button>
          )
        }
        footer={
          <>
            {mayAlter && v && (
              <button type="button" className="btn-secondary" onClick={() => onAlter(v.id, v.kind as ManualKind)}>
                <Pencil size={15} /> Alter
              </button>
            )}
            {mayReverse && (
              <button
                type="button"
                className="btn-secondary"
                title="Undo it with a reversing entry on an open day; the voucher itself stays as it is. The way to correct a closed month."
                onClick={() => {
                  setReverseOn(todayIst())
                  setReversing(true)
                }}
              >
                <Undo2 size={15} /> Reverse
              </button>
            )}
            {mayCancel && (
              <button type="button" className="btn-danger" onClick={() => setCancelling(true)}>
                <Ban size={15} /> Cancel voucher
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </>
        }
        footerNote={
          v?.sourceType ? (
            <>
              Written by{' '}
              <Link href={sourceLink(v.sourceType, v.voucherNo)} className="text-primary hover:underline">
                {(SOURCE_LABEL[v.sourceType] ?? 'its document').toLowerCase()} {v.voucherNo}
              </Link>
              : it changes, or is cancelled, only with that document.
            </>
          ) : v ? (
            'Typed in Accounts.'
          ) : null
        }
        error={error}
        onClose={onClose}
        busy={busy}
        width="max-w-4xl"
        primaryInHeader
      >
        {!v && !error && <div className="skeleton h-48 w-full rounded-xl" />}
        {v && (
          <>
            {reversedBy && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <p className="text-foreground font-medium">
                  Reversed on {day(reversedBy.date)} by{' '}
                  <button type="button" className="text-primary font-mono hover:underline" onClick={() => setShownId(reversedBy.id)}>
                    {reversedBy.voucherNo}
                  </button>
                </p>
                <p className="text-muted-foreground mt-1">
                  {reversedBy.voucherNo} has the same ledgers with every debit and credit swapped, so the two together come to nothing in the books. This voucher is not changed or deleted: it stays in its own period as the record of what was first entered. If the reversal was a mistake, cancel {reversedBy.voucherNo} and this voucher counts again.
                </p>
              </div>
            )}
            {v.reversalOf && (
              <div className="border-border bg-muted/30 rounded-lg border p-3 text-sm">
                <p className="text-foreground font-medium">
                  This entry reverses{' '}
                  <button type="button" className="text-primary font-mono hover:underline" onClick={() => setShownId(v.reversalOf!.id)}>
                    {v.reversalOf.voucherNo}
                  </button>{' '}
                  of {day(v.reversalOf.date)}
                </p>
                <p className="text-muted-foreground mt-1">
                  Every debit of {v.reversalOf.voucherNo} is a credit here and every credit a debit, so the two together come to nothing. Cancel this entry if {v.reversalOf.voucherNo} should count again.
                </p>
              </div>
            )}
            {v.status === 'CANCELLED' && (
              <div className="border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-sm">
                <p className="text-destructive font-medium">
                  Cancelled{v.cancelledBy ? ` by ${v.cancelledBy.name}` : ''}
                  {v.cancelledAt ? ` on ${when(v.cancelledAt)}` : ''}
                </p>
                {v.cancelReason && <p className="text-muted-foreground mt-0.5">{v.cancelReason}</p>}
              </div>
            )}

            <Section title="Details">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-4">
                <Field label="Voucher no.">
                  <span className="font-mono">{v.voucherNo}</span>
                </Field>
                <Field label="Type">{v.kindLabel}</Field>
                <Field label="Date">{day(v.date)}</Field>
                <Field label="Amount">
                  <span className="font-semibold tabular-nums">₹{inr(v.amount)}</span>
                </Field>
                {v.mode && <Field label="Mode">{modeLabel(v.mode)}</Field>}
                {v.referenceNo && <Field label="Reference / UTR">{v.referenceNo}</Field>}
                {v.chequeNo && (
                  <Field label="Cheque">
                    {v.chequeNo}
                    {v.chequeDate ? ` of ${day(v.chequeDate)}` : ''}
                  </Field>
                )}
                <Field label="Status">{v.status === 'CANCELLED' ? 'Cancelled' : reversedBy ? 'Posted, then reversed' : 'Posted'}</Field>
                <Field label="Entered by">{v.createdBy?.name ?? 'the system'}</Field>
                <Field label="Entered on">{when(v.createdAt)}</Field>
              </dl>
            </Section>

            <Section title="Entries" aside={<span className="text-muted-foreground text-xs">{v.lines.length} {v.lines.length === 1 ? 'line' : 'lines'}</span>}>
              <div className="overflow-x-auto">
                <table className="data-table table-totals w-full min-w-[560px]">
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
                        <td className="text-muted-foreground">{l.costCentre?.name ?? 'Not split'}</td>
                        <td className="text-right tabular-nums">{amountOrBlank(l.debit)}</td>
                        <td className="text-right tabular-nums">{amountOrBlank(l.credit)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2} className="text-foreground font-semibold">
                        Total
                      </td>
                      <td className="text-right font-semibold tabular-nums">{inr(totalDr)}</td>
                      <td className="text-right font-semibold tabular-nums">{inr(totalCr)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Section>

            {v.narration && (
              <Section title="Narration">
                <p className="text-foreground px-4 py-3 text-sm">{v.narration}</p>
              </Section>
            )}

            <Section
              title="History"
              aside={
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <History size={12} /> nothing is ever overwritten
                </span>
              }
            >
              <ol className="divide-border divide-y text-xs">
                <li className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:gap-4">
                  <span className="text-muted-foreground shrink-0 tabular-nums sm:w-36">{when(v.createdAt)}</span>
                  <p className="text-foreground min-w-0 flex-1">
                    <span className="font-semibold">Entered</span>
                    <span className="text-muted-foreground"> by {v.createdBy?.name ?? 'the system'}</span>
                  </p>
                </li>
                {v.history
                  .filter((h) => h.action !== 'CREATE')
                  .map((h) => (
                    <li key={h.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:gap-4">
                      <span className="text-muted-foreground shrink-0 tabular-nums sm:w-36">{when(h.createdAt)}</span>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-foreground">
                          <span className="font-semibold">{h.after?.status === 'CANCELLED' ? 'Cancelled' : 'Altered'}</span>
                          <span className="text-muted-foreground"> by {h.user.name}</span>
                        </p>
                        {h.after?.reason && <p className="text-muted-foreground">Why: “{h.after.reason}”</p>}
                        {h.before?.amount !== undefined && h.after?.amount !== undefined && h.before.amount !== h.after.amount && (
                          <p className="text-foreground">
                            Amount ₹{inr(h.before.amount)} → ₹{inr(h.after.amount)}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                {v.revisions.map((r) => (
                  <li key={r.revision} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:gap-4">
                    <span className="text-muted-foreground shrink-0 tabular-nums sm:w-36">{when(r.changedAt)}</span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-foreground">
                        <span className="font-semibold">{REVISION_LABEL[r.action]}</span>
                        <span className="text-muted-foreground">
                          {' '}
                          by {r.changedByName ?? 'the system'}
                          {sourceWords(r.source) && `, ${sourceWords(r.source)}`}
                        </span>
                        {r.periodEventId && <span className="badge-warning ml-2">while a closed period was reopened</span>}
                      </p>
                      {r.reason && <p className="text-muted-foreground">Why: “{r.reason}”</p>}
                      {r.changes.length > 0 ? (
                        <ul className="text-foreground list-disc space-y-0.5 pl-4">
                          {r.changes.map((c, i) => (
                            <li key={i} className="tabular-nums">
                              {c}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground">{r.action === 'REVERSED' ? 'The voucher itself did not change: the reversing entry undoes it.' : 'No figure on the voucher changed.'}</p>
                      )}
                      <button type="button" className="text-primary hover:underline" onClick={() => void showRevision(r.revision)}>
                        {asItWas?.revision === r.revision ? 'Hide the earlier version' : 'Show the voucher as it was before this'}
                      </button>
                      {asItWas?.revision === r.revision && (
                        <div className="border-border bg-muted/20 mt-1 rounded-lg border p-2">
                          <p className="text-muted-foreground mb-1">
                            Before this change: {day(asItWas.voucher.date)} · ₹{inr(asItWas.voucher.amount)}
                            {asItWas.voucher.status === 'CANCELLED' ? ` · cancelled${asItWas.voucher.cancelReason ? ` (${asItWas.voucher.cancelReason})` : ''}` : ''}
                            {asItWas.voucher.narration ? ` · ${asItWas.voucher.narration}` : ''}
                          </p>
                          <div className="overflow-x-auto">
                            <table className="data-table w-full min-w-[480px] text-xs">
                              <thead>
                                <tr>
                                  <th>Ledger</th>
                                  <th>Brand / department</th>
                                  <th className="text-right">Debit ₹</th>
                                  <th className="text-right">Credit ₹</th>
                                </tr>
                              </thead>
                              <tbody>
                                {asItWas.voucher.lines.map((l, i) => (
                                  <tr key={i}>
                                    <td>
                                      {l.ledger}
                                      {l.bills.length > 0 && <span className="text-muted-foreground"> · {l.bills.map((b) => `${BILL_KIND_LABEL[b.kind]} ${b.billNo} ₹${inr(b.amount)}`).join(', ')}</span>}
                                      {l.bankDate && <span className="text-muted-foreground"> · in the bank {day(l.bankDate)}</span>}
                                    </td>
                                    <td className="text-muted-foreground">{[l.costCentre, l.department].filter(Boolean).join(' / ')}</td>
                                    <td className="text-right tabular-nums">{amountOrBlank(l.debit)}</td>
                                    <td className="text-right tabular-nums">{amountOrBlank(l.credit)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </Section>
          </>
        )}
      </FormFrame>
      {reversing && v && (
        <ReasonDialog
          title={`Reverse ${v.voucherNo}?`}
          description={`A ${v.kind === 'PAYMENT' ? 'receipt' : v.kind === 'RECEIPT' ? 'payment' : v.kindLabel.toLowerCase()} is entered on the day below with the same ledgers, debits and credits swapped, and each bill put back as it was. ${v.voucherNo} itself stays exactly as it is, in its own period.`}
          confirmLabel="Reverse it"
          minLength={5}
          busy={busy}
          onConfirm={(reason) => void reverse(reason)}
          onCancel={() => setReversing(false)}
        >
          <label className="block">
            <span className="form-label">Reversing entry dated</span>
            <input type="date" className="form-input h-10" value={reverseOn} min={v.date} max={todayIst()} onChange={(e) => setReverseOn(e.target.value)} />
          </label>
        </ReasonDialog>
      )}
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
    </>
  )
}
