'use client'

import { useMemo, useState } from 'react'
import { Boxes, ClipboardList, Hammer, Loader2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { BundleQtyTable, overRows, rowTotal, type QtyColumn, type QtyValues } from './BundleQtyTable'
import { bundleRows } from './useFlow'
import { isCheck, newClientKey, pcs, type Flow } from './types'

/**
 * Work done at a step on pieces in hand there, bundle by bundle. At a check:
 * passed, failed, sent for rework, damaged, or set aside as B-grade. At any
 * other step: done, damaged, sent for rework, or B-grade. Whatever is not
 * entered stays in hand. Damaged and failed pieces need a reason, and then
 * wait for a decision.
 */
export function WorkDialog({ flow, stepId, onClose, onSaved }: { flow: Flow; stepId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const step = flow.steps.find((s) => s.id === stepId)!
  const check = isCheck(step)
  const rows = useMemo(() => bundleRows(flow.bundles, { stepId, bucket: 'WIP' }), [flow, stepId])
  const columns: QtyColumn[] = check
    ? [
        { key: 'done', label: 'Passed' },
        { key: 'rework', label: 'Rework' },
        { key: 'rejected', label: 'Failed', bad: true },
        { key: 'damaged', label: 'Damaged', bad: true },
        { key: 'bGrade', label: 'B-grade' },
      ]
    : [
        { key: 'done', label: 'Done' },
        { key: 'rework', label: 'Rework' },
        { key: 'damaged', label: 'Damaged', bad: true },
        { key: 'bGrade', label: 'B-grade' },
      ]
  // Rework from a check usually goes back to the work before it.
  const earlier = flow.steps.filter((s) => s.sequence <= step.sequence)
  const defaultRework = check ? [...earlier].reverse().find((s) => s.id !== step.id && !isCheck(s) && s.kind !== 'CUTTING') ?? step : step
  const [values, setValues] = useState<QtyValues>({})
  const [reworkStepId, setReworkStepId] = useState(defaultRework.id)
  const [reason, setReason] = useState('')
  const [personName, setPersonName] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)

  const sum = (k: string) => rows.reduce((s, r) => s + (Number(values[r.id]?.[k]) || 0), 0)
  const lines = rows
    .map((r) => ({
      bundleId: r.id,
      done: Number(values[r.id]?.done) || 0,
      damaged: Number(values[r.id]?.damaged) || 0,
      rejected: Number(values[r.id]?.rejected) || 0,
      rework: Number(values[r.id]?.rework) || 0,
      bGrade: Number(values[r.id]?.bGrade) || 0,
    }))
    .filter((l) => rowTotal(values, l.bundleId, columns) > 0)
  const bad = sum('damaged') + sum('rejected')
  const over = overRows(rows, values, columns)
  const blocker = !lines.length
    ? 'Enter the pieces worked on.'
    : over.length
      ? `${over[0].code} has only ${over[0].available} in hand.`
      : bad && reason.trim().length < 3
        ? `Say what was wrong with the ${check ? 'failed' : 'damaged'} pieces.`
        : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${flow.mo.id}/steps/${stepId}/work`, {
        lines,
        reworkStepId: sum('rework') ? reworkStepId : null,
        reason: reason.trim() || null,
        personName: personName.trim() || null,
        eventDate: date,
        notes: notes.trim() || null,
        clientKey,
      })
      onSaved(res.message ?? 'Recorded.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record it.')
    } finally {
      setSaving(false)
    }
  }

  const entered = columns.reduce((s, c) => s + sum(c.key), 0)
  const inHand = rows.reduce((s, r) => s + r.available, 0)
  return (
    <FormFrame
      icon={check ? ClipboardList : Hammer}
      title={`${check ? 'Check' : 'Work'} at ${step.name}`}
      subtitle={`${flow.mo.moNumber} · ${pcs(inHand)} in hand at ${step.name}${step.instructions ? ` · ${step.instructions}` : ''}`}
      width="max-w-5xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Hammer size={15} />} Record {entered ? `${pcs(entered)} pcs` : ''}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : `${pcs(inHand - entered)} stay in hand.`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Boxes} title="Bundles in hand">
        <BundleQtyTable
          rows={rows}
          columns={columns}
          values={values}
          onChange={(row, col, v) => setValues((x) => ({ ...x, [row]: { ...x[row], [col]: v } }))}
          availableLabel="In hand"
          fill={{ label: check ? 'All passed' : 'All done', column: 'done' }}
          empty={`Nothing is in hand at ${step.name}. Count in what has been sent here first.`}
        />
      </Section>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {sum('rework') > 0 && (
          <label className="block">
            <span className="form-label">Rework put right by</span>
            <SmartSelect className="form-input" value={reworkStepId} onChange={(e) => setReworkStepId(e.target.value)}>
              {earlier.map((s) => (
                <option key={s.id} value={s.id} data-sub={s.department.name}>
                  {s.name}
                  {s.id === step.id ? ' (here)' : ''}
                </option>
              ))}
            </SmartSelect>
          </label>
        )}
        {bad > 0 && (
          <label className="block sm:col-span-2">
            <span className="form-label">What was wrong{check ? ', and where it went wrong' : ''}</span>
            <input className="form-input" value={reason} maxLength={500} placeholder={check ? 'Open side seam — stitching' : 'Needle holes on the collar'} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        <label className="block">
          <span className="form-label">Done by</span>
          <input className="form-input" value={personName} maxLength={120} placeholder={check ? 'Checker' : 'Line or operator'} onChange={(e) => setPersonName(e.target.value)} />
        </label>
        <label className="block">
          <span className="form-label">On</span>
          <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block sm:col-span-2">
          <span className="form-label">Note</span>
          <input className="form-input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <p className="text-muted-foreground text-xs">
        {check
          ? 'Passed pieces can go on. Rework goes to the step you pick and comes back here to be checked again. Failed and damaged pieces wait for a decision: rework, B-grade, or written off.'
          : 'Done pieces can go on. Rework is put right and counted done then — not twice. Damaged pieces wait for a decision: rework, B-grade, or written off.'}
      </p>
    </FormFrame>
  )
}
