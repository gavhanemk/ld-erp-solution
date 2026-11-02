'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, BookOpenCheck, CalendarDays, FileText, Hash, Info, ListOrdered, Loader2, PenLine, Plus, Save, Trash2, Wand2, X } from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { useEscape } from '@/lib/useEscape'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { PAYMENT_MODES } from '@/components/sales/status'
import {
  BILL_KIND_LABEL,
  MANUAL_KINDS,
  day,
  drCr,
  inr,
  r2,
  todayIst,
  type BillKind,
  type CostCentre,
  type Ledger,
  type ManualKind,
  type OpenBill,
} from './books'

interface BillRow {
  key: string
  kind: BillKind
  billNo: string
  dueDate: string
  amount: string
}

interface Line {
  key: string
  ledgerId: string
  /** The side the line is on before an amount is typed; the column typed into decides after. */
  side: 'DR' | 'CR'
  /** What is typed in each column; one of them is empty. */
  debit: string
  credit: string
  costCentreId: string
  bills: BillRow[]
}

interface VoucherDetail {
  id: string
  kind: ManualKind
  voucherNo: string
  date: string
  narration: string | null
  mode: string | null
  referenceNo: string | null
  chequeNo: string | null
  chequeDate: string | null
  lines: Array<{
    side: 'DR' | 'CR'
    amount: number
    costCentre: { id: string } | null
    ledger: { id: string }
    bills: Array<{ kind: BillKind; billNo: string; dueDate: string | null; amount: number }>
  }>
}

let seq = 0
const key = () => `k${++seq}`
const num = (s: string) => (s.trim() === '' ? 0 : Number(s) || 0)
const sideOf = (l: Line): 'DR' | 'CR' => (num(l.debit) > 0 ? 'DR' : num(l.credit) > 0 ? 'CR' : l.side)
const amountOf = (l: Line) => num(l.debit) || num(l.credit)
const blankLine = (side: 'DR' | 'CR', ledgerId = ''): Line => ({ key: key(), ledgerId, side, debit: '', credit: '', costCentreId: '', bills: [] })
const IS_CHEQUE = new Set(['CHEQUE', 'PDC'])

/**
 * Which ledgers a line may take, by voucher type and side, so the list only
 * offers what the server would accept: a contra moves money only, a journal
 * never touches it, and a payment's debit or a receipt's credit is the party
 * or the expense, not another bank.
 */
function allowed(kind: ManualKind, side: 'DR' | 'CR', l: Ledger) {
  if (kind === 'CONTRA') return l.isMoney
  if (kind === 'JOURNAL') return !l.isMoney
  if (kind === 'PAYMENT' && side === 'DR') return !l.isMoney
  if (kind === 'RECEIPT' && side === 'CR') return !l.isMoney
  return true
}

/** The side each line of a new voucher starts on, first line first. */
const FIRST_SIDE: Record<ManualKind, ['DR' | 'CR', 'DR' | 'CR']> = {
  PAYMENT: ['DR', 'CR'],
  RECEIPT: ['CR', 'DR'],
  CONTRA: ['DR', 'CR'],
  JOURNAL: ['DR', 'CR'],
}

/**
 * Entering a voucher — Contra, Payment, Receipt or Journal — the way an
 * accountant used to SAB or Tally enters one.
 *
 * Lines of debit and credit; type into either column. A line left without an
 * amount is filled with whatever the others leave unbalanced, so a two-line
 * payment is typed once. A party kept bill by bill opens a row under its line
 * for the bills it raises or settles: "Settle oldest first" takes the open
 * bills in date order until the money runs out, and whatever is not placed
 * goes on account. Income and expense lines carry a brand, so profit can be
 * read brand by brand.
 *
 * F4, F5, F6 and F7 switch a new voucher between Contra, Payment, Receipt and
 * Journal, as they do in Tally. Opened with `voucherId`, it alters that
 * voucher instead; its type and number stay.
 */
