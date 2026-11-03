'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CalendarCheck2, CheckCheck, Landmark, Loader2, RefreshCw, Save, Undo2 } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { VoucherView } from '@/components/accounts/VoucherView'
import { KIND_BADGE, amountOrBlank, day, drCr, inr, r2, todayIst, type Ledger, type VoucherKind } from '@/components/accounts/books'

interface Row {
  lineId: string
  voucherId: string
  date: string
  kind: VoucherKind
  kindLabel: string
  voucherNo: string
  particulars: string
  narration: string | null
  chequeNo: string | null
  referenceNo: string | null
  deposit: number
  withdrawal: number
  bankDate: string | null
  cleared: boolean
}

interface Reco {
  ledger: { id: string; name: string; accountNumber: string; ifscCode: string }
  asOn: string
  booksBalance: number
  notCredited: number
  notDebited: number
  bankBalance: number
  pending: Row[]
  clearedThisMonth: Row[]
}

/**
 * Bank reconciliation: the books against the bank statement.
 *
 * Every deposit and payment the books have put through a bank waits here
 * until the bank shows it. Give each one the date it appears on the
 * statement — "Same day" fills the voucher's own date — and save. What is
 * still waiting explains the gap: the books' balance, less deposits the bank
 * has not credited, plus cheques it has not paid, is what the statement
 * should say. Type the statement's balance to see whether it does.
 */
