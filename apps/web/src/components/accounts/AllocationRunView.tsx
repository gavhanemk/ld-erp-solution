'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ChevronDown, ChevronRight, Split } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { day, inr } from './books'

export interface AllocationRunRow {
  id: string
  runNumber: string
  period: string
  words: string
  status: 'DRAFT' | 'APPROVED' | 'POSTED' | 'REVERSED' | 'DISCARDED'
  notes: string | null
  createdBy: string | null
  createdAt: string
  approvedBy: string | null
  approvedAt: string | null
  postedBy: string | null
  postedAt: string | null
  reversedBy: string | null
  reversedAt: string | null
  reverseReason: string | null
  discardedAt: string | null
  discardReason: string | null
  allocated?: number
}

interface RunDetail extends AllocationRunRow {
  outOfDate: boolean
  lines: Array<{ ledger: string; department: string | null; rule: string; basis: string; sharedAmount: number; splits: Array<{ brand: string; basisValue: number; percent: number; amount: number }> }>
  byBrand: Array<{ brand: string; amount: number }>
  total: number
  sources: Array<{ voucherId: string; voucherNo: string; date: string | null; narration: string | null; ledger: string; department: string | null; amount: number }>
  vouchers: Array<{ id: string; voucherNo: string; reversal: boolean; date: string; amount: number; status: string }>
}

