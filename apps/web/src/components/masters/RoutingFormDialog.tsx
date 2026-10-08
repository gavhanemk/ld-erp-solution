'use client'

import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertCircle, Plus, Trash2, ArrowUp, ArrowDown, Lock } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * A routing is the ordered path a style takes through the factory. No two
 * styles take the same one — a plain shirt skips washing, an embroidered one
 * adds two steps — so the order of the steps is the whole point, and the form
 * is built around moving them up and down rather than typing a number.
 */

export interface RoutingStep {
  id?: string
  sequence: number
  operationId: string
  departmentId: string
  workstationId?: string | null
  smv?: number | string | null
  ratePerPiece?: number | string | null
  isQcStep: boolean
  operation?: { id: string; name: string; code: string }
  department?: { id: string; name: string }
  workstation?: { id: string; name: string; type: string }
}

export interface Routing {
  id: string
  code: string
  name: string
  styleId: string
  isLocked: boolean
  isActive: boolean
  notes: string | null
  style?: { id: string; code: string; name: string }
  steps?: RoutingStep[]
}

interface Option {
  id: string
  code?: string
  name: string
  departmentId?: string
  type?: string
}

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
  record?: Routing | null
}

const emptyStep = (sequence: number): RoutingStep => ({
  sequence,
  operationId: '',
  departmentId: '',
  workstationId: '',
  smv: '',
  ratePerPiece: '',
  isQcStep: false,
})