export default function BankRecoPage() {
  const [banks, setBanks] = useState<Ledger[]>([])
  const [ledgerId, setLedgerId] = useState('')
  const [asOn, setAsOn] = useState(todayIst())
  const [reco, setReco] = useState<Reco | null>(null)
  const [dates, setDates] = useState<Record<string, string>>({})
  const [statement, setStatement] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const may = can('accounts', 'edit')

  useEffect(() => {
    api
      .get<{ data: Ledger[] }>('/accounts/ledgers?money=1')
      .then((r) => {
        const list = r.data.filter((l) => l.partyType === 'BANK')
        setBanks(list)
        const wanted = new URLSearchParams(window.location.search).get('id')
        setLedgerId(list.find((l) => l.id === wanted)?.id ?? list.find((l) => l.isActive)?.id ?? '')
      })
      .catch((err) => setError(apiErrorMessage(err, 'Could not load the bank accounts.')))
  }, [])

  const load = useCallback(async () => {
    if (!ledgerId) return
    setLoading(true)
    setError(null)
    try {
      setReco((await api.get<{ data: Reco }>(`/accounts/bank-reco/${ledgerId}?asOn=${asOn}`)).data)
      setDates({})
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the bank account.'))
    } finally {
      setLoading(false)
    }
  }, [ledgerId, asOn])

  useEffect(() => {
    void load()
  }, [load])

  const changed = useMemo(() => Object.entries(dates).filter(([, v]) => v !== undefined), [dates])

  const save = async (entries: Array<{ lineId: string; bankDate: string | null }>) => {
    setSaving(true)
    setError(null)
    try {
      const res = await api.patch<{ message: string }>('/accounts/bank-reco', { entries })
      setMessage(res.message)
      await load()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the bank dates.'))
    } finally {
      setSaving(false)
    }
  }

  const typed = statement.trim() === '' ? null : Number(statement)
  // The statement's balance as the bank prints it: money we hold is a credit to them, a plus to us.
  const gap = typed === null || !reco ? null : r2(typed - reco.bankBalance)
  // What the bank should show once the dates typed here are saved.
  const afterTyped = useMemo(() => {
    if (!reco) return null
    let credited = 0
    let debited = 0
    for (const r of reco.pending) {
      const d = dates[r.lineId]
      if (d && d <= reco.asOn) {
        credited += r.deposit
        debited += r.withdrawal
      }
    }
    return r2(reco.bankBalance + credited - debited)
  }, [reco, dates])

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Bank Reconciliation</h1>
          <p className="page-subtitle hidden sm:block">The books against the bank statement, entry by entry</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {may && (
            <button
              className="btn-primary"
              onClick={() => void save(changed.map(([lineId, bankDate]) => ({ lineId, bankDate: bankDate || null })))}
              disabled={saving || changed.length === 0}
              data-hotkey="save"
              aria-keyshortcuts="Control+S"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save {changed.length ? `${changed.length} ` : ''}bank date{changed.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>

      <div className="glass-card flex flex-col gap-2 p-3 sm:flex-row sm:flex-wrap sm:items-center">
        <SmartSelect className="form-input h-9 sm:w-[320px]" value={ledgerId} onChange={(e) => setLedgerId(e.target.value)} aria-label="Bank account">
          <option value="">Choose a bank account</option>
          {banks.map((b) => (
            <option key={b.id} value={b.id} data-sub={b.group.name}>
              {b.name}
            </option>
          ))}
        </SmartSelect>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          Statement up to
          <input type="date" className="form-input h-9 w-[150px]" value={asOn} max={todayIst()} onChange={(e) => setAsOn(e.target.value || todayIst())} />
        </label>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      {!ledgerId && banks.length === 0 && !error && (
        <p className="text-muted-foreground text-sm">No bank accounts yet. Add one under Masters → Bank Accounts; its ledger appears here.</p>
      )}

      {reco && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="glass-card overflow-hidden p-0">
            <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-2.5">
              <p className="text-foreground flex items-center gap-2 text-sm font-semibold">
                <Landmark size={15} /> Not yet in the bank on {day(reco.asOn)}
              </p>
              <p className="text-muted-foreground text-xs">{reco.pending.length} entries</p>
            </div>
            {reco.pending.length === 0 ? (
              <p className="text-muted-foreground px-4 py-10 text-center text-sm">Everything in the books up to {day(reco.asOn)} is in the bank. The account is reconciled.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table table-compact w-full min-w-[820px]">
                  <thead>
                    <tr>
                      <th className="w-24">Date</th>
                      <th>Particulars</th>
                      <th className="w-28 whitespace-nowrap text-right">Deposit ₹</th>
                      <th className="w-32 whitespace-nowrap text-right">Withdrawal ₹</th>
                      <th className="w-56">Bank date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reco.pending.map((r, i) => (
                      <tr key={r.lineId} data-row tabIndex={i === 0 ? 0 : -1}>
                        <td className="whitespace-nowrap tabular-nums">{day(r.date)}</td>
                        <td className="max-w-[320px]">
                          <button type="button" className="text-foreground truncate text-left hover:underline" onClick={() => setViewing(r.voucherId)}>
                            {r.particulars}
                          </button>
                          <span className="text-muted-foreground block truncate text-[11px]">
                            <span className={`${KIND_BADGE[r.kind]} mr-1`}>{r.kindLabel}</span>
                            {[r.voucherNo, r.chequeNo ? `Chq ${r.chequeNo}` : null, r.referenceNo].filter(Boolean).join(' · ')}
                          </span>
                        </td>
                        <td className="text-right tabular-nums">{amountOrBlank(r.deposit)}</td>
                        <td className="text-right tabular-nums">{amountOrBlank(r.withdrawal)}</td>
                        <td>
                          <div className="flex items-center gap-1">
                            <input
                              type="date"
                              className="form-input h-8 w-[140px] text-xs"
                              value={dates[r.lineId] ?? r.bankDate ?? ''}
                              min={r.date}
                              max={todayIst()}
                              disabled={!may}
                              onChange={(e) => setDates((d) => ({ ...d, [r.lineId]: e.target.value }))}
                              aria-label={`Bank date for ${r.voucherNo}`}
                            />
                            {may && (
                              <button type="button" className="btn-ghost h-8 whitespace-nowrap px-1.5 text-[11px]" title="The bank shows it on the voucher's own date" onClick={() => setDates((d) => ({ ...d, [r.lineId]: r.date }))}>
                                Same day
                              </button>
                            )}
                          </div>
                          {r.bankDate && r.bankDate > reco.asOn && <span className="text-muted-foreground text-[11px]">In the bank on {day(r.bankDate)}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {may && reco.pending.length > 0 && (
              <div className="border-border flex justify-end border-t px-4 py-2">
                <button
                  type="button"
                  className="btn-ghost h-8 px-2 text-xs"
                  onClick={() => setDates(Object.fromEntries(reco.pending.map((r) => [r.lineId, dates[r.lineId] || r.date])))}
                >
                  <CheckCheck size={14} /> Fill every one with its own date
                </button>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="glass-card space-y-2 p-4 text-sm">
              <p className="text-foreground flex items-center gap-2 font-semibold">
                <CalendarCheck2 size={15} /> On {day(reco.asOn)}
              </p>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Balance by the books</span>
                <span className="tabular-nums">{drCr(reco.booksBalance)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Less deposits the bank has not credited</span>
                <span className="tabular-nums">− {inr(reco.notCredited)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Add payments the bank has not debited</span>
                <span className="tabular-nums">+ {inr(reco.notDebited)}</span>
              </div>
              <div className="border-border flex justify-between gap-3 border-t pt-2 font-semibold">
                <span>The bank should show</span>
                <span className="tabular-nums">{drCr(reco.bankBalance)}</span>
              </div>
              {changed.length > 0 && afterTyped !== null && (
                <p className="text-muted-foreground text-xs">Once the dates typed here are saved: {drCr(afterTyped)}</p>
              )}
            </div>
            <div className="glass-card space-y-2 p-4 text-sm">
              <label className="form-label" htmlFor="stmt">
                The statement says (balance in your favour)
              </label>
              <StepInput id="stmt" decimals min={-99_999_999_999} className="form-input text-right tabular-nums" value={statement} placeholder="0.00" onValueChange={setStatement} />
              {gap !== null &&
                (gap === 0 ? (
                  <p className="badge-success">The statement agrees with the books</p>
                ) : (
                  <p className="text-accent text-xs">
                    Out by ₹{inr(gap)}: {gap > 0 ? 'the bank shows more' : 'the bank shows less'}. Look for an entry not yet in the books — bank charges, interest, a returned cheque — or a bank date still to be filled.
                  </p>
                ))}
            </div>
            {reco.clearedThisMonth.length > 0 && (
              <div className="glass-card overflow-hidden p-0">
                <p className="border-border text-foreground border-b px-4 py-2.5 text-sm font-medium">In the bank this month</p>
                <ul className="max-h-72 divide-y overflow-y-auto text-xs">
                  {reco.clearedThisMonth.map((r) => (
                    <li key={r.lineId} className="border-border flex items-center justify-between gap-2 px-4 py-2">
                      <span className="min-w-0">
                        <span className="text-foreground block truncate">{r.particulars}</span>
                        <span className="text-muted-foreground">
                          {r.voucherNo} · in the bank {day(r.bankDate)} · ₹{inr(r.deposit || r.withdrawal)} {r.deposit ? 'in' : 'out'}
                        </span>
                      </span>
                      {may && (
                        <button type="button" className="btn-ghost h-7 shrink-0 px-1.5" title="Not in the bank after all" aria-label={`Clear the bank date of ${r.voucherNo}`} onClick={() => void save([{ lineId: r.lineId, bankDate: null }])}>
                          <Undo2 size={13} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      <VoucherView voucherId={viewing} onClose={() => setViewing(null)} onAlter={() => setViewing(null)} onChanged={() => void load()} />
    </div>
  )
}
