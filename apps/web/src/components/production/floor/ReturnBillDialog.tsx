'use client'

import { useState } from 'react'
import { Loader2, Receipt } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { StepInput } from '@/components/ui/StepInput'
import type { JobWorkReturn } from './types'

/** Their bill for a return, when it comes: its number and date, and what it charges for. */
export function ReturnBillDialog({ vendor, ret, onClose, onSaved }: { vendor: string; ret: JobWorkReturn; onClose: () => void; onSaved: (message: string) => void }) {
  const [billNo, setBillNo] = useState(ret.billNo ?? '')
  const [billDate, setBillDate] = useState(ret.billDate?.slice(0, 10) ?? '')
  const [chargeQty, setChargeQty] = useState(String(ret.chargeQty))
  const [rate, setRate] = useState(String(ret.chargeRate))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocker = !billNo.trim() ? 'Enter their bill number.' : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(`/production/job-work-returns/${ret.eventId}/bill`, {
        billNo: billNo.trim(),
        billDate: billDate || null,
        chargeQty: Number(chargeQty) || 0,
        rate: Number(rate) || 0,
      })
      onSaved(res.message ?? 'Bill noted.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not note the bill.')
    } finally {
      setSaving(false)
    }
  }

  const amount = (Number(chargeQty) || 0) * (Number(rate) || 0)
  return (
    <FormFrame
      icon={Receipt}
      title={`${vendor}'s bill`}
      subtitle={`For the return${ret.theirChallanNo ? ` on their challan ${ret.theirChallanNo}` : ''}: ${ret.accepted} accepted`}
      width="max-w-xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Receipt size={15} />} Note the bill
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })} before tax`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <label className="block">
          <span className="form-label">Bill no.</span>
          <input className="form-input" value={billNo} maxLength={60} onChange={(e) => setBillNo(e.target.value)} />
        </label>
        <label className="block">
          <span className="form-label">Bill date</span>
          <input type="date" className="form-input" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="form-label">Pieces charged</span>
          <StepInput className="form-input text-right tabular-nums" value={chargeQty} onValueChange={setChargeQty} aria-label="Pieces charged" />
        </label>
        <label className="block">
          <span className="form-label">Rate per piece (₹)</span>
          <StepInput decimals className="form-input text-right tabular-nums" value={rate} onValueChange={setRate} aria-label="Rate per piece" />
        </label>
      </div>
      <p className="text-muted-foreground text-xs">The bill itself is booked in Purchase → Purchase Bills; this ties it to the work it pays for.</p>
    </FormFrame>
  )
}
