'use client'

import { useMemo, useState } from 'react'
import { Gavel, Loader2 } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { BundleQtyTable, overRows, type QtyValues } from './BundleQtyTable'
import { bundleRows } from './useFlow'
import { isCheck, newClientKey, pcs, type Bucket, type Flow } from './types'

/**
 * A decision on pieces at a step: damaged or failed ones put right, set aside
 * as B-grade, written off, passed as they are, or checked again — or done ones
 * found faulty after all. Writing off and passing as they are need a
 * production manager. Every decision carries a reason.
 */

type From = 'DAMAGED' | 'REJECTED' | 'DONE'
type To = 'REWORK' | 'B_GRADE' | 'SCRAPPED' | 'DONE' | 'WIP' | 'DAMAGED' | 'REJECTED'

const FROM_LABEL: Record<From, string> = { DAMAGED: 'Damaged', REJECTED: 'Failed the check', DONE: 'Done, found faulty after all' }

export function DecideDialog({ flow, stepId, onClose, onSaved }: { flow: Flow; stepId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const step = flow.steps.find((s) => s.id === stepId)!
  const manager = can('production', 'approve')
  const held = (bucket: Bucket) => bundleRows(flow.bundles, { stepId, bucket }).reduce((s, r) => s + r.available, 0)
  const fromOptions = (['DAMAGED', 'REJECTED', 'DONE'] as From[]).filter((f) => held(f) > 0)
  const [from, setFrom] = useState<From>(fromOptions[0] ?? 'DAMAGED')
  const toOptions: Array<{ value: To; label: string; manager?: boolean }> =
    from === 'DONE'
      ? [
          { value: 'DAMAGED', label: 'Damaged' },
          ...(isCheck(step) ? [{ value: 'REJECTED' as To, label: 'Failed the check' }] : []),
        ]
      : [
          { value: 'REWORK', label: 'Put right (rework)' },
          { value: 'B_GRADE', label: 'Set aside as B-grade' },
          ...(isCheck(step) ? [{ value: 'WIP' as To, label: 'Check them again' }] : []),
          { value: 'DONE', label: 'Pass them as they are', manager: true },
          { value: 'SCRAPPED', label: 'Write them off', manager: true },
        ]
  const [to, setTo] = useState<To>(toOptions[0].value)
  const earlier = flow.steps.filter((s) => s.sequence <= step.sequence)
  const [reworkStepId, setReworkStepId] = useState(step.id)
  const [values, setValues] = useState<QtyValues>({})
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)

  const rows = useMemo(() => bundleRows(flow.bundles, { stepId, bucket: from }), [flow, stepId, from])
  const columns = [{ key: 'qty', label: 'Pieces' }]
  const lines = rows.map((r) => ({ bundleId: r.id, qty: Number(values[r.id]?.qty) || 0 })).filter((l) => l.qty > 0)
  const total = lines.reduce((s, l) => s + l.qty, 0)
  const over = overRows(rows, values, columns)
  const needsManager = toOptions.find((o) => o.value === to)?.manager
  const blocker = !lines.length
    ? 'Enter how many pieces.'
    : over.length
      ? `${over[0].code} has only ${over[0].available}.`
      : needsManager && !manager
        ? 'That needs a production manager.'
        : reason.trim().length < 5
          ? 'Say why, in a few words.'
          : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${flow.mo.id}/steps/${stepId}/decide`, {
        from,
        to,
        lines,
        reworkStepId: to === 'REWORK' ? reworkStepId : null,
        reason: reason.trim(),
        clientKey,
      })
      onSaved(res.message ?? 'Decided.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the decision.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Gavel}
      title={`Decide at ${step.name}`}
      subtitle={`${flow.mo.moNumber}: what happens to pieces that are not right`}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Gavel size={15} />} Decide {total ? `${pcs(total)} pcs` : ''}
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
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
        <label className="block">
          <span className="form-label">The pieces</span>
          <SmartSelect
            className="form-input"
            value={from}
            onChange={(e) => {
              const f = e.target.value as From
              setFrom(f)
              setValues({})
              setTo(f === 'DONE' ? 'DAMAGED' : 'REWORK')
            }}
          >
            {(['DAMAGED', 'REJECTED', 'DONE'] as From[]).map((f) => (
              <option key={f} value={f} disabled={!held(f)} data-sub={`${pcs(held(f))} here`}>
                {FROM_LABEL[f]}
              </option>
            ))}
          </SmartSelect>
        </label>
        <label className="block">
          <span className="form-label">Decision</span>
          <SmartSelect className="form-input" value={to} onChange={(e) => setTo(e.target.value as To)}>
            {toOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={o.manager && !manager} data-sub={o.manager ? 'A production manager' : undefined}>
                {o.label}
              </option>
            ))}
          </SmartSelect>
        </label>
        {to === 'REWORK' && (
          <label className="block">
            <span className="form-label">Put right by</span>
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
      </div>
      <Section icon={Gavel} title={FROM_LABEL[from]}>
        <BundleQtyTable
          rows={rows}
          columns={columns}
          values={values}
          onChange={(row, col, v) => setValues((x) => ({ ...x, [row]: { ...x[row], [col]: v } }))}
          availableLabel="Here"
          fill={{ label: 'All of them', column: 'qty' }}
          empty="None here."
        />
        <label className="mt-3 block">
          <span className="form-label">Why</span>
          <input className="form-input" value={reason} maxLength={500} placeholder={to === 'SCRAPPED' ? 'Torn beyond repair' : to === 'B_GRADE' ? 'Small stain, sell as seconds' : 'Seam can be re-stitched'} onChange={(e) => setReason(e.target.value)} />
        </label>
      </Section>
    </FormFrame>
  )
}