export const RUN_STATUS: Record<AllocationRunRow['status'], { label: string; badge: string }> = {
  DRAFT: { label: 'Draft', badge: 'badge-neutral' },
  APPROVED: { label: 'Approved', badge: 'badge-info' },
  POSTED: { label: 'Posted', badge: 'badge-success' },
  REVERSED: { label: 'Reversed', badge: 'badge-warning' },
  DISCARDED: { label: 'Discarded', badge: 'badge-neutral' },
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
const pct = (p: number) => `${Math.round(p * 100) / 100}%`

/**
 * One month's split of shared expenses: what each brand takes of each shared
 * amount, the expenses it was worked out from, its journals, and the next
 * step — approve, post, reverse — for whoever may take it.
 */
export function AllocationRunView({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (message: string) => void }) {
  const [run, setRun] = useState<RunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<'discard' | 'reverse' | null>(null)
  const [showSources, setShowSources] = useState(false)

  const load = useCallback(async () => {
    try {
      setRun((await api.get<{ data: RunDetail }>(`/accounts/allocation/runs/${id}`)).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not open the run.'))
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message: string }>(`/accounts/allocation/runs/${id}/${path}`, body)
      setAsking(null)
      onChanged(res.message)
      await load()
    } catch (err) {
      setError(apiErrorMessage(err, 'That could not be done.'))
      setAsking(null)
    } finally {
      setBusy(false)
    }
  }

  const may = (action: string) => can('accounts.allocation', action)
  const s = run?.status
  const primary = (() => {
    if (!run) return null
    if (s === 'DRAFT' && may('approve'))
      return (
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void act('approve')}>
          Approve
        </button>
      )
    if (s === 'APPROVED' && may('post'))
      return (
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void act('post')}>
          Post to the books
        </button>
      )
    if (s === 'POSTED' && may('approve'))
      return (
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => setAsking('reverse')}>
          Reverse
        </button>
      )
    return (
      <button type="button" className="btn-ghost" onClick={onClose}>
        Close
      </button>
    )
  })()

  const brandCols = run ? [...new Set(run.lines.flatMap((l) => l.splits.map((x) => x.brand)))] : []

  return (
    <>
      <FormFrame
        icon={Split}
        title={run ? `${run.runNumber} — ${run.words}` : 'Allocation run'}
        subtitle={run ? <span className={RUN_STATUS[run.status].badge}>{RUN_STATUS[run.status].label}</span> : undefined}
        width="max-w-5xl"
        busy={busy}
        error={error}
        onClose={onClose}
        primary={primary}
        primaryInHeader={false}
        footer={
          run && (
            <>
              {(s === 'DRAFT' || s === 'APPROVED') && may('edit') && (
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => void act('rework')}>
                  Work out again
                </button>
              )}
              {(s === 'DRAFT' || s === 'APPROVED') && may('delete') && (
                <button type="button" className="btn-ghost text-destructive" disabled={busy} onClick={() => setAsking('discard')}>
                  Discard
                </button>
              )}
            </>
          )
        }
        footerNote={
          s === 'DRAFT'
            ? 'Approved by someone other than who worked it out (an Admin may approve their own).'
            : s === 'APPROVED'
              ? 'Posting writes one journal on the month’s last day.'
              : s === 'POSTED'
                ? 'Reversing writes a reversing journal; the month can then be run again.'
                : undefined
        }
      >
        {!run && !error && <div className="skeleton h-48 w-full rounded-xl" />}
        {run && (
          <>
            {run.outOfDate && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
                <p className="text-foreground text-sm">
                  {s === 'POSTED'
                    ? `Shared expenses of ${run.words} were booked or changed after this run was posted, so part of the month is not split as it stands. Reverse it and run the month again.`
                    : `Shared expenses of ${run.words} were booked or changed since this was worked out. Work it out again before approving or posting.`}
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <div className="glass-card p-3">
                <p className="text-muted-foreground text-[11px]">Split between the brands</p>
                <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">₹{inr(run.total)}</p>
              </div>
              {run.byBrand.slice(0, 3).map((b) => (
                <div key={b.brand} className="glass-card p-3">
                  <p className="text-muted-foreground truncate text-[11px]">{b.brand} takes</p>
                  <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">₹{inr(b.amount)}</p>
                </div>
              ))}
            </div>

            <div className="border-border overflow-x-auto rounded-lg border">
              <table className="data-table table-compact table-totals w-full min-w-[720px]">
                <thead>
                  <tr>
                    <th>Ledger</th>
                    <th>Department</th>
                    <th>Rule</th>
                    <th className="text-right">Shared</th>
                    {brandCols.map((b) => (
                      <th key={b} className="text-right">
                        {b}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {run.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.ledger}</td>
                      <td>{l.department ?? <span className="text-muted-foreground">None</span>}</td>
                      <td>
                        {l.rule}
                        <span className="text-muted-foreground block text-[11px]">{l.basis}</span>
                      </td>
                      <td className="text-right tabular-nums">{inr(l.sharedAmount)}</td>
                      {brandCols.map((b) => {
                        const x = l.splits.find((y) => y.brand === b)
                        return (
                          <td key={b} className="text-right tabular-nums">
                            {x && x.amount !== 0 ? (
                              <>
                                {inr(x.amount)}
                                <span className="text-muted-foreground block text-[11px]">{pct(x.percent)}</span>
                              </>
                            ) : (
                              ''
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="text-right">
                      Total
                    </td>
                    <td className="text-right tabular-nums">{inr(run.total)}</td>
                    {brandCols.map((b) => (
                      <td key={b} className="text-right tabular-nums">
                        {inr(run.byBrand.find((x) => x.brand === b)?.amount ?? 0)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="text-muted-foreground space-y-0.5 text-xs">
              <p>
                Worked out by {run.createdBy ?? '—'} on {when(run.createdAt)}
                {run.approvedBy && `; approved by ${run.approvedBy} on ${when(run.approvedAt)}`}
                {run.postedBy && `; posted by ${run.postedBy} on ${when(run.postedAt)}`}
                {run.reversedBy && `; reversed by ${run.reversedBy} on ${when(run.reversedAt)}`}
              </p>
              {run.reverseReason && <p>Reversed because: {run.reverseReason}</p>}
              {run.discardReason && <p>Discarded because: {run.discardReason}</p>}
              {run.notes && <p>Note: {run.notes}</p>}
            </div>

            {run.vouchers.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground text-xs">In the books:</span>
                {run.vouchers.map((v) => (
                  <Link key={v.id} href={`/accounts/vouchers?open=${v.id}`} className="text-primary font-mono text-xs hover:underline">
                    {v.voucherNo} ({v.reversal ? 'reversal' : 'journal'}, {day(v.date)})
                  </Link>
                ))}
              </div>
            )}

            <div className="border-border rounded-lg border">
              <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium" onClick={() => setShowSources(!showSources)}>
                {showSources ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                The expenses it split ({run.sources.length})
              </button>
              {showSources && (
                <div className="overflow-x-auto">
                  <table className="data-table table-compact w-full min-w-[640px]">
                    <thead>
                      <tr>
                        <th className="w-28">Date</th>
                        <th className="w-36">Voucher</th>
                        <th>Ledger</th>
                        <th>Department</th>
                        <th className="text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.sources.map((x, i) => (
                        <tr key={`${x.voucherId}-${i}`}>
                          <td className="whitespace-nowrap tabular-nums">{day(x.date)}</td>
                          <td>
                            <Link href={`/accounts/vouchers?open=${x.voucherId}`} className="text-primary font-mono text-xs hover:underline">
                              {x.voucherNo}
                            </Link>
                          </td>
                          <td>{x.ledger}</td>
                          <td>{x.department ?? ''}</td>
                          <td className="text-right tabular-nums">{inr(x.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </FormFrame>
      {asking && run && (
        <ReasonDialog
          title={asking === 'reverse' ? `Reverse ${run.runNumber}?` : `Discard ${run.runNumber}?`}
          description={
            asking === 'reverse'
              ? `A reversing journal (${run.runNumber}-R) undoes the split of ${run.words} in the books; ledger and department totals stay as they are. The month can then be run again.`
              : `Nothing has been posted. The run is kept on record as discarded, and ${run.words} can be run again.`
          }
          confirmLabel={asking === 'reverse' ? 'Reverse the split' : 'Discard the run'}
          danger
          busy={busy}
          onConfirm={(reason) => void act(asking, { reason })}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  )
}
