'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'

export interface PayableBill {
  id: string
  billNumber: string
  supplierInvoiceNo?: string | null
  balanceAmount: string | number
  supplier: { id: string; name: string }
}

const MODES = [
  { value: 'NEFT', label: 'NEFT' },
  { value: 'RTGS', label: 'RTGS' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'PDC', label: 'Post-dated cheque' },
  { value: 'CASH', label: 'Cash' },
] as const

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Today, as the yyyy-mm-dd a date input wants, in local time rather than UTC. */
function todayValue() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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

  const [amount, setAmount] = useState(String(owing))
  const [mode, setMode] = useState<string>('NEFT')
  const [paymentDate, setPaymentDate] = useState(todayValue())
  const [referenceNo, setReferenceNo] = useState('')
  const [chequeDate, setChequeDate] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isCheque = mode === 'CHEQUE' || mode === 'PDC'
  const needsReference = mode !== 'CASH'
  const value = Number(amount)

  const amountProblem =
    !amount.trim() || Number.isNaN(value)
      ? 'Put an amount in'
      : value <= 0
        ? 'An amount has to be more than zero'
        : value > owing
          ? `Only ₹${money(owing)} is left on this bill`
          : null

  const canSave =
    !amountProblem &&
    !busy &&
    (!needsReference || referenceNo.trim().length > 0) &&
    (!isCheque || chequeDate.length > 0)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>('/purchase/payments', {
        billId: bill.id,
        amount: value,
        mode,
        paymentDate,
        referenceNo: referenceNo.trim() || null,
        chequeDate: isCheque ? chequeDate : null,
        notes: notes.trim() || null,
      })
      onSaved(res.message ?? `Payment recorded against ${bill.billNumber}.`)
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
        className="glass-card w-full max-w-lg p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <h2 id="pay-dialog-title" className="text-foreground text-base font-semibold">
          Record a payment
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {bill.supplier.name} · {bill.billNumber}
          {bill.supplierInvoiceNo ? ` · their invoice ${bill.supplierInvoiceNo}` : ''}
          {' · '}
          <span className="text-foreground font-medium">₹{money(owing)} outstanding</span>
        </p>

        {error && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="form-label">Amount</span>
            <input
              className="form-input h-10"
              type="number"
              step="0.01"
              min="0"
              max={owing}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
            {amountProblem && (
              <span className="mt-1 block text-xs text-red-400">{amountProblem}</span>
            )}
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
            <span className="form-label">How it was paid</span>
            <select
              className="form-input h-10"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value)
                if (e.target.value !== 'CHEQUE' && e.target.value !== 'PDC') setChequeDate('')
              }}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {needsReference && (
            <label className="block">
              <span className="form-label">
                {isCheque ? 'Cheque number' : 'Reference'}
              </span>
              <input
                className="form-input h-10"
                value={referenceNo}
                onChange={(e) => setReferenceNo(e.target.value)}
                placeholder={isCheque ? 'As written on the cheque' : 'UTR or transaction reference'}
              />
            </label>
          )}

          {isCheque && (
            <label className="block">
              <span className="form-label">Date on the cheque</span>
              <input
                className="form-input h-10"
                type="date"
                value={chequeDate}
                onChange={(e) => setChequeDate(e.target.value)}
              />
            </label>
          )}

          <label className="block sm:col-span-2">
            <span className="form-label">Notes</span>
            <input
              className="form-input h-10"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth remembering about this payment"
            />
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={!canSave}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            Record payment
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
