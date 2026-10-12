'use client'

import { useMemo, useState } from 'react'
import { Loader2, PackageOpen, Receipt } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { StepInput } from '@/components/ui/StepInput'
import { BundleQtyTable, overRows, type QtyColumn, type QtyValues } from './BundleQtyTable'
import { newClientKey, pcs, type Flow } from './types'

/**
 * Pieces back from an outside unit on a job work order, counted by bundle.
 * Accepted ones are done at the step and can go on; failed and damaged ones
 * wait for a decision — damaged or lost at the unit is chargeable to it.
 * The charge is the agreed rate on what came back good from fresh work:
 * pieces it had to put right are not paid for twice.
 */
export function VendorReturnDialog({ flow, jobWorkOrderId, onClose, onSaved }: { flow: Flow; jobWorkOrderId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const jwo = flow.jobWorkOrders.find((j) => j.id === jobWorkOrderId)!
  const step = flow.steps.find((s) => s.id === jwo.step.id)!
  const rows = useMemo(
    () =>
      flow.bundles
        .map((b) => {
          const work = b.places.filter((p) => p.stepId === step.id && p.vendorId === jwo.vendor.id && p.bucket === 'WIP').reduce((s, p) => s + p.qty, 0)
          const rework = b.places.filter((p) => p.stepId === step.id && p.vendorId === jwo.vendor.id && p.bucket === 'REWORK').reduce((s, p) => s + p.qty, 0)
          return {
            id: b.id,
            code: b.code,
            size: b.size?.code ?? null,
            line: b.line ? `${b.line.style} ${b.line.color}` : null,
            available: work + rework,
            work,
            note: rework ? `${rework} sent back to put right` : null,
            bundleNo: b.bundleNo,
          }
        })
        .filter((r) => r.available > 0)
        .sort((a, b) => a.bundleNo - b.bundleNo),
    [flow, step.id, jwo.vendor.id],
  )
  const columns: QtyColumn[] = [
    { key: 'accepted', label: 'Accepted' },
    { key: 'rejected', label: 'Failed', bad: true },
    { key: 'damaged', label: 'Damaged / lost', bad: true },
  ]
  const [values, setValues] = useState<QtyValues>({})
  const [theirChallanNo, setTheirChallanNo] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [chargeQty, setChargeQty] = useState<string | null>(null)
  const [rate, setRate] = useState(String(jwo.rate))
  const [billNo, setBillNo] = useState('')
  const [billDate, setBillDate] = useState('')
  const [reason, setReason] = useState('')
  const [personName, setPersonName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)

  const v = (id: string, k: string) => Number(values[id]?.[k]) || 0
  const lines = rows.map((r) => ({ bundleId: r.id, accepted: v(r.id, 'accepted'), rejected: v(r.id, 'rejected'), damaged: v(r.id, 'damaged') })).filter((l) => l.accepted + l.rejected + l.damaged > 0)
  // Fresh work comes off first; good pieces from it are what is paid for.
  const freshGood = rows.reduce((s, r) => s + Math.min(v(r.id, 'accepted'), r.work), 0)
  const charge = chargeQty === null ? freshGood : Number(chargeQty) || 0
  const bad = lines.reduce((s, l) => s + l.rejected + l.damaged, 0)
  const over = overRows(rows, values, columns)
  const blocker = !lines.length
    ? 'Enter what came back.'
    : over.length
      ? `${jwo.vendor.name} holds only ${over[0].available} of ${over[0].code}.`
      : bad && reason.trim().length < 3
        ? 'Say what was wrong with the failed or damaged pieces.'
        : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/job-work-orders/${jwo.id}/return`, {
        lines,
        theirChallanNo: theirChallanNo.trim() || null,
        eventDate: date,
        chargeQty: charge,
        rate: rate === '' ? null : Number(rate),
        billNo: billNo.trim() || null,
        billDate: billDate || null,
        reason: reason.trim() || null,
        personName: personName.trim() || null,
        clientKey,
      })
      onSaved(res.message ?? 'Recorded.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the return.')
    } finally {
      setSaving(false)
    }
  }

  const back = lines.reduce((s, l) => s + l.accepted + l.rejected + l.damaged, 0)
  return (
    <FormFrame
      icon={PackageOpen}
      title={`Back from ${jwo.vendor.name}`}
      subtitle={`${jwo.orderNumber} · ${step.name} for ${flow.mo.moNumber} · they hold ${pcs(jwo.held)}`}
      width="max-w-4xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <PackageOpen size={15} />} Record {back ? `${pcs(back)} back` : 'return'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : `Charge ${pcs(charge)} × ₹${rate || 0} = ₹${(charge * (Number(rate) || 0)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={PackageOpen} title="Counted back, bundle by bundle">
        <BundleQtyTable rows={rows} columns={columns} values={values} onChange={(row, col, val) => setValues((x) => ({ ...x, [row]: { ...x[row], [col]: val } }))} availableLabel="With them" fill={{ label: 'All accepted', column: 'accepted' }} empty={`${jwo.vendor.name} holds nothing of this order now.`} />
        <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="form-label">Their challan no.</span>
            <input className="form-input" value={theirChallanNo} maxLength={60} onChange={(e) => setTheirChallanNo(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Received on</span>
            <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Counted by</span>
            <input className="form-input" value={personName} maxLength={120} onChange={(e) => setPersonName(e.target.value)} />
          </label>
          {bad > 0 && (
            <label className="block sm:col-span-2 lg:col-span-1">
              <span className="form-label">What was wrong</span>
              <input className="form-input" value={reason} maxLength={500} placeholder="Uneven wash; 4 torn in the drum" onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
        </div>
      </Section>
      <Section icon={Receipt} title="Their charge">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="form-label">Pieces charged</span>
            <StepInput className="form-input text-right tabular-nums" value={chargeQty ?? String(freshGood)} onValueChange={setChargeQty} aria-label="Pieces charged" />
          </label>
          <label className="block">
            <span className="form-label">Rate per piece (₹)</span>
            <StepInput decimals className="form-input text-right tabular-nums" value={rate} onValueChange={setRate} aria-label="Rate per piece" />
          </label>
          <label className="block">
            <span className="form-label">Their bill no.</span>
            <input className="form-input" value={billNo} maxLength={60} placeholder="When it comes" onChange={(e) => setBillNo(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Bill date</span>
            <input type="date" className="form-input" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </label>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">Pieces charged starts at the good ones from fresh work; pieces sent back to put right are not paid for again. The bill can be noted later.</p>
      </Section>
    </FormFrame>
  )
}