export function VoucherDialog({
  open,
  kind: startKind = 'PAYMENT',
  voucherId,
  booksStart,
  onClose,
  onSaved,
}: {
  open: boolean
  kind?: ManualKind
  voucherId?: string | null
  booksStart: string | null
  onClose: () => void
  onSaved: (message: string, id: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const altering = !!voucherId

  const [ledgers, setLedgers] = useState<Ledger[]>([])
  const [centres, setCentres] = useState<CostCentre[]>([])
  const [bills, setBills] = useState<Record<string, OpenBill[]>>({})
  const [loading, setLoading] = useState(false)

  const [kind, setKind] = useState<ManualKind>(startKind)
  const [voucherNo, setVoucherNo] = useState<string | null>(null)
  const [date, setDate] = useState(todayIst())
  const [mode, setMode] = useState('')
  const [referenceNo, setReferenceNo] = useState('')
  const [chequeNo, setChequeNo] = useState('')
  const [chequeDate, setChequeDate] = useState('')
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<Line[]>([])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEscape(() => {
    if (!saving) onClose()
  }, open)

  const byId = useMemo(() => new Map(ledgers.map((l) => [l.id, l])), [ledgers])
  const moneyLedgers = useMemo(() => ledgers.filter((l) => l.isMoney), [ledgers])
  const defaultMoney = useCallback(
    // Cash for cash; otherwise a current account before a cash-credit or overdraft one.
    (m: string) =>
      (m === 'CASH'
        ? moneyLedgers.find((l) => l.systemKey === 'CASH')
        : moneyLedgers.find((l) => l.partyType === 'BANK' && l.group.systemKey === 'BANK_ACCOUNTS') ?? moneyLedgers.find((l) => l.partyType === 'BANK')) ?? moneyLedgers[0],
    [moneyLedgers],
  )

  /** A new voucher's starting lines: the money side filled in where there is one. */
  const freshLines = useCallback(
    (k: ManualKind, m: string): Line[] => {
      const [first, second] = FIRST_SIDE[k]
      const a = blankLine(first)
      const b = blankLine(second)
      if (k === 'CONTRA') {
        a.ledgerId = defaultMoney('NEFT')?.id ?? ''
        b.ledgerId = moneyLedgers.find((l) => l.systemKey === 'CASH')?.id ?? ''
      } else if (k === 'PAYMENT' || k === 'RECEIPT') {
        b.ledgerId = defaultMoney(m)?.id ?? ''
      }
      return [a, b]
    },
    [defaultMoney, moneyLedgers],
  )

  // ── Loading ──
  useEffect(() => {
    if (!open) return
    let gone = false
    setError(null)
    setLoading(true)
    ;(async () => {
      try {
        const [l, c] = await Promise.all([
          api.get<{ data: Ledger[] }>('/accounts/ledgers?active=1&balances=1'),
          api.get<{ data: CostCentre[] }>('/accounts/cost-centres'),
        ])
        if (gone) return
        setLedgers(l.data)
        setCentres(c.data.filter((x) => x.isActive))
        if (voucherId) {
          const v = (await api.get<{ data: VoucherDetail }>(`/accounts/vouchers/${voucherId}`)).data
          if (gone) return
          setKind(v.kind)
          setVoucherNo(v.voucherNo)
          setDate(v.date)
          setMode(v.mode ?? '')
          setReferenceNo(v.referenceNo ?? '')
          setChequeNo(v.chequeNo ?? '')
          setChequeDate(v.chequeDate ?? '')
          setNarration(v.narration ?? '')
          setLines(
            v.lines.map((x) => ({
              key: key(),
              ledgerId: x.ledger.id,
              side: x.side,
              debit: x.side === 'DR' ? String(x.amount) : '',
              credit: x.side === 'CR' ? String(x.amount) : '',
              costCentreId: x.costCentre?.id ?? '',
              bills: x.bills.map((b) => ({ key: key(), kind: b.kind, billNo: b.billNo, dueDate: b.dueDate ?? '', amount: String(b.amount) })),
            })),
          )
          const parties = [...new Set(v.lines.map((x) => x.ledger.id))].filter((id) => l.data.find((y) => y.id === id)?.billWise)
          const got = await Promise.all(parties.map((id) => api.get<{ data: OpenBill[] }>(`/accounts/ledgers/${id}/bills?exceptVoucherId=${voucherId}`)))
          if (!gone) setBills(Object.fromEntries(parties.map((id, i) => [id, got[i].data])))
        } else {
          setKind(startKind)
          setVoucherNo(null)
          setDate(todayIst())
          setMode('')
          setReferenceNo('')
          setChequeNo('')
          setChequeDate('')
          setNarration('')
          setBills({})
        }
      } catch (err) {
        if (!gone) setError(apiErrorMessage(err, 'Could not load the ledgers.'))
      } finally {
        if (!gone) setLoading(false)
      }
    })()
    return () => {
      gone = true
    }
  }, [open, voucherId, startKind])

  // A new voucher's lines, once the ledgers are in.
  useEffect(() => {
    if (open && !altering && !loading && ledgers.length && lines.length === 0) setLines(freshLines(kind, mode))
  }, [open, altering, loading, ledgers.length, lines.length, freshLines, kind, mode])

  useEffect(() => {
    if (!open) setLines([])
  }, [open])

  const switchKind = useCallback(
    (k: ManualKind) => {
      if (altering || k === kind) return
      setKind(k)
      setLines(freshLines(k, mode))
      setError(null)
    },
    [altering, kind, freshLines, mode],
  )

  // F4–F7 switch the type, as in Tally. Only while this window is the one on top.
  useEffect(() => {
    if (!open || altering) return
    const onKey = (e: KeyboardEvent) => {
      const hit = MANUAL_KINDS.find((m) => m.key === e.key)
      if (!hit || e.ctrlKey || e.altKey || e.metaKey) return
      if (!rootRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return
      e.preventDefault()
      switchKind(hit.kind)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, altering, switchKind])

  const loadBills = useCallback(
    async (ledgerId: string) => {
      if (!ledgerId || bills[ledgerId] || !byId.get(ledgerId)?.billWise) return
      try {
        const res = await api.get<{ data: OpenBill[] }>(`/accounts/ledgers/${ledgerId}/bills${voucherId ? `?exceptVoucherId=${voucherId}` : ''}`)
        setBills((b) => ({ ...b, [ledgerId]: res.data }))
      } catch {
        setBills((b) => ({ ...b, [ledgerId]: [] }))
      }
    },
    [bills, byId, voucherId],
  )

  // ── Editing lines ──
  const intended = sideOf
  const totals = useMemo(() => {
    const dr = r2(lines.reduce((t, l) => t + num(l.debit), 0))
    const cr = r2(lines.reduce((t, l) => t + num(l.credit), 0))
    return { dr, cr, diff: r2(dr - cr) }
  }, [lines])

  const update = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)))

  /** A line left without an amount takes whatever leaves the voucher unbalanced. */
  const balance = () =>
    setLines((ls) => {
      const empty = ls.filter((l) => amountOf(l) === 0 && l.ledgerId)
      if (empty.length !== 1) return ls
      const dr = ls.reduce((t, l) => t + num(l.debit), 0)
      const cr = ls.reduce((t, l) => t + num(l.credit), 0)
      const diff = r2(dr - cr)
      if (diff === 0) return ls
      return ls.map((l) => (l.key === empty[0].key ? { ...l, side: diff > 0 ? ('CR' as const) : ('DR' as const), debit: diff < 0 ? String(-diff) : '', credit: diff > 0 ? String(diff) : '' } : l))
    })

  const addLine = () =>
    setLines((ls) => {
      const dr = ls.reduce((t, l) => t + num(l.debit), 0)
      const cr = ls.reduce((t, l) => t + num(l.credit), 0)
      const diff = r2(dr - cr)
      const line = blankLine(diff > 0 ? 'CR' : 'DR')
      if (diff > 0) line.credit = String(diff)
      if (diff < 0) line.debit = String(-diff)
      return [...ls, line]
    })

  const setLedger = (l: Line, ledgerId: string) => {
    const led = byId.get(ledgerId)
    const pl = led && (led.nature === 'INCOME' || led.nature === 'EXPENSE')
    update(l.key, { ledgerId, bills: [], costCentreId: pl ? l.costCentreId : '' })
    void loadBills(ledgerId)
  }

  /** Open bills of a party the line works against: a credit settles what is owed to us, a debit what we owe. */
  const billsFor = (l: Line) => {
    const side = intended(l)
    return (bills[l.ledgerId] ?? []).filter((b) => (side === 'CR' ? b.pending > 0 : b.pending < 0))
  }

  const settleOldest = (l: Line) => {
    let left = amountOf(l)
    const rows: BillRow[] = []
    for (const b of billsFor(l)) {
      if (left <= 0) break
      const take = r2(Math.min(left, Math.abs(b.pending)))
      rows.push({ key: key(), kind: 'AGAINST_REF', billNo: b.billNo, dueDate: '', amount: String(take) })
      left = r2(left - take)
    }
    if (left > 0) rows.push({ key: key(), kind: 'ON_ACCOUNT', billNo: '', dueDate: '', amount: String(left) })
    update(l.key, { bills: rows })
  }

  const placed = (l: Line) => r2(l.bills.reduce((t, b) => t + num(b.amount), 0))

  // ── Saving ──
  const problem = useMemo(() => {
    if (loading) return 'Loading…'
    const used = lines.filter((l) => l.ledgerId || amountOf(l) > 0)
    if (used.length < 2) return 'A voucher needs a debit and a credit'
    for (const [i, l] of used.entries()) {
      if (!l.ledgerId) return `Line ${i + 1} has no ledger`
      if (amountOf(l) <= 0) return `Line ${i + 1} has no amount`
      if (placed(l) > amountOf(l) + 0.005) return `The bills on line ${i + 1} add up to more than the line`
      for (const b of l.bills) {
        if ((b.kind === 'AGAINST_REF' || b.kind === 'NEW_REF') && !b.billNo.trim()) return `Say which bill on line ${i + 1}`
        if (num(b.amount) <= 0) return `A bill on line ${i + 1} has no amount`
      }
    }
    if (totals.diff !== 0) return `Debits and credits differ by ₹${inr(totals.diff)}`
    return null
  }, [loading, lines, totals.diff])

  const save = async () => {
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError(null)
    const used = lines.filter((l) => l.ledgerId)
    const body = {
      kind,
      date,
      narration: narration.trim() || null,
      mode: kind === 'JOURNAL' ? null : mode || null,
      referenceNo: kind === 'JOURNAL' ? null : referenceNo.trim() || null,
      chequeNo: IS_CHEQUE.has(mode) ? chequeNo.trim() || null : null,
      chequeDate: IS_CHEQUE.has(mode) ? chequeDate || null : null,
      lines: used.map((l) => {
        const amount = amountOf(l)
        let refs = l.bills.filter((b) => num(b.amount) > 0)
        const rest = r2(amount - placed(l))
        // What the bills leave over goes on account, as the line says it will.
        if (refs.length && rest > 0) refs = [...refs, { key: key(), kind: 'ON_ACCOUNT', billNo: '', dueDate: '', amount: String(rest) }]
        return {
          ledgerId: l.ledgerId,
          side: sideOf(l),
          amount,
          costCentreId: l.costCentreId || null,
          bills: refs.map((b) => ({ kind: b.kind, billNo: b.billNo.trim() || null, dueDate: b.kind === 'NEW_REF' && b.dueDate ? b.dueDate : null, amount: num(b.amount) })),
        }
      }),
    }
    try {
      const res = voucherId
        ? await api.patch<{ data: { id: string; voucherNo: string }; message: string }>(`/accounts/vouchers/${voucherId}`, body)
        : await api.post<{ data: { id: string; voucherNo: string }; message: string }>('/accounts/vouchers', body)
      onSaved(res.message, res.data.id)
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the voucher.'))
    } finally {
      setSaving(false)
    }
  }

  if (!open || !mounted) return null
  const meta = MANUAL_KINDS.find((m) => m.kind === kind)!
  const showMoney = kind !== 'JOURNAL'

  const ledgerOptions = (l: Line) => {
    const side = intended(l)
    const list = ledgers.filter((x) => allowed(kind, side, x) || x.id === l.ledgerId)
    const groups = new Map<string, Ledger[]>()
    for (const x of list) groups.set(x.group.name, [...(groups.get(x.group.name) ?? []), x])
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([g, xs]) => (
        <optgroup key={g} label={g}>
          {xs.map((x) => (
            <option key={x.id} value={x.id} data-sub={[x.partyCode, x.balance !== undefined ? `Bal ${drCr(x.balance)}` : null].filter(Boolean).join(' · ')}>
              {x.name}
            </option>
          ))}
        </optgroup>
      ))
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div ref={rootRef} className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="vch-title">
        <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <BookOpenCheck size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="vch-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                {altering ? `Alter ${voucherNo ?? 'voucher'}` : `New ${meta.label}`}
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">{meta.hint}</p>
            </div>
          </div>
          {!altering && (
            <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist" aria-label="Voucher type">
              {MANUAL_KINDS.map((m) => (
                <button
                  key={m.kind}
                  type="button"
                  role="tab"
                  aria-selected={kind === m.kind}
                  aria-keyshortcuts={m.key}
                  onClick={() => switchKind(m.kind)}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                    kind === m.kind ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m.label}
                  <kbd className="text-muted-foreground font-mono text-[10px]">{m.key}</kbd>
                </button>
              ))}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="btn-primary hidden md:inline-flex" onClick={() => void save()} disabled={saving || loading}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {altering ? 'Save changes' : `Save ${meta.label.toLowerCase()}`}
            </button>
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close" disabled={saving}>
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
          {loading ? (
            <div className="skeleton h-72 w-full rounded-xl" />
          ) : (
            <>
              <Section icon={FileText} title="Voucher">
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
                  <div className="min-w-0">
                    <label className="form-label">Voucher no.</label>
                    <div className="relative">
                      <Hash size={14} className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" />
                      <div className="form-input text-muted-foreground pl-9 font-mono">{voucherNo ?? 'Given when saved'}</div>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <label className="form-label" htmlFor="vch-date">
                      Date<span className="text-destructive ml-0.5">*</span>
                    </label>
                    <div className="relative">
                      <CalendarDays size={14} className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2" />
                      <input
                        id="vch-date"
                        type="date"
                        className="form-input pl-9"
                        value={date}
                        min={booksStart ?? undefined}
                        max={todayIst()}
                        onChange={(e) => setDate(e.target.value || todayIst())}
                      />
                    </div>
                  </div>
                  {showMoney && (
                    <>
                      <div className="min-w-0">
                        <label className="form-label" htmlFor="vch-mode">
                          Mode
                        </label>
                        <SmartSelect
                          id="vch-mode"
                          className="form-input"
                          value={mode}
                          onChange={(e) => {
                            const m = e.target.value
                            setMode(m)
                            if (!IS_CHEQUE.has(m)) {
                              setChequeNo('')
                              setChequeDate('')
                            }
                            // Cash goes through the cash ledger; anything else through a bank.
                            if (kind === 'PAYMENT' || kind === 'RECEIPT') {
                              const want = defaultMoney(m)
                              const side = kind === 'PAYMENT' ? 'CR' : 'DR'
                              setLines((ls) =>
                                ls.map((l) => {
                                  const led = byId.get(l.ledgerId)
                                  if (!led?.isMoney || intended(l) !== side || !want || (m === 'CASH') === (led.systemKey === 'CASH')) return l
                                  return { ...l, ledgerId: want.id }
                                }),
                              )
                            }
                          }}
                        >
                          <option value="">Not said</option>
                          {PAYMENT_MODES.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </SmartSelect>
                      </div>
                      {IS_CHEQUE.has(mode) && (
                        <>
                          <div className="min-w-0">
                            <label className="form-label" htmlFor="vch-cheque">
                              Cheque no.
                            </label>
                            <input id="vch-cheque" className="form-input font-mono" maxLength={40} value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} />
                          </div>
                          <div className="min-w-0">
                            <label className="form-label" htmlFor="vch-cheque-date">
                              Date on the cheque
                            </label>
                            <input id="vch-cheque-date" type="date" className="form-input" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} />
                          </div>
                        </>
                      )}
                      <div className="min-w-0">
                        <label className="form-label" htmlFor="vch-ref">
                          {IS_CHEQUE.has(mode) ? 'Drawn on (bank)' : 'UTR / reference'}
                        </label>
                        <input
                          id="vch-ref"
                          className="form-input font-mono"
                          maxLength={60}
                          value={referenceNo}
                          placeholder={mode === 'CASH' ? 'Who took it' : 'As on the bank statement'}
                          onChange={(e) => setReferenceNo(e.target.value)}
                        />
                      </div>
                    </>
                  )}
                </div>
              </Section>

              <Section
                icon={ListOrdered}
                title="Entries"
                actions={
                  <span className={`text-xs tabular-nums ${totals.diff === 0 ? 'text-muted-foreground' : 'text-destructive font-medium'}`}>
                    {totals.diff === 0 ? 'Balanced' : `Out by ₹${inr(totals.diff)} ${totals.diff > 0 ? '(more debit)' : '(more credit)'}`}
                  </span>
                }
              >
                <div className="overflow-x-auto">
                  <table className="data-table table-totals w-full min-w-[760px]">
                    <thead>
                      <tr>
                        <th className="w-10">#</th>
                        <th>Ledger</th>
                        <th className="w-48">Brand</th>
                        <th className="w-40 text-right">Debit ₹</th>
                        <th className="w-40 text-right">Credit ₹</th>
                        <th className="w-10" />
                      </tr>
                    </thead>
                    <tbody data-grid>
                      {lines.map((l, i) => {
                        const led = byId.get(l.ledgerId)
                        const pl = led && (led.nature === 'INCOME' || led.nature === 'EXPENSE')
                        const open = led?.billWise ? billsFor(l) : []
                        const rest = r2(amountOf(l) - placed(l))
                        return (
                          <Fragment key={l.key}>
                            <tr data-grid-row>
                              <td className="text-muted-foreground text-xs tabular-nums">
                                {i + 1}
                                <span className="ml-1 font-mono text-[10px]">{intended(l) === 'CR' ? 'Cr' : 'Dr'}</span>
                              </td>
                              <td>
                                <SmartSelect className="form-input" value={l.ledgerId} onChange={(e) => setLedger(l, e.target.value)} aria-label={`Ledger on line ${i + 1}`}>
                                  <option value="">Choose a ledger</option>
                                  {ledgerOptions(l)}
                                </SmartSelect>
                                {led && (
                                  <p className="text-muted-foreground mt-1 truncate text-[11px]">
                                    {led.group.name}
                                    {led.balance !== undefined && <> · balance {drCr(led.balance)}</>}
                                  </p>
                                )}
                              </td>
                              <td>
                                {pl ? (
                                  <SmartSelect className="form-input" value={l.costCentreId} onChange={(e) => update(l.key, { costCentreId: e.target.value })} aria-label={`Brand on line ${i + 1}`}>
                                    <option value="">Not split</option>
                                    {centres.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.name}
                                      </option>
                                    ))}
                                  </SmartSelect>
                                ) : (
                                  <span className="text-muted-foreground text-xs">—</span>
                                )}
                              </td>
                              <td>
                                <StepInput
                                  decimals
                                  className="form-input text-right tabular-nums"
                                  value={l.debit}
                                  placeholder=""
                                  aria-label={`Debit on line ${i + 1}`}
                                  onValueChange={(v) => update(l.key, { debit: v, ...(num(v) > 0 ? { credit: '', side: 'DR' as const } : {}) })}
                                  onBlur={balance}
                                />
                              </td>
                              <td>
                                <StepInput
                                  decimals
                                  className="form-input text-right tabular-nums"
                                  value={l.credit}
                                  placeholder=""
                                  aria-label={`Credit on line ${i + 1}`}
                                  onValueChange={(v) => update(l.key, { credit: v, ...(num(v) > 0 ? { debit: '', side: 'CR' as const } : {}) })}
                                  onBlur={balance}
                                />
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="btn-ghost p-1.5"
                                  aria-label={`Remove line ${i + 1}`}
                                  data-grid-remove
                                  disabled={lines.length <= 2}
                                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </td>
                            </tr>
                            {led?.billWise && (
                              <tr data-grid-row="sizes">
                                <td />
                                <td colSpan={5} className="pt-0">
                                  <div className="border-border bg-secondary/40 rounded-lg border p-2">
                                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                                      <p className="text-muted-foreground text-xs">
                                        Bills of {led.name}
                                        {open.length > 0 && ` · ${open.length} open`}
                                      </p>
                                      <div className="flex items-center gap-1.5">
                                        {open.length > 0 && amountOf(l) > 0 && (
                                          <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => settleOldest(l)}>
                                            <Wand2 size={13} /> Settle oldest first
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          className="btn-ghost h-7 px-2 text-xs"
                                          onClick={() =>
                                            update(l.key, {
                                              bills: [...l.bills, { key: key(), kind: open.length ? 'AGAINST_REF' : 'NEW_REF', billNo: '', dueDate: '', amount: rest > 0 ? String(rest) : '' }],
                                            })
                                          }
                                        >
                                          <Plus size={13} /> Bill
                                        </button>
                                      </div>
                                    </div>
                                    {l.bills.length === 0 ? (
                                      <p className="text-muted-foreground text-xs">No bill named: the amount goes on account.</p>
                                    ) : (
                                      <div className="space-y-1.5">
                                        {l.bills.map((b) => {
                                          const pick = open.find((o) => o.billNo === b.billNo)
                                          const setBill = (patch: Partial<BillRow>) => update(l.key, { bills: l.bills.map((x) => (x.key === b.key ? { ...x, ...patch } : x)) })
                                          return (
                                            <div key={b.key} className="grid grid-cols-1 items-center gap-1.5 sm:grid-cols-[150px_1fr_140px_130px_32px]">
                                              <SmartSelect className="form-input h-8 text-xs" value={b.kind} onChange={(e) => setBill({ kind: e.target.value as BillKind, billNo: '' })} aria-label="Kind of bill">
                                                {(Object.keys(BILL_KIND_LABEL) as BillKind[]).map((k) => (
                                                  <option key={k} value={k}>
                                                    {BILL_KIND_LABEL[k]}
                                                  </option>
                                                ))}
                                              </SmartSelect>
                                              {b.kind === 'AGAINST_REF' ? (
                                                <SmartSelect className="form-input h-8 text-xs" value={b.billNo} onChange={(e) => setBill({ billNo: e.target.value })} aria-label="Bill">
                                                  <option value="">Choose the bill</option>
                                                  {open.map((o) => (
                                                    <option key={o.billNo} value={o.billNo} data-sub={`${day(o.billDate)} · ${drCr(o.pending)} left`}>
                                                      {o.billNo}
                                                    </option>
                                                  ))}
                                                </SmartSelect>
                                              ) : (
                                                <input
                                                  className="form-input h-8 font-mono text-xs"
                                                  maxLength={40}
                                                  value={b.billNo}
                                                  placeholder={b.kind === 'NEW_REF' ? 'Bill number' : 'Name (optional)'}
                                                  onChange={(e) => setBill({ billNo: e.target.value })}
                                                  aria-label="Bill number"
                                                />
                                              )}
                                              {b.kind === 'NEW_REF' ? (
                                                <input type="date" className="form-input h-8 text-xs" value={b.dueDate} onChange={(e) => setBill({ dueDate: e.target.value })} aria-label="Due date" title="Due date" />
                                              ) : (
                                                <span className="text-muted-foreground truncate text-[11px]">{pick ? `${drCr(pick.pending)} left on it` : ''}</span>
                                              )}
                                              <StepInput decimals className="form-input h-8 text-right text-xs tabular-nums" value={b.amount} onValueChange={(v) => setBill({ amount: v })} aria-label="Amount" />
                                              <button type="button" className="btn-ghost p-1" aria-label="Remove bill" onClick={() => update(l.key, { bills: l.bills.filter((x) => x.key !== b.key) })}>
                                                <X size={13} />
                                              </button>
                                            </div>
                                          )
                                        })}
                                        {rest > 0 && <p className="text-muted-foreground text-[11px]">₹{inr(rest)} not placed against a bill goes on account.</p>}
                                        {rest < 0 && <p className="text-destructive text-[11px]">The bills add up to ₹{inr(-rest)} more than the line.</p>}
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3}>
                          <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={addLine} data-grid-add aria-keyshortcuts="Alt+A">
                            <Plus size={14} /> Add line
                          </button>
                        </td>
                        <td className="text-right font-semibold tabular-nums">{inr(totals.dr)}</td>
                        <td className="text-right font-semibold tabular-nums">{inr(totals.cr)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Section>

              <Section icon={PenLine} title="Narration">
                <textarea
                  className="form-input min-h-[64px]"
                  maxLength={1000}
                  value={narration}
                  placeholder={kind === 'PAYMENT' ? 'Being rent for October paid by NEFT' : kind === 'RECEIPT' ? 'Being amount received against invoice' : 'What this entry is for'}
                  onChange={(e) => setNarration(e.target.value)}
                  aria-label="Narration"
                />
                <p className="text-muted-foreground mt-1.5 flex items-start gap-1.5 text-xs">
                  <Info size={13} className="mt-px shrink-0" />
                  A voucher is never deleted. Once saved it can be altered — the change is kept in its history — or cancelled with a reason.
                </p>
              </Section>
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3 md:hidden">
          <button type="button" className="btn-primary w-full" onClick={() => void save()} disabled={saving || loading}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {altering ? 'Save changes' : `Save ${meta.label.toLowerCase()}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
