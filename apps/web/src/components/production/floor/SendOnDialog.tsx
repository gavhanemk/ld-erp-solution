'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Boxes, Factory, Loader2, Send, Truck } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { BundleQtyTable, overRows, type QtyValues } from './BundleQtyTable'
import { bundleRows, sendsFromHand } from './useFlow'
import { newClientKey, pcs, type Flow } from './types'

/**
 * The process transfer: bundles from one step sent to the next on the
 * order's route — never anywhere else. The receiving desk counts them in.
 * To an outside unit it goes on the step's job work order (made the first
 * time) as a job-work challan, and the unit holds the pieces until they come
 * back.
 */

interface Unit {
  id: string
  name: string
  departmentId: string
  type: 'IN_HOUSE' | 'JOB_WORK'
  supplierId: string | null
}
interface Supplier {
  id: string
  name: string
}

export function SendOnDialog({ flow, fromStepId, onClose, onSaved }: { flow: Flow; fromStepId: string; onClose: () => void; onSaved: (message: string, transferId: string) => void }) {
  const from = flow.steps.find((s) => s.id === fromStepId)!
  const to = from.next ? flow.steps.find((s) => s.id === from.next!.id)! : null
  const [outside, setOutside] = useState(to?.execution === 'OUTSOURCED')
  const [vendorId, setVendorId] = useState(to?.workstation?.supplier?.id ?? '')
  const [rate, setRate] = useState(to?.ratePerPiece != null ? String(to.ratePerPiece) : '')
  const [expectedBy, setExpectedBy] = useState('')
  const [issuedBy, setIssuedBy] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [values, setValues] = useState<QtyValues>({})
  const [units, setUnits] = useState<Unit[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)

  // A working step sends straight from in hand; a check or cutting what it has done or passed.
  const fromHand = sendsFromHand(from)
  const rows = useMemo(() => bundleRows(flow.bundles, { stepId: from.id, bucket: fromHand ? ['DONE', 'WIP'] : 'DONE' }), [flow, from.id, fromHand])
  const columns = [{ key: 'qty', label: 'Sending' }]

  useEffect(() => {
    if (!outside) return
    let alive = true
    void Promise.all([masterResource<Unit>('workstations').list({ limit: 300, active: true }), masterResource<Supplier>('suppliers').list({ limit: 500, active: true })])
      .then(([w, s]) => {
        if (!alive) return
        setUnits((w as Paginated<Unit>).data)
        setSuppliers((s as Paginated<Supplier>).data)
      })
      .catch(() => alive && setError('Could not load the outside units.'))
    return () => {
      alive = false
    }
  }, [outside])

  // The units that do this department's work outside come first in the list.
  const theirs = new Set(units.filter((u) => u.type === 'JOB_WORK' && u.departmentId === to?.departmentId && u.supplierId).map((u) => u.supplierId!))
  const vendorOptions = [...suppliers].sort((a, b) => Number(theirs.has(b.id)) - Number(theirs.has(a.id)) || a.name.localeCompare(b.name))
  const openOrder = flow.jobWorkOrders.find((j) => j.status === 'OPEN' && j.step.id === to?.id && j.vendor.id === vendorId)

  const chosen = rows.map((r) => ({ bundleId: r.id, qty: Number(values[r.id]?.qty) || 0 })).filter((l) => l.qty > 0)
  const total = chosen.reduce((s, l) => s + l.qty, 0)
  const over = overRows(rows, values, columns)
  const blocker = !to
    ? `${from.name} is the last step: its pieces go to Finished Goods In.`
    : !chosen.length
      ? 'Enter how many pieces of each bundle are going.'
      : over.length
        ? `${over[0].code} has only ${over[0].available} ready.`
        : outside && !vendorId
          ? 'Say which unit they go to.'
          : null

  const save = async () => {
    if (blocker || !to) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { id: string } }>(`/production/orders/${flow.mo.id}/transfers`, {
        fromStepId: from.id,
        toStepId: to.id,
        vendorId: outside ? vendorId : null,
        rate: outside && !openOrder && rate !== '' ? Number(rate) : null,
        expectedBy: outside && expectedBy ? expectedBy : null,
        lines: chosen,
        issuedBy: issuedBy.trim() || null,
        vehicleNo: outside ? vehicleNo.trim() || null : null,
        notes: notes.trim() || null,
        dispatchDate: date,
        clientKey,
      })
      onSaved(res.message ?? 'Sent.', res.data.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send them.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Send}
      title={`Process transfer from ${from.name}`}
      subtitle={
        to ? (
          <span className="inline-flex items-center gap-1.5">
            {flow.mo.moNumber}: {from.name} <ArrowRight size={12} /> {to.name}
            {outside ? ' at an outside unit, on a job-work challan' : ', to be counted in there'}
          </span>
        ) : (
          `${from.name} is the last step`
        )
      }
      width="max-w-4xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {outside ? 'Send out' : 'Send'} {total ? `${pcs(total)} pcs` : ''}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : `${chosen.length} ${chosen.length === 1 ? 'bundle' : 'bundles'} on one card`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {to && (
        <Section icon={outside ? Truck : Factory} title={outside ? `To an outside unit for ${to.name}` : `To ${to.name} (${to.department.name})`}>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            {to.execution !== 'OUTSOURCED' && (
              <label className="flex items-center gap-2 text-xs sm:col-span-2 lg:col-span-4">
                <input type="checkbox" className="accent-primary" checked={outside} onChange={(e) => setOutside(e.target.checked)} />
                Give this lot to an outside unit instead of our own floor
              </label>
            )}
            {outside && (
              <>
                <label className="block sm:col-span-2">
                  <span className="form-label">Unit</span>
                  <SmartSelect className="form-input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                    <option value="">Pick the unit…</option>
                    {vendorOptions.map((v) => (
                      <option key={v.id} value={v.id} data-sub={theirs.has(v.id) ? `Does ${to.department.name.toLowerCase()} for us` : undefined}>
                        {v.name}
                      </option>
                    ))}
                  </SmartSelect>
                </label>
                <label className="block">
                  <span className="form-label">Rate per piece (₹)</span>
                  {openOrder ? (
                    <div className="form-input text-muted-foreground tabular-nums">₹{openOrder.rate} on {openOrder.orderNumber}</div>
                  ) : (
                    <StepInput decimals className="form-input text-right tabular-nums" value={rate} placeholder="0" onValueChange={setRate} aria-label="Rate per piece" />
                  )}
                </label>
                <label className="block">
                  <span className="form-label">Due back</span>
                  <input type="date" className="form-input" value={expectedBy} min={date} onChange={(e) => setExpectedBy(e.target.value)} />
                </label>
                <label className="block">
                  <span className="form-label">Vehicle no.</span>
                  <input className="form-input" value={vehicleNo} maxLength={30} placeholder="MH 04 AB 1234" onChange={(e) => setVehicleNo(e.target.value.toUpperCase())} />
                </label>
              </>
            )}
            <label className="block">
              <span className="form-label">Sent on</span>
              <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="block">
              <span className="form-label">Issued by</span>
              <input className="form-input" value={issuedBy} maxLength={120} placeholder="Who hands them over" onChange={(e) => setIssuedBy(e.target.value)} />
            </label>
            <label className="block sm:col-span-2">
              <span className="form-label">Note</span>
              <input className="form-input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
          {to.instructions && <p className="text-muted-foreground mt-2 text-xs">For {to.name}: {to.instructions}</p>}
        </Section>
      )}
      <Section icon={Boxes} title={`Bundles ready at ${from.name}`}>
        <BundleQtyTable
          rows={rows}
          columns={columns}
          values={values}
          onChange={(row, col, v) => setValues((x) => ({ ...x, [row]: { ...x[row], [col]: v } }))}
          availableLabel="Ready"
          fill={{ label: 'Send all', column: 'qty' }}
          empty={fromHand ? `Nothing is at ${from.name} to send. Count in what was sent here first.` : `Nothing is ${from.kind === 'CUTTING' ? 'cut' : 'passed'} at ${from.name} yet.`}
        />
      </Section>
    </FormFrame>
  )
}
