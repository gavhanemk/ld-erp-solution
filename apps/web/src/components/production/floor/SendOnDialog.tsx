'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Boxes, Factory, Loader2, MapPin, Send, Truck } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { BundleQtyTable, overRows, type QtyValues } from './BundleQtyTable'
import { bundleRows, sendsFromHand } from './useFlow'
import { newClientKey, pcs, type Flow } from './types'

/**
 * The process transfer: bundles from one step sent on to the step the floor
 * picks — any step on the order's route those bundles have not been through
 * yet, the last one only once they have been through all the others. Some
 * bundles can go one way and the rest another, or later. The receiving desk
 * counts them in. To an outside unit it goes on the step's job work order
 * (made the first time) as a job-work challan, and the unit holds the pieces
 * until they come back.
 */

/** Where pieces at a step may go, with how many of each bundle. */
interface Destination {
  stepId: string
  name: string
  last: boolean
  next: boolean
  caps: Record<string, number>
  missing: Record<string, string[]>
}

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
  const [dests, setDests] = useState<Destination[] | null>(null)
  const [toId, setToId] = useState('')
  const to = toId ? (flow.steps.find((s) => s.id === toId) ?? null) : null
  const dest = dests?.find((x) => x.stepId === toId) ?? null
  const [outside, setOutside] = useState(false)
  const [vendorId, setVendorId] = useState('')
  const [rate, setRate] = useState('')
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
  const ready = useMemo(() => bundleRows(flow.bundles, { stepId: from.id, bucket: fromHand ? ['DONE', 'WIP'] : 'DONE' }), [flow, from.id, fromHand])
  const columns = [{ key: 'qty', label: 'Sending' }]
  // What can go where: no more of a bundle than the chosen step still takes.
  const canGo = (d: Destination) => ready.some((r) => (d.caps[r.id] ?? 0) > 0)
  const rows = useMemo(() => (dest ? ready.map((r) => ({ ...r, available: Math.min(r.available, dest.caps[r.id] ?? 0) })).filter((r) => r.available > 0) : []), [ready, dest])
  const heldBack = dest ? ready.length - rows.length : 0

  // The steps it could go to, read fresh from the route and what has been sent already.
  useEffect(() => {
    let alive = true
    api
      .get<{ data: Destination[] }>(`/production/orders/${flow.mo.id}/destinations?fromStepId=${from.id}`)
      .then((r) => {
        if (!alive) return
        setDests(r.data)
        const usable = r.data.filter((x) => ready.some((b) => (x.caps[b.id] ?? 0) > 0))
        // The next one in the route's order when it can take them, else the first that can.
        setToId((usable.find((x) => x.next) ?? usable[0])?.stepId ?? '')
      })
      .catch(() => alive && setError('Could not work out where these bundles can go.'))
    return () => {
      alive = false
    }
    // Read once when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.mo.id, from.id])

  // A different step: its own way of working, unit and rate; the quantities start again.
  useEffect(() => {
    if (!to) return
    setOutside(to.execution === 'OUTSOURCED')
    setVendorId(to.workstation?.supplier?.id ?? '')
    setRate(to.ratePerPiece != null ? String(to.ratePerPiece) : '')
    setValues({})
    // Only when the destination changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toId])

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
  const blocker = from.last
    ? `${from.name} is the last step: its pieces go to Finished Goods In.`
    : !dests
      ? 'Working out where they can go…'
      : !to
        ? 'Pick where the bundles go.'
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
        from.last ? (
          `${from.name} is the last step`
        ) : to ? (
          <span className="inline-flex items-center gap-1.5">
            {flow.mo.moNumber}: {from.name} <ArrowRight size={12} /> {to.name}
            {outside ? ' at an outside unit, on a job-work challan' : ', to be counted in there'}
          </span>
        ) : (
          `${flow.mo.moNumber}: from ${from.name} to the step you pick`
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
      {!from.last && (
        <Section icon={MapPin} title="Where do they go?">
          {!dests ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 size={14} className="animate-spin" /> Working out where they can go…
            </p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {dests.map((x) => {
                  const step = flow.steps.find((s) => s.id === x.stepId)
                  const ok = canGo(x)
                  const picked = x.stepId === toId
                  // Why a step cannot take them: been there already, or the last step with work still to do.
                  const still = [...new Set(ready.flatMap((r) => x.missing[r.id] ?? []))]
                  const why = x.last && still.length ? `After ${still.join(', ')}` : 'Already been through it'
                  return (
                    <button
                      key={x.stepId}
                      type="button"
                      disabled={!ok}
                      onClick={() => setToId(x.stepId)}
                      className={`rounded-lg border p-2.5 text-left transition-colors ${
                        picked ? 'border-primary bg-primary/10 ring-primary/30 ring-2' : ok ? 'border-border hover:border-primary/50' : 'border-border cursor-not-allowed opacity-50'
                      }`}
                      aria-pressed={picked}
                    >
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-foreground text-sm font-semibold">{x.name}</span>
                        {x.next && <span className="badge-info">Next in route</span>}
                        {x.last && <span className="badge-neutral">Last step</span>}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        {step?.department.name}
                        {step?.execution === 'OUTSOURCED' ? ' · outside unit' : ''}
                      </span>
                      {!ok && <span className="text-muted-foreground block text-xs">{why}</span>}
                    </button>
                  )
                })}
              </div>
              {!dests.some(canGo) && (
                <p className="warn-text mt-2 text-sm">
                  These bundles have been through every step they can go to from here. What is left goes into finished goods from the last step.
                </p>
              )}
            </>
          )}
        </Section>
      )}
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
      <Section icon={Boxes} title={to ? `Bundles ready at ${from.name} that can go to ${to.name}` : `Bundles ready at ${from.name}`}>
        {heldBack > 0 && to && (
          <p className="text-muted-foreground mb-2 text-xs">
            {heldBack} more {heldBack === 1 ? 'bundle is' : 'bundles are'} ready here but cannot go to {to.name}
            {dest?.last ? ': they still have other steps to go through' : ': they have already been there'}. Pick another step for {heldBack === 1 ? 'it' : 'them'}.
          </p>
        )}
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
