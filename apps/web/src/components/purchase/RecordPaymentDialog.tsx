'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Paperclip, X } from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'

export interface PayableBill {
  id: string
  billNumber: string
  supplierInvoiceNo?: string | null
  balanceAmount: string | number
  /** Tax already withheld on the bill itself. Where it is set, the payment cannot withhold again. */
  tdsAmount?: string | number | null
  supplier: { id: string; name: string }
}

interface Warehouse {
  id: string
  name: string
  code: string
}

interface BankAccount {
  id: string
  accountName: string
  bankName: string
  accountNumber: string
}

const MODES = [
  { value: 'NEFT', label: 'NEFT' },
  { value: 'RTGS', label: 'RTGS' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'PDC', label: 'Post-dated cheque' },
  { value: 'CASH', label: 'Cash' },
] as const

/** The same ceiling the API puts on any one document's files. */
const MAX_FILES = 5

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Today, as the yyyy-mm-dd a date input wants, in local time rather than UTC. */
function todayValue() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The last four digits are how anybody at the mill actually names an account. */
function accountLabel(a: BankAccount) {
  const tail = a.accountNumber.slice(-4)
  return `${a.accountName} — ${a.bankName} ···${tail}`
}

/**
 * Records money paid against one bill.
 *
 * Deliberately one bill at a time. A cheque covering four bills is entered
 * four times against the same cheque number, which is how the accounts team
 * already writes it in the book — the cheque is the reference, the bill is
 * what is being settled.
 */
