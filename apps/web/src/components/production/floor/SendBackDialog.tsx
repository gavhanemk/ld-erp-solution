'use client'

import { useMemo, useState } from 'react'
import { Loader2, Undo2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { BundleQtyTable, overRows, type QtyValues } from './BundleQtyTable'
import { bundleRows } from './useFlow'
import { newClientKey, pcs, type Flow } from './types'

/**
 * Failed or damaged pieces sent back to the unit that worked on them, to put
 * right, on a job-work challan of their own. They are held by the unit for
 * rework, and what comes back from it is not charged again.
 */
export function SendBackDialog({ flow, jobWorkOrderId, onClose, onSaved }: { flow: Flow; jobWorkOrderId: string; onClose: () => void; onSaved: (message: string, transferId: string) => void }) {
  const jwo = flow.jobWorkOrders.find((j) => j.id === jobWorkOrderId)!
  const stepId = jwo.step.id
  const has = (bucket: 'REJECTED' | 'DAMAGED') => bundleRows(flow.bundles, { stepId, bucket }).length > 0
  const [from, setFrom] = useState<'REJECTED' | 'DAMAGED'>(has('REJECTED') ? 'REJECTED' : 'DAMAGED')
  const rows = useMemo(() => bundleRows(flow.bundles, { stepId, bucket: from }), [flow, stepId, from])
  const columns = [{ key: 'qty', label: 'Sending back' }]
  const [values, setValues] = useState<QtyValues>({})
  const [reason, setReason] = useState('')
  const [issuedBy, setIssuedBy] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)

  const lines = rows.map((r) => ({ bundleId: r.id, qty: Number(values[r.id]?.qty) || 0 })).filter((l) => l.qty > 0)
  const total = lines.reduce((s, l) => s + l.qty, 0)
  const over = overRows(rows, values, columns)
  const blocker = !lines.length ? 'Enter how many go back.' : over.length ? `${over[0].code} has only ${over[0].available}.` : reason.trim().length < 5 ? 'Say what they are to put right.' : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { id: string } }>(`/production/job-work-orders/${jwo.id}/send-back`, {
        from,
        lines,
        reason: reason.trim(),
        issuedBy: issuedBy.trim() || null,
        vehicleNo: vehicleNo.trim() || null,
        dispatchDate: date,
        clientKey,
      })
      onSaved(res.message ?? 'Sent back.', res.data.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send them back.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Undo2}
      title={`Back to ${jwo.vendor.name} to put right`}
      subtitle={`${jwo.orderNumber} · ${jwo.step.name} for ${flow.mo.moNumber} · on a job-work challan`}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />} Send back {total ? `${pcs(total)} pcs` : ''}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : null}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <label className="block max-w-xs">
        <span className="form-label">Pieces</span>
        <SmartSelect
          className="form-input"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value as 'REJECTED' | 'DAMAGED')
            setValues({})
          }}
        >
          <option value="REJECTED" disabled={!has('REJECTED')}>
            Failed on return
          </option>
          <option value="DAMAGED" disabled={!has('DAMAGED')}>
            Damaged
          </option>
        </SmartSelect>
      </label>
      <Section icon={Undo2} title="Going back">
        <BundleQtyTable rows={rows} columns={columns} values={values} onChange={(row, col, v) => setValues((x) => ({ ...x, [row]: { ...x[row], [col]: v } }))} availableLabel="Here" fill={{ label: 'All of them', column: 'qty' }} empty="None to send back." />
        <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className="form-label">To put right</span>
            <input className="form-input" value={reason} maxLength={500} placeholder="Rewash: patchy colour" onChange={(e) => setReason(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Sent on</span>
            <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Vehicle no.</span>
            <input className="form-input" value={vehicleNo} maxLength={30} onChange={(e) => setVehicleNo(e.target.value.toUpperCase())} />
          </label>
          <label className="block">
            <span className="form-label">Issued by</span>
            <input className="form-input" value={issuedBy} maxLength={120} onChange={(e) => setIssuedBy(e.target.value)} />
          </label>
        </div>
      </Section>
    </FormFrame>
  )
}
