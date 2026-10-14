'use client'

import { useEffect, useState } from 'react'
import { Landmark } from 'lucide-react'
import { masterResource } from '@/lib/api'
import { Section } from '@/components/purchase/PurchaseOrderDialog'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * How a cash expense was paid — the payment half of the old ERP's
 * "New Cash Expense". The amount is not asked for: it is what the bill leaves
 * to pay after TDS, and the server works it out the same way.
 */

export interface CashPayment {
  mode: string
  bankAccountId: string
  paymentDate: string
  referenceNo: string
  chequeNo: string
  chequeDate: string
}

export const emptyCashPayment = (date: string): CashPayment => ({
  mode: 'CASH',
  bankAccountId: '',
  paymentDate: date,
  referenceNo: '',
  chequeNo: '',
  chequeDate: '',
})

const MODES = [
  { value: 'CASH', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'NEFT', label: 'NEFT' },
  { value: 'RTGS', label: 'RTGS' },
  { value: 'CHEQUE', label: 'Cheque' },
] as const

interface BankAccount {
  id: string
  accountName: string
  bankName: string
  accountNumber: string
}

const accountLabel = (a: BankAccount) => `${a.accountName} — ${a.bankName} ···${a.accountNumber.slice(-4)}`

const inr = (v: number) =>
  v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const isCheque = (mode: string) => mode === 'CHEQUE' || mode === 'PDC'

/** What is still missing before the payment can be saved, in words. */
export function cashPaymentMissing(p: CashPayment): Array<{ what: string; focus: string }> {
  const out: Array<{ what: string; focus: string }> = []
  if (p.mode !== 'CASH' && !p.bankAccountId)
    out.push({ what: 'which account it was paid from', focus: 'cash-account' })
  if (['NEFT', 'RTGS', 'UPI'].includes(p.mode) && !p.referenceNo.trim())
    out.push({ what: 'the transaction reference', focus: 'cash-reference' })
  if (isCheque(p.mode) && !p.chequeNo.trim()) out.push({ what: 'the cheque number', focus: 'cash-cheque-no' })
  if (isCheque(p.mode) && !p.chequeDate) out.push({ what: 'the cheque date', focus: 'cash-cheque-date' })
  return out
}

/** The payment as the API takes it. */
export const cashPaymentPayload = (p: CashPayment) => ({
  mode: p.mode,
  bankAccountId: p.bankAccountId || null,
  paymentDate: p.paymentDate || undefined,
  referenceNo: p.referenceNo.trim() || null,
  chequeNo: isCheque(p.mode) ? p.chequeNo.trim() || null : null,
  chequeDate: isCheque(p.mode) ? p.chequeDate || null : null,
})

export function CashPaymentSection({
  value,
  onChange,
  amount,
}: {
  value: CashPayment
  onChange: (patch: Partial<CashPayment>) => void
  /** What is paid now: the bill less TDS. */
  amount: number
}) {
  const [accounts, setAccounts] = useState<BankAccount[]>([])

  useEffect(() => {
    masterResource<BankAccount>('bank-accounts')
      .list({ limit: 100, active: true })
      .then((r) => setAccounts(r.data))
      .catch(() => {
        // Cash needs no account; the others say so when one is missing.
      })
  }, [])

  const cash = value.mode === 'CASH'
  const cheque = isCheque(value.mode)

  return (
    <Section icon={Landmark} title="Paid Now">
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-4">
        <div>
          <label className="form-label" htmlFor="cash-mode">
            Payment Mode
          </label>
          <SmartSelect
            id="cash-mode"
            className="form-input"
            value={value.mode}
            onChange={(e) =>
              onChange({
                mode: e.target.value,
                ...(isCheque(e.target.value) ? {} : { chequeNo: '', chequeDate: '' }),
              })
            }
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </SmartSelect>
        </div>
        <div className="md:col-span-2">
          <label className="form-label" htmlFor="cash-account">
            Paid Through{!cash && <span className="ml-0.5 text-red-400">*</span>}
          </label>
          <SmartSelect
            id="cash-account"
            className="form-input"
            value={value.bankAccountId}
            onChange={(e) => onChange({ bankAccountId: e.target.value })}
          >
            <option value="">{cash ? 'Cash in hand' : 'Select an account...'}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a)}
              </option>
            ))}
          </SmartSelect>
        </div>
        <div>
          <label className="form-label" htmlFor="cash-date">
            Paid On
          </label>
          <input
            id="cash-date"
            type="date"
            className="form-input"
            value={value.paymentDate}
            onChange={(e) => onChange({ paymentDate: e.target.value })}
          />
        </div>

        {cheque && (
          <>
            <div>
              <label className="form-label" htmlFor="cash-cheque-no">
                Cheque Number<span className="ml-0.5 text-red-400">*</span>
              </label>
              <input
                id="cash-cheque-no"
                className="form-input"
                value={value.chequeNo}
                onChange={(e) => onChange({ chequeNo: e.target.value })}
              />
            </div>
            <div>
              <label className="form-label" htmlFor="cash-cheque-date">
                Cheque Date<span className="ml-0.5 text-red-400">*</span>
              </label>
              <input
                id="cash-cheque-date"
                type="date"
                className="form-input"
                value={value.chequeDate}
                onChange={(e) => onChange({ chequeDate: e.target.value })}
              />
            </div>
          </>
        )}

        <div className={cheque ? 'md:col-span-2' : 'md:col-span-3'}>
          <label className="form-label" htmlFor="cash-reference">
            Reference{['NEFT', 'RTGS', 'UPI'].includes(value.mode) && <span className="ml-0.5 text-red-400">*</span>}
          </label>
          <input
            id="cash-reference"
            className="form-input"
            value={value.referenceNo}
            onChange={(e) => onChange({ referenceNo: e.target.value })}
            placeholder={cash ? 'Voucher number, or who took the cash' : 'UTR or transaction reference'}
          />
        </div>
        <div className="flex items-end justify-between gap-2 md:col-span-1 md:flex-col md:items-end md:justify-end">
          <span className="text-muted-foreground text-xs">Paid now</span>
          <span className="text-foreground text-lg font-semibold tabular-nums">₹{inr(amount)}</span>
        </div>
      </div>
    </Section>
  )
}