export function RecordPaymentDialog({
  bill,
  onSaved,
  onClose,
}: {
  bill: PayableBill
  onSaved: (message: string) => void
  onClose: () => void
}) {
  const owing = Number(bill.balanceAmount)
  /** What the bill already withholds. Non-zero means this payment must not withhold again. */
  const billTds = Number(bill.tdsAmount ?? 0)

  const [amount, setAmount] = useState(String(owing))
  const [mode, setMode] = useState<string>('NEFT')
  const [warehouseId, setWarehouseId] = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [paymentDate, setPaymentDate] = useState(todayValue())
  const [deductsTax, setDeductsTax] = useState(false)
  const [tdsAmount, setTdsAmount] = useState('')
  const [referenceNo, setReferenceNo] = useState('')
  const [chequeNo, setChequeNo] = useState('')
  const [chequeDate, setChequeDate] = useState('')
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [accounts, setAccounts] = useState<BankAccount[]>([])

  // Both lists are short and rarely change, so they are fetched once and the
  // dialog opens usable even if one of them fails — a payment that cannot be
  // recorded because a dropdown would not load helps nobody.
  useEffect(() => {
    void (async () => {
      const [w, a] = await Promise.allSettled([
        masterResource<Warehouse>('warehouses').list({ limit: 100, active: true }),
        masterResource<BankAccount>('bank-accounts').list({ limit: 100, active: true }),
      ])
      if (w.status === 'fulfilled') setWarehouses(w.value.data)
      if (a.status === 'fulfilled') setAccounts(a.value.data)
    })()
  }, [])

  const isCheque = mode === 'CHEQUE' || mode === 'PDC'
  const isCash = mode === 'CASH'
  const needsReference = !isCheque && !isCash
  const value = Number(amount)
  const tds = deductsTax ? Number(tdsAmount) : 0
  /** Cash and the deduction together are what actually clears the bill. */
  const settles = (Number.isFinite(value) ? value : 0) + (Number.isFinite(tds) ? tds : 0)

  const amountProblem =
    !amount.trim() || Number.isNaN(value)
      ? 'Put an amount in'
      : value <= 0
        ? 'An amount has to be more than zero'
        : settles > owing + 0.005
          ? tds > 0
            ? `That and the tax deducted come to ₹${money(settles)} — only ₹${money(owing)} is left`
            : `Only ₹${money(owing)} is left on this bill`
          : null

  const tdsProblem =
    !deductsTax
      ? null
      : !tdsAmount.trim() || Number.isNaN(tds)
        ? 'Put the tax deducted in'
        : tds <= 0
          ? 'A deduction has to be more than zero'
          : null

  /**
   * What is still outstanding, in the order it appears on the form.
   *
   * Named rather than reduced to one boolean that switches the button off: a
   * dead button answers a press with nothing, and half of these fields show
   * only a grey hint until they are asked for.
   */
  const missing: string[] = []
  if (amountProblem) missing.push(amountProblem.toLowerCase())
  if (tdsProblem) missing.push(tdsProblem.toLowerCase())
  if (!isCash && !bankAccountId) missing.push('which account it was paid from')
  if (needsReference && !referenceNo.trim()) missing.push('the transaction reference')
  if (isCheque && !chequeNo.trim()) missing.push('the cheque number')
  if (isCheque && !chequeDate) missing.push('the date on the cheque')

  /** Files are held until the payment exists, because a file needs something to hang off. */
  function chooseFiles(list: FileList | null) {
    if (!list?.length) return
    const room = MAX_FILES - files.length
    const chosen = Array.from(list).slice(0, Math.max(0, room))
    if (chosen.length < list.length) {
      setError(`Only ${MAX_FILES} files can go on one payment.`)
    }
    setFiles((prev) => [...prev, ...chosen])
  }

  async function uploadOne(file: File, paymentId: string) {
    const signed = await api.post<{ data: { uploadUrl: string; storagePath: string } }>(
      `/purchase/payments/${paymentId}/attachments/upload-url`,
      { fileName: file.name, sizeBytes: file.size }
    )
    // The token is in the URL's query string, which is the whole
    // authorisation. No header, and deliberately not our own API token.
    const put = await fetch(signed.data.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    if (!put.ok) throw new Error('could not be sent')
    await api.post(`/purchase/payments/${paymentId}/attachments`, {
      fileName: file.name,
      storagePath: signed.data.storagePath,
    })
  }

  async function save() {
    if (missing.length) {
      setError(
        missing.length === 1
          ? `Still to fill in: ${missing[0]}.`
          : `Still to fill in: ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}.`,
      )
      return
    }

    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { id: string } }>(
        '/purchase/payments',
        {
          billId: bill.id,
          warehouseId: warehouseId || null,
          bankAccountId: bankAccountId || null,
          amount: value,
          tdsAmount: tds || undefined,
          mode,
          paymentDate,
          referenceNo: referenceNo.trim() || null,
          chequeNo: isCheque ? chequeNo.trim() : null,
          chequeDate: isCheque ? chequeDate : null,
          notes: notes.trim() || null,
        }
      )

      // The payment is already recorded by this point. A file that will not go
      // up is worth saying out loud, but it is not a reason to pretend the
      // money was not paid.
      const failed: string[] = []
      for (const file of files) {
        try {
          await uploadOne(file, res.data.id)
        } catch {
          failed.push(file.name)
        }
      }

      const saved = res.message ?? `Payment recorded against ${bill.billNumber}.`
      onSaved(
        failed.length
          ? `${saved} ${failed.length === 1 ? 'This file' : 'These files'} did not attach: ${failed.join(', ')}.`
          : saved
      )
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach the server. Is the API running?'
      )
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-card flex max-h-[92vh] w-full max-w-2xl flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="border-border shrink-0 border-b px-5 py-4">
          <h2 id="pay-dialog-title" className="text-foreground text-base font-semibold">
            Record a payment
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {bill.supplier.name} · {bill.billNumber}
            {bill.supplierInvoiceNo ? ` · their invoice ${bill.supplierInvoiceNo}` : ''}
            {' · '}
            <span className="text-foreground font-medium">₹{money(owing)} outstanding</span>
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="form-label">Location</span>
              <select
                className="form-input h-10"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                <option value="">Head office</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="form-label">Paid on</span>
              <input
                className="form-input h-10"
                type="date"
                max={todayValue()}
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </label>

            <label className="block">
              <span className="form-label">
                Amount<span className="ml-0.5 text-red-400">*</span>
              </span>
              <input
                className="form-input h-10"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
              {amountProblem && (
                <span className="mt-1 block text-xs text-red-400">{amountProblem}</span>
              )}
            </label>

            <label className="block">
              <span className="form-label">
                How it was paid<span className="ml-0.5 text-red-400">*</span>
              </span>
              <select
                className="form-input h-10"
                value={mode}
                onChange={(e) => {
                  const next = e.target.value
                  setMode(next)
                  if (next !== 'CHEQUE' && next !== 'PDC') {
                    setChequeNo('')
                    setChequeDate('')
                  }
                }}
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block sm:col-span-2">
              <span className="form-label">
                Paid through
                {!isCash && <span className="ml-0.5 text-red-400">*</span>}
              </span>
              <select
                className="form-input h-10"
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
              >
                <option value="">{isCash ? 'Cash in hand' : 'Select an account...'}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
              {!isCash && !bankAccountId && (
                <span className="text-muted-foreground mt-1 block text-xs">
                  {accounts.length === 0
                    ? 'No accounts set up yet — add one under Masters → Bank Accounts.'
                    : 'Which account the money left. It is what the bank statement is reconciled against.'}
                </span>
              )}
            </label>

            {needsReference && (
              <label className="block sm:col-span-2">
                <span className="form-label">
                  Reference<span className="ml-0.5 text-red-400">*</span>
                </span>
                <input
                  className="form-input h-10"
                  value={referenceNo}
                  onChange={(e) => setReferenceNo(e.target.value)}
                  placeholder="UTR or transaction reference"
                />
              </label>
            )}

            {isCheque && (
              <>
                <label className="block">
                  <span className="form-label">
                    Cheque number<span className="ml-0.5 text-red-400">*</span>
                  </span>
                  <input
                    className="form-input h-10"
                    value={chequeNo}
                    onChange={(e) => setChequeNo(e.target.value)}
                    placeholder="As written on the cheque"
                  />
                </label>

                <label className="block">
                  <span className="form-label">
                    Date on the cheque<span className="ml-0.5 text-red-400">*</span>
                  </span>
                  <input
                    className="form-input h-10"
                    type="date"
                    value={chequeDate}
                    onChange={(e) => setChequeDate(e.target.value)}
                  />
                </label>

                <label className="block sm:col-span-2">
                  <span className="form-label">Reference</span>
                  <input
                    className="form-input h-10"
                    value={referenceNo}
                    onChange={(e) => setReferenceNo(e.target.value)}
                    placeholder="Anything else that finds it at the bank"
                  />
                </label>
              </>
            )}

            {/* Tax is deducted once. Where the bill already recorded it there
              is nothing to decide here, and offering the tick would invite
              somebody to take it off the supplier twice. */}
            <div className="border-border bg-secondary/30 rounded-lg border p-3 sm:col-span-2">
              {billTds > 0 ? (
                <p className="text-muted-foreground text-xs">
                  <span className="text-foreground font-medium">
                    ₹{money(billTds)} of tax is already deducted on {bill.billNumber}
                  </span>{' '}
                  — which is why only ₹{money(owing)} is outstanding on it. It comes off once, so
                  there is nothing to deduct here.
                </p>
              ) : (
                <>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={deductsTax}
                      onChange={(e) => {
                        setDeductsTax(e.target.checked)
                        if (!e.target.checked) setTdsAmount('')
                      }}
                    />
                    <span className="text-foreground text-sm">
                      Tax deducted from this payment
                      <span className="text-muted-foreground block text-xs">
                        TDS we hold back and pay to the government instead of to the supplier. It
                        settles the bill just as the cash does.
                      </span>
                    </span>
                  </label>

                  {deductsTax && (
                    <div className="mt-3 max-w-xs">
                      <span className="form-label">Tax deducted</span>
                      <input
                        className="form-input h-10"
                        type="number"
                        step="0.01"
                        min="0"
                        value={tdsAmount}
                        onChange={(e) => setTdsAmount(e.target.value)}
                        placeholder="0.00"
                      />
                      {tdsProblem ? (
                        <span className="mt-1 block text-xs text-red-400">{tdsProblem}</span>
                      ) : (
                        <span className="text-muted-foreground mt-1 block text-xs">
                          ₹{money(settles)} comes off {bill.billNumber} in all.
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <label className="block sm:col-span-2">
              <span className="form-label">Notes</span>
              <input
                className="form-input h-10"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything worth remembering about this payment"
              />
            </label>

            <div className="sm:col-span-2">
              <span className="form-label">Files</span>
              <div className="flex flex-wrap items-center gap-2">
                <label className="btn-secondary cursor-pointer text-xs">
                  <Paperclip size={14} />
                  Attach
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      chooseFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                </label>
                {files.length === 0 && (
                  <span className="text-muted-foreground text-xs">
                    The bank advice, the counterfoil, the UTR screenshot — up to {MAX_FILES}.
                  </span>
                )}
                {files.map((f, i) => (
                  <span
                    key={`${f.name}-${i}`}
                    className="border-border bg-secondary/50 flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                  >
                    {f.name}
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setFiles((prev) => prev.filter((_, n) => n !== i))}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
              {/* Said here rather than after the save fails: the payment goes
                in either way, and the file is the part that would be lost. */}
              {files.length > 0 && (
                <span className="text-muted-foreground mt-1.5 block text-xs">
                  Sent once the payment is recorded.
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="border-border flex shrink-0 justify-end gap-2 border-t px-5 py-4">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            Record payment
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