export function RoutingFormDialog({ open, onClose, onSaved, record }: Props) {
  const isEdit = Boolean(record)

  const [styles, setStyles] = useState<Option[]>([])
  const [operations, setOperations] = useState<Option[]>([])
  const [departments, setDepartments] = useState<Option[]>([])
  const [workstations, setWorkstations] = useState<Option[]>([])

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [styleId, setStyleId] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [steps, setSteps] = useState<RoutingStep[]>([emptyStep(1)])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return

    setCode(record?.code ?? '')
    setName(record?.name ?? '')
    setStyleId(record?.styleId ?? '')
    setNotes(record?.notes ?? '')
    setIsActive(record?.isActive ?? true)
    setSteps(
      record?.steps?.length
        ? record.steps.map((s) => ({
            ...s,
            workstationId: s.workstationId ?? '',
            smv: s.smv ?? '',
            ratePerPiece: s.ratePerPiece ?? '',
          }))
        : [emptyStep(1)],
    )
    setError(null)
  }, [open, record])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void Promise.all([
      masterResource<Option>('styles').list({ limit: 300, active: true }),
      masterResource<Option>('operations').list({ limit: 300, active: true }),
      masterResource<Option>('departments').list({ limit: 300, active: true }),
      masterResource<Option>('workstations').list({ limit: 300, active: true }),
    ]).then(([s, o, d, w]) => {
      if (cancelled) return
      setStyles((s as Paginated<Option>).data)
      setOperations((o as Paginated<Option>).data)
      setDepartments((d as Paginated<Option>).data)
      setWorkstations((w as Paginated<Option>).data)
    })

    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  const operationById = useMemo(
    () => new Map(operations.map((o) => [o.id, o])),
    [operations],
  )

  if (!open) return null

  const setStep = (index: number, patch: Partial<RoutingStep>) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))

  /** Picking the operation fills in its department, which is nearly always right. */
  const pickOperation = (index: number, operationId: string) => {
    const op = operationById.get(operationId)
    setStep(index, {
      operationId,
      departmentId: op?.departmentId || steps[index].departmentId,
      isQcStep: /qc|quality|check/i.test(op?.name ?? '') || steps[index].isQcStep,
    })
  }

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= steps.length) return
    setSteps((prev) => {
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next.map((s, i) => ({ ...s, sequence: i + 1 }))
    })
  }

  const addStep = () => setSteps((prev) => [...prev, emptyStep(prev.length + 1)])

  const removeStep = (index: number) =>
    setSteps((prev) =>
      prev.length === 1
        ? prev
        : prev.filter((_, i) => i !== index).map((s, i) => ({ ...s, sequence: i + 1 })),
    )

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const payload = {
      code: code.trim(),
      name: name.trim(),
      styleId,
      notes: notes.trim() || null,
      isActive,
      steps: steps.map((s, i) => ({
        sequence: i + 1,
        operationId: s.operationId,
        departmentId: s.departmentId,
        workstationId: s.workstationId || null,
        smv: s.smv === '' || s.smv == null ? null : Number(s.smv),
        ratePerPiece: s.ratePerPiece === '' || s.ratePerPiece == null ? null : Number(s.ratePerPiece),
        isQcStep: s.isQcStep,
      })),
    }

    try {
      if (isEdit && record) {
        await api.patch(`/masters/routings/${record.id}`, payload)
      } else {
        await api.post('/masters/routings', payload)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Is the API running?')
    } finally {
      setSaving(false)
    }
  }

  const incomplete = steps.some((s) => !s.operationId || !s.departmentId)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="glass-card w-full max-w-5xl my-auto" role="dialog" aria-modal="true">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {isEdit ? `Edit ${record?.name}` : 'New Routing'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {steps.length} step{steps.length === 1 ? '' : 's'}, in the order the garment moves
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-5">
          {error && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
              <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {record?.isLocked && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/5">
              <Lock size={16} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-400">
                This routing is locked because orders are running against it. Unlock it on the list
                before changing the steps.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="form-label" htmlFor="rt-code">
                Code<span className="text-red-400 ml-0.5">*</span>
              </label>
              <input
                id="rt-code"
                className="form-input font-mono"
                placeholder="RT-LDCM00201"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>
            <div>
              <label className="form-label" htmlFor="rt-name">
                Name<span className="text-red-400 ml-0.5">*</span>
              </label>
              <input
                id="rt-name"
                className="form-input"
                placeholder="LD Shirt LDCM00201 Process"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="form-label" htmlFor="rt-style">
                Style<span className="text-red-400 ml-0.5">*</span>
              </label>
              <SmartSelect
                id="rt-style"
                className="form-input"
                value={styleId}
                onChange={(e) => setStyleId(e.target.value)}
              >
                <option value="">Select...</option>
                {styles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code ? `${s.code} — ${s.name}` : s.name}
                  </option>
                ))}
              </SmartSelect>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Steps
              </h3>
              <button type="button" onClick={addStep} className="btn-secondary text-xs">
                <Plus size={14} /> Add step
              </button>
            </div>

            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full text-sm min-w-[880px]">
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3 w-12">
                      #
                    </th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3">
                      Operation
                    </th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3">
                      Process
                    </th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3">
                      Done at
                    </th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3 w-24">
                      SMV
                    </th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3 w-28">
                      Rate / pc
                    </th>
                    <th className="text-center text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-3 w-16">
                      QC
                    </th>
                    <th className="w-24" />
                  </tr>
                </thead>
                <tbody>
                  {steps.map((step, i) => (
                    <tr key={i} className="border-b border-border/50 last:border-0">
                      <td className="py-2 px-3 font-mono text-xs text-teal-400">{i + 1}</td>
                      <td className="py-2 px-3">
                        <SmartSelect
                          className="form-input h-9"
                          value={step.operationId}
                          onChange={(e) => pickOperation(i, e.target.value)}
                          aria-label={`Step ${i + 1} operation`}
                        >
                          <option value="">Select...</option>
                          {operations.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </SmartSelect>
                      </td>
                      <td className="py-2 px-3">
                        <SmartSelect
                          className="form-input h-9"
                          value={step.departmentId}
                          onChange={(e) => setStep(i, { departmentId: e.target.value })}
                          aria-label={`Step ${i + 1} process`}
                        >
                          <option value="">Select...</option>
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </SmartSelect>
                      </td>
                      <td className="py-2 px-3">
                        <SmartSelect
                          className="form-input h-9"
                          value={step.workstationId ?? ''}
                          onChange={(e) => setStep(i, { workstationId: e.target.value })}
                          aria-label={`Step ${i + 1} workstation`}
                        >
                          <option value="">Anywhere</option>
                          {workstations.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                              {w.type === 'JOB_WORK' ? ' (outside)' : ''}
                            </option>
                          ))}
                        </SmartSelect>
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="number"
                          step="0.001"
                          min={0}
                          className="form-input h-9"
                          placeholder="—"
                          value={String(step.smv ?? '')}
                          onChange={(e) => setStep(i, { smv: e.target.value })}
                          aria-label={`Step ${i + 1} standard minutes`}
                        />
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          className="form-input h-9"
                          placeholder="—"
                          value={String(step.ratePerPiece ?? '')}
                          onChange={(e) => setStep(i, { ratePerPiece: e.target.value })}
                          aria-label={`Step ${i + 1} rate per piece`}
                        />
                      </td>
                      <td className="py-2 px-3 text-center">
                        <input
                          type="checkbox"
                          className="accent-teal-500 w-4 h-4"
                          checked={step.isQcStep}
                          onChange={(e) => setStep(i, { isQcStep: e.target.checked })}
                          aria-label={`Step ${i + 1} is a quality check`}
                        />
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex items-center justify-end gap-0.5">
                          <button
                            type="button"
                            onClick={() => move(i, -1)}
                            disabled={i === 0}
                            className="btn-ghost p-1 disabled:opacity-25"
                            aria-label={`Move step ${i + 1} earlier`}
                          >
                            <ArrowUp size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(i, 1)}
                            disabled={i === steps.length - 1}
                            className="btn-ghost p-1 disabled:opacity-25"
                            aria-label={`Move step ${i + 1} later`}
                          >
                            <ArrowDown size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeStep(i)}
                            disabled={steps.length === 1}
                            className="btn-ghost p-1 text-muted-foreground hover:text-red-400 disabled:opacity-25"
                            aria-label={`Remove step ${i + 1}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-muted-foreground">
              Leave &ldquo;Done at&rdquo; blank when the step can run anywhere. Setting it to an
              outside unit is what lets their job-work bill be totalled later.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="form-label" htmlFor="rt-notes">
                Notes
              </label>
              <textarea
                id="rt-notes"
                rows={2}
                className="form-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-teal-500"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
              />
              Active — offered on new manufacturing orders
            </label>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
            <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={saving || incomplete || !code.trim() || !name.trim() || !styleId}
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              {isEdit ? 'Save changes' : 'Create routing'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
