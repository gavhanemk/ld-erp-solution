'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  FileText,
  Hash,
  IndianRupee,
  Info,
  Landmark,
  Loader2,
  Paperclip,
  ReceiptText,
  Save,
  User,
  Wand2,
  X,
} from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { fetchEveryPage } from '@/lib/export'
import { formatDate, formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { AttachmentsBox, type AttachmentsBoxHandle } from '@/components/purchase/AttachmentsBox'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { PAYMENT_MODES } from './status'

interface CustomerOption {
  id: string
  code: string
  name: string
  billingCity: string | null
}

interface BankAccount {
  id: string
  accountName: string
  bankName: string
  accountNumber: string
}

interface OpenInvoice {
  id: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string | null
  totalAmount: string | number
  balanceAmount: string | number
  daysOverdue: number
  so: { soNumber: string; customerPORef: string | null } | null
}

/** A receipt whose money on account is being applied, rather than a new one. */
export interface ReceiptToApply {
  id: string
  receiptNumber: string
  customerId: string
  customerName: string
  onAccount: number
}

const round2 = (n: number) => Math.round(n * 100) / 100
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const today = () => new Date().toISOString().slice(0, 10)
const IS_CHEQUE = new Set(['CHEQUE', 'PDC'])
const NEEDS_REFERENCE = new Set(['NEFT', 'RTGS', 'UPI'])

function Field({
  label,
  icon: Icon,
  htmlFor,
  required = false,
  className = '',
  children,
}: {
  label: string
  icon?: React.ElementType
  htmlFor?: string
  required?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label className="form-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {Icon ? (
        <div className="relative">
          <Icon size={14} className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2" />
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

/**
 * Money received from a customer, and what it settles.
 *
 * One receipt is one sum in — an NEFT, a cheque, cash — and it can settle
 * several invoices at once, the way buyers pay. The customer's invoices still
 * owed are listed oldest first; "Settle oldest first" fills them in order
 * until the money runs out, and anything left stays on account as an advance.
 * TDS the customer deducted is put against the invoice it was deducted on,
 * and settles it just as the cash does.
 *
 * Opened with `apply`, it applies money a receipt holds on account to the
 * customer's invoices instead — an advance meeting the invoices raised since.
 */
export function RecordReceiptDialog({
  open,
  customerId: presetCustomer,
  invoiceId: presetInvoice,
  apply,
  onClose,
  onSaved,
}: {
  open: boolean
  /** The customer to start on, when opened from their row. */
  customerId?: string | null
  /** An invoice to settle first, when opened from it. */
  invoiceId?: string | null
  apply?: ReceiptToApply | null
  onClose: () => void
  onSaved: (message: string, receiptId: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [customerId, setCustomerId] = useState('')
  const [invoices, setInvoices] = useState<OpenInvoice[]>([])
  const [onAccountBefore, setOnAccountBefore] = useState(0)
  const [loadingLists, setLoadingLists] = useState(false)
  const [loadingInvoices, setLoadingInvoices] = useState(false)

  const [receiptDate, setReceiptDate] = useState(today())
  const [mode, setMode] = useState('NEFT')
  const [bankAccountId, setBankAccountId] = useState('')
  const [referenceNo, setReferenceNo] = useState('')
  const [chequeNo, setChequeNo] = useState('')
  const [chequeDate, setChequeDate] = useState('')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  /** What is typed against each invoice: the cash, and any TDS. */
  const [applied, setApplied] = useState<Record<string, { amount: string; tds: string }>>({})
  const filesRef = useRef<AttachmentsBoxHandle>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose, saving])

  // Opening: a clean form, the customers and the accounts.
  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    setReceiptDate(today())
    setMode('NEFT')
    setBankAccountId('')
    setReferenceNo('')
    setChequeNo('')
    setChequeDate('')
    setAmount('')
    setNotes('')
    setApplied({})
    setInvoices([])
    setCustomerId(apply?.customerId ?? presetCustomer ?? '')
    setLoadingLists(true)
    void (async () => {
      try {
        const [c, b] = await Promise.all([
          fetchEveryPage<CustomerOption>((p) => `/masters/customers?active=true&limit=200&page=${p}`),
          masterResource<BankAccount>('bank-accounts')
            .list({ limit: 100, active: true })
            .catch(() => ({ data: [] as BankAccount[] })),
        ])
        if (!alive) return
        setCustomers([...c.rows].sort((x, y) => x.name.localeCompare(y.name)))
        setAccounts(b.data)
        // One account is the usual case: start on it.
        if (b.data.length === 1) setBankAccountId(b.data[0].id)
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : 'Could not load the customers.')
      } finally {
        if (alive) setLoadingLists(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, apply, presetCustomer])

  // Each customer picked: their invoices still owed, and what they hold on account.
  useEffect(() => {
    if (!open || !customerId) {
      setInvoices([])
      setOnAccountBefore(0)
      return
    }
    let alive = true
    setLoadingInvoices(true)
    setApplied({})
    api
      .get<{ data: { invoices: OpenInvoice[]; onAccount: number } }>(`/sales/receipts/open-invoices?customerId=${customerId}`)
      .then((res) => {
        if (!alive) return
        setInvoices(res.data.invoices)
        setOnAccountBefore(res.data.onAccount)
        // Opened from one invoice: that invoice, in full.
        const first = presetInvoice ? res.data.invoices.find((i) => i.id === presetInvoice) : null
        if (first && !apply) {
          const owed = Number(first.balanceAmount)
          setAmount(String(owed))
          setApplied({ [first.id]: { amount: String(owed), tds: '' } })
        }
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the invoices.'))
      .finally(() => alive && setLoadingInvoices(false))
    return () => {
      alive = false
    }
  }, [open, customerId, presetInvoice, apply])

  const available = apply ? apply.onAccount : Number(amount) || 0

  const rows = useMemo(
    () =>
      invoices.map((inv) => {
        const owed = Number(inv.balanceAmount)
        const a = applied[inv.id] ?? { amount: '', tds: '' }
        const cash = Number(a.amount) || 0
        const tds = Number(a.tds) || 0
        return { inv, owed, a, cash, tds, after: round2(owed - cash - tds), over: round2(cash + tds) > owed }
      }),
    [invoices, applied]
  )
  const cashApplied = round2(rows.reduce((s, r) => s + r.cash, 0))
  const tdsApplied = round2(rows.reduce((s, r) => s + r.tds, 0))
  const left = round2(available - cashApplied)
  const owedTotal = round2(rows.reduce((s, r) => s + r.owed, 0))

  /** The money spread over the invoices, oldest first, until it runs out. */
  const settleOldestFirst = () => {
    let money = available
    const next: Record<string, { amount: string; tds: string }> = {}
    for (const r of rows) {
      const room = round2(r.owed - r.tds)
      const take = round2(Math.max(0, Math.min(room, money)))
      next[r.inv.id] = { amount: take > 0 ? String(take) : '', tds: r.a.tds }
      money = round2(money - take)
    }
    setApplied(next)
  }

  const setRow = (id: string, patch: Partial<{ amount: string; tds: string }>) =>
    setApplied((s) => ({ ...s, [id]: { ...(s[id] ?? { amount: '', tds: '' }), ...patch } }))

  const isCheque = IS_CHEQUE.has(mode)
  const isCash = mode === 'CASH'
  const overRow = rows.find((r) => r.over)

  const blocker = !customerId
    ? 'Pick the customer the money came from.'
    : !apply && available <= 0
      ? 'Put in the amount received.'
      : !apply && NEEDS_REFERENCE.has(mode) && !referenceNo.trim()
        ? 'Put in the UTR or transaction reference.'
        : !apply && NEEDS_REFERENCE.has(mode) && !bankAccountId
          ? 'Say which account the money came into.'
          : !apply && isCheque && (!chequeNo.trim() || !chequeDate)
            ? 'Put in the cheque number and the date on the cheque.'
            : overRow
              ? `${overRow.inv.invoiceNumber}: more than the ₹${inr(overRow.owed)} still owed on it.`
              : left < -0.005
                ? `₹${inr(cashApplied)} is applied, more than the ₹${inr(available)} ${apply ? 'on account' : 'received'}.`
                : apply && cashApplied + tdsApplied <= 0
                  ? 'Put an amount against at least one invoice.'
                  : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    const allocations = rows
      .filter((r) => r.cash > 0 || r.tds > 0)
      .map((r) => ({ invoiceId: r.inv.id, amount: r.cash, tdsAmount: r.tds || undefined }))
    try {
      if (apply) {
        const res = await api.post<{ message?: string; data: { id: string } }>(`/sales/receipts/${apply.id}/allocate`, { allocations })
        onSaved(res.message ?? `${apply.receiptNumber} applied.`, res.data.id)
      } else {
        const res = await api.post<{ message?: string; data: { id: string } }>('/sales/receipts', {
          customerId,
          receiptDate,
          mode,
          bankAccountId: bankAccountId || null,
          referenceNo: referenceNo.trim() || null,
          chequeNo: isCheque ? chequeNo.trim() : null,
          chequeDate: isCheque ? chequeDate : null,
          amount: available,
          notes: notes.trim() || null,
          allocations,
        })
        const { failed } = (await filesRef.current?.uploadPending(res.data.id)) ?? { failed: [] }
        const base = res.message ?? 'Receipt recorded.'
        onSaved(
          failed.length ? `${base} ${failed.length === 1 ? 'A file' : `${failed.length} files`} did not attach: ${failed.join(', ')}.` : base,
          res.data.id
        )
      }
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the receipt.')
    } finally {
      setSaving(false)
    }
  }

  if (!open || !mounted) return null
  const busy = saving || loadingLists

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card po-form flex h-full max-h-full w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="rcpt-title">
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-primary/10 border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border">
              <IndianRupee size={19} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h2 id="rcpt-title" className="text-foreground truncate text-xl font-semibold tracking-tight">
                {apply ? 'Apply advance' : 'Payment Received'}
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                {apply
                  ? `${formatRupees(apply.onAccount)} of ${apply.receiptNumber} is on account for ${apply.customerName}`
                  : 'Money in from a customer, and the invoices it settles'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="btn-primary hidden md:inline-flex" onClick={() => void save()} disabled={busy || !!blocker}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {apply ? 'Apply' : 'Save receipt'}
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
          {loadingLists ? (
            <div className="skeleton h-72 w-full rounded-xl" />
          ) : (
            <>
              {!apply && (
                <>
                  <Section icon={FileText} title="Basic Details">
                    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                      <Field label="Customer" icon={User} htmlFor="rcpt-customer" required className="sm:col-span-2">
                        <SmartSelect id="rcpt-customer" className="form-input pl-9" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                          <option value="">Choose a customer</option>
                          {customers.map((c) => (
                            <option key={c.id} value={c.id} data-sub={c.billingCity ?? undefined}>
                              {c.code ? `${c.code} — ${c.name}` : c.name}
                            </option>
                          ))}
                        </SmartSelect>
                      </Field>
                      <Field label="Receipt no." icon={Hash}>
                        <div className="form-input text-muted-foreground pl-9 font-mono">Given when saved</div>
                      </Field>
                      <Field label="Receipt date" htmlFor="rcpt-date" required>
                        <input id="rcpt-date" type="date" className="form-input" value={receiptDate} max={today()} onChange={(e) => setReceiptDate(e.target.value || today())} />
                      </Field>
                      <Field label="Amount received ₹" icon={IndianRupee} htmlFor="rcpt-amount" required>
                        <StepInput id="rcpt-amount" decimals className="form-input pl-9 text-right tabular-nums" value={amount} placeholder="0.00" onValueChange={setAmount} />
                      </Field>
                    </div>
                  </Section>

                  <Section icon={Landmark} title="How the money came in">
                    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                      <Field label="Mode" htmlFor="rcpt-mode" required>
                        <SmartSelect
                          id="rcpt-mode"
                          className="form-input"
                          value={mode}
                          onChange={(e) => {
                            setMode(e.target.value)
                            if (!IS_CHEQUE.has(e.target.value)) {
                              setChequeNo('')
                              setChequeDate('')
                            }
                          }}
                        >
                          {PAYMENT_MODES.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </SmartSelect>
                      </Field>
                      <Field label={isCheque ? 'To be deposited in' : 'Received into'} htmlFor="rcpt-account" required={NEEDS_REFERENCE.has(mode)} className="sm:col-span-2">
                        <SmartSelect id="rcpt-account" className="form-input" value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
                          <option value="">{isCash ? 'Cash in hand' : 'Choose the account'}</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id} data-sub={`${a.bankName} · ••${a.accountNumber.slice(-4)}`}>
                              {a.accountName}
                            </option>
                          ))}
                        </SmartSelect>
                      </Field>
                      {isCheque && (
                        <>
                          <Field label="Cheque no." htmlFor="rcpt-cheque" required>
                            <input id="rcpt-cheque" className="form-input font-mono" maxLength={40} value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} />
                          </Field>
                          <Field label="Date on the cheque" htmlFor="rcpt-cheque-date" required>
                            <input id="rcpt-cheque-date" type="date" className="form-input" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} />
                          </Field>
                        </>
                      )}
                      <Field
                        label={isCheque ? 'Drawn on (bank)' : isCash ? 'Reference' : 'UTR / reference'}
                        htmlFor="rcpt-ref"
                        required={NEEDS_REFERENCE.has(mode)}
                        className={isCheque ? 'lg:col-span-5' : 'sm:col-span-2'}
                      >
                        <input
                          id="rcpt-ref"
                          className="form-input font-mono"
                          maxLength={60}
                          value={referenceNo}
                          placeholder={isCheque ? "The customer's bank" : isCash ? 'Who brought it' : 'As on the bank statement'}
                          onChange={(e) => setReferenceNo(e.target.value)}
                        />
                      </Field>
                    </div>
                    {mode === 'PDC' && (
                      <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs">
                        <Info size={13} className="mt-px shrink-0" />A post-dated cheque settles its invoices now; mark it cleared when the bank credits it,
                        or reverse the receipt if it bounces.
                      </p>
                    )}
                  </Section>
                </>
              )}

              <Section
                icon={ReceiptText}
                title="Invoices it settles"
                actions={
                  invoices.length > 0 ? (
                    <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={settleOldestFirst} disabled={available <= 0}>
                      <Wand2 size={13} /> Settle oldest first
                    </button>
                  ) : undefined
                }
              >
                {!customerId ? (
                  <p className="text-muted-foreground text-sm">Pick the customer to see what they owe.</p>
                ) : loadingInvoices ? (
                  <div className="skeleton h-24 w-full rounded-lg" />
                ) : invoices.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Nothing is owed by this customer.{!apply && ' What is received is kept on account as an advance.'}
                  </p>
                ) : (
                  <>
                    <div className="border-border overflow-x-auto rounded-lg border">
                      <table className="data-table w-full min-w-[860px]">
                        <thead>
                          <tr className="bg-secondary">
                            <th>Invoice</th>
                            <th>Due</th>
                            <th style={{ textAlign: 'right' }}>Total</th>
                            <th style={{ textAlign: 'right' }}>Still owed</th>
                            <th style={{ textAlign: 'right' }}>Received ₹</th>
                            <th style={{ textAlign: 'right' }}>TDS ₹</th>
                            <th style={{ textAlign: 'right' }}>Then owed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.inv.id}>
                              <td className="whitespace-nowrap">
                                <span className="text-foreground font-mono text-xs font-semibold">{r.inv.invoiceNumber}</span>
                                <div className="text-muted-foreground text-[11px]">
                                  {formatDate(r.inv.invoiceDate)}
                                  {r.inv.so ? ` · ${r.inv.so.soNumber}` : ''}
                                </div>
                              </td>
                              <td className="whitespace-nowrap text-xs">
                                {r.inv.dueDate ? formatDate(r.inv.dueDate) : '—'}
                                {r.inv.daysOverdue > 0 && <div className="text-destructive text-[11px] font-medium">{r.inv.daysOverdue} days late</div>}
                              </td>
                              <td className="text-right text-xs tabular-nums">{inr(Number(r.inv.totalAmount))}</td>
                              <td className="text-right font-semibold tabular-nums">{inr(r.owed)}</td>
                              <td className="w-32 text-right">
                                <StepInput
                                  decimals
                                  className={`form-input h-8 w-28 px-2 text-right text-xs tabular-nums ${r.over ? 'border-destructive/60' : ''}`}
                                  value={r.a.amount}
                                  placeholder="0.00"
                                  onValueChange={(v) => setRow(r.inv.id, { amount: v })}
                                  aria-label={`Received against ${r.inv.invoiceNumber}`}
                                />
                              </td>
                              <td className="w-28 text-right">
                                <StepInput
                                  decimals
                                  className={`form-input h-8 w-24 px-2 text-right text-xs tabular-nums ${r.over ? 'border-destructive/60' : ''}`}
                                  value={r.a.tds}
                                  placeholder="0.00"
                                  onValueChange={(v) => setRow(r.inv.id, { tds: v })}
                                  aria-label={`TDS on ${r.inv.invoiceNumber}`}
                                  title="Tax the customer deducted on this invoice"
                                />
                              </td>
                              <td className={`text-right text-xs tabular-nums ${r.after <= 0 && (r.cash || r.tds) ? 'text-primary font-semibold' : ''}`}>
                                {r.after <= 0 && (r.cash || r.tds) ? 'Paid' : inr(Math.max(0, r.after))}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-muted-foreground mt-2 text-xs">
                      TDS is the tax the customer deducted and paid to the government for us. It settles the invoice just as the cash does.
                    </p>
                  </>
                )}

                {customerId && !loadingInvoices && (
                  <div className="border-border bg-secondary/30 mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border px-3 py-2 text-sm sm:grid-cols-4">
                    <div>
                      <p className="text-muted-foreground text-[11px]">Owed in all</p>
                      <p className="text-foreground font-medium tabular-nums">{formatRupees(owedTotal)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-[11px]">{apply ? 'On account' : 'Received'}</p>
                      <p className="text-foreground font-medium tabular-nums">{formatRupees(available)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-[11px]">Applied to invoices</p>
                      <p className="text-foreground font-medium tabular-nums">
                        {formatRupees(cashApplied)}
                        {tdsApplied > 0 && <span className="text-muted-foreground text-xs"> + {formatRupees(tdsApplied)} TDS</span>}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-[11px]">{apply ? 'Left on account' : 'Kept on account'}</p>
                      <p className={`font-medium tabular-nums ${left < 0 ? 'text-destructive' : left > 0 ? 'warn-text' : 'text-foreground'}`}>
                        {formatRupees(Math.max(0, left))}
                      </p>
                    </div>
                  </div>
                )}
                {!apply && onAccountBefore > 0 && (
                  <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs">
                    <Info size={13} className="mt-px shrink-0" />
                    This customer already has {formatRupees(onAccountBefore)} on account from earlier receipts. Apply it from the
                    Receipts list with Apply advance.
                  </p>
                )}
              </Section>

              {!apply && (
                <Section icon={Paperclip} title="Notes and papers">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className="block">
                      <span className="form-label">Notes</span>
                      <textarea className="form-input min-h-[5rem]" rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
                    </label>
                    <div>
                      <span className="form-label">Bank advice, cheque scan, UTR screenshot</span>
                      <AttachmentsBox ref={filesRef} basePath="/sales/receipts" linkBasePath="/sales/receipts/attachments" onError={setError} />
                    </div>
                  </div>
                </Section>
              )}
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3.5">
          {blocker && !loadingLists ? (
            <p className="warn-text mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{blocker}</span>
            </p>
          ) : left > 0.005 && customerId ? (
            <p className="text-muted-foreground mr-auto flex max-w-xl basis-full items-start gap-1.5 text-xs sm:basis-auto">
              <Info size={13} className="mt-px shrink-0" />
              <span>{formatRupees(left)} stays on account, to apply to later invoices.</span>
            </p>
          ) : null}
          <button type="button" onClick={onClose} className="btn-secondary hidden sm:inline-flex" disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !!blocker}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {apply ? 'Apply' : 'Save receipt'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
