'use client'

import { useMemo, useState } from 'react'
import { Loader2, Wrench } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { BundleQtyTable, overRows, type QtyValues } from './BundleQtyTable'
import { isCheck, newClientKey, pcs, type Flow } from './types'

/**
 * Rework put right. The pieces belong to the step that found the fault, so
 * this is opened from there whoever did the work: at a check they go back to
 * be checked again, anywhere else they are done. Reworked garments are never
 * counted as new production — they had not been counted done before.
 */
export function ReworkDoneDialog({ flow, stepId, onClose, onSaved }: { flow: Flow; stepId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const step = flow.steps.find((s) => s.id === stepId)!
  const stepName = new Map(flow.steps.map((s) => [s.id, s.name]))
  const rows = useMemo(
    () =>
      flow.bundles
        .flatMap((b) =>
          b.places
            .filter((p) => p.stepId === stepId && p.bucket === 'REWORK' && !p.vendorId && p.qty > 0)
            .map((p) => ({
              id: `${b.id}|${p.reworkStepId ?? stepId}`,
              bundleId: b.id,
              reworkStepId: p.reworkStepId ?? stepId,
              code: b.code,
              size: b.size?.code ?? null,
              line: b.line ? `${b.line.style} ${b.line.color}` : null,
              available: p.qty,
              note: `Put right by ${stepName.get(p.reworkStepId ?? stepId) ?? 'this step'}`,
              bundleNo: b.bundleNo,
            })),
        )
        .sort((a, b) => a.bundleNo - b.bundleNo),
    [flow, stepId],
  )
  const columns = [{ key: 'qty', label: 'Put right' }]
  const [values, setValues] = useState<QtyValues>({})
  const [personName, setPersonName] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)

  const lines = rows.map((r) => ({ bundleId: r.bundleId, reworkStepId: r.reworkStepId, qty: Number(values[r.id]?.qty) || 0 })).filter((l) => l.qty > 0)
  const total = lines.reduce((s, l) => s + l.qty, 0)
  const over = overRows(rows, values, columns)
  const blocker = !lines.length ? 'Enter how many were put right.' : over.length ? `${over[0].code} has only ${over[0].available} in rework.` : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${flow.mo.id}/steps/${stepId}/rework-done`, {
        lines,
        personName: personName.trim() || null,
        eventDate: date,
        clientKey,
      })
      onSaved(res.message ?? 'Put right.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record it.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Wrench}
      title={`Rework put right · ${step.name}`}
      subtitle={isCheck(step) ? `Back to ${step.name} to be checked again.` : `Done at ${step.name} once put right.`}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Wrench size={15} />} Put right {total ? `${pcs(total)} pcs` : ''}
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
      <Section icon={Wrench} title="In rework">
        <BundleQtyTable rows={rows} columns={columns} values={values} onChange={(row, col, v) => setValues((x) => ({ ...x, [row]: { ...x[row], [col]: v } }))} availableLabel="In rework" fill={{ label: 'All of them', column: 'qty' }} empty="Nothing is in rework here." />
        <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <label className="block">
            <span className="form-label">Put right by</span>
            <input className="form-input" value={personName} maxLength={120} placeholder="Line or operator" onChange={(e) => setPersonName(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">On</span>
            <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
      </Section>
    </FormFrame>
  )
}
