'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Info, ListOrdered, Loader2, Lock, Plus, Route, Save, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

/**
 * A routing: the ordered path a garment takes through the factory.
 *
 * For one style, for every style of a category (all formal shirts), or for
 * any style. Each step is a process done by its department — on our floor or
 * at an outside unit — and says who may leave it out of an order's route, and
 * whether it is a check. The order of the steps is the whole point, so the
 * form is built around moving them up and down rather than typing a number.
 *
 * An order takes a copy of the steps when it is planned, so saving a change
 * here makes a new version for orders to come and leaves running ones alone.
 */

type Kind = 'CUTTING' | 'STITCHING' | 'FINISHING' | 'QC' | 'PACKING' | 'OTHER'
type Execution = 'IN_HOUSE' | 'OUTSOURCED'
type Skip = 'OPTIONAL' | 'WITH_APPROVAL' | 'NEVER'

export interface RoutingStep {
  id?: string
  sequence: number
  operationId: string
  departmentId: string
  workstationId?: string | null
  smv?: number | string | null
  ratePerPiece?: number | string | null
  isQcStep: boolean
  execution?: Execution
  skip?: Skip
  instructions?: string | null
  operation?: { id: string; name: string; code: string; kind?: Kind }
  department?: { id: string; name: string }
  workstation?: { id: string; name: string; type: string }
}

export interface Routing {
  id: string
  code: string
  name: string
  styleId: string | null
  category: string | null
  version: number
  isLocked: boolean
  isActive: boolean
  notes: string | null
  style?: { id: string; code: string; name: string } | null
  steps?: RoutingStep[]
  _count?: { mos: number }
}

interface Operation {
  id: string
  code: string
  name: string
  departmentId: string
  kind: Kind
  defaultExecution: Execution
  jobWorkRate: string | number | null
  smv: string | number | null
  instructions: string | null
  department?: { name: string } | null
}
interface Unit {
  id: string
  name: string
  departmentId: string
  type: 'IN_HOUSE' | 'JOB_WORK'
}
interface StyleOption {
  id: string
  code: string
  name: string
  category: string | null
}

type Applies = 'STYLE' | 'CATEGORY' | 'ANY'
interface Row {
  key: string
  operationId: string
  workstationId: string
  execution: Execution
  skip: Skip
  isQcStep: boolean
  smv: string
  ratePerPiece: string
  instructions: string
}

const SKIPS: Array<{ value: Skip; label: string; help: string }> = [
  { value: 'OPTIONAL', label: 'Can be left out', help: 'Anyone recording production can leave it out of an order, with a reason' },
  { value: 'WITH_APPROVAL', label: 'Manager only', help: 'Only a production manager can leave it out, with a reason' },
  { value: 'NEVER', label: 'Never left out', help: 'Every piece goes through it' },
]

let seq = 0
const blank = (): Row => ({ key: `n${++seq}`, operationId: '', workstationId: '', execution: 'IN_HOUSE', skip: 'WITH_APPROVAL', isQcStep: false, smv: '', ratePerPiece: '', instructions: '' })
const num = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)))

export function RoutingFormDialog({ open, onClose, onSaved, record }: { open: boolean; onClose: () => void; onSaved: (message: string) => void; record?: Routing | null }) {
  const isEdit = Boolean(record)
  const [ops, setOps] = useState<Operation[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [styles, setStyles] = useState<StyleOption[]>([])
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [applies, setApplies] = useState<Applies>('STYLE')
  const [styleId, setStyleId] = useState('')
  const [category, setCategory] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [rows, setRows] = useState<Row[]>([blank()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setCode(record?.code ?? '')
    setName(record?.name ?? '')
    setApplies(record ? (record.styleId ? 'STYLE' : record.category ? 'CATEGORY' : 'ANY') : 'STYLE')
    setStyleId(record?.styleId ?? '')
    setCategory(record?.category ?? '')
    setNotes(record?.notes ?? '')
    setIsActive(record?.isActive ?? true)
    setRows(
      record?.steps?.length
        ? [...record.steps]
            .sort((a, b) => a.sequence - b.sequence)
            .map((s) => ({
              key: `s${++seq}`,
              operationId: s.operationId,
              workstationId: s.workstationId ?? '',
              execution: s.execution ?? 'IN_HOUSE',
              skip: s.skip ?? 'WITH_APPROVAL',
              isQcStep: s.isQcStep,
              smv: num(s.smv),
              ratePerPiece: num(s.ratePerPiece),
              instructions: s.instructions ?? '',
            }))
        : [blank()],
    )
    setError(null)
  }, [open, record])

  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.all([
      masterResource<Operation>('operations').list({ limit: 300, active: true, sort: 'sortOrder', order: 'asc' }),
      masterResource<Unit>('workstations').list({ limit: 300, active: true }),
      masterResource<StyleOption>('styles').list({ limit: 500, active: true }),
    ])
      .then(([o, w, s]) => {
        if (!alive) return
        setOps((o as Paginated<Operation>).data)
        setUnits((w as Paginated<Unit>).data)
        setStyles((s as Paginated<StyleOption>).data)
      })
      .catch(() => alive && setError('Could not load the processes and units. Is the API running?'))
    return () => {
      alive = false
    }
  }, [open])

  const opById = useMemo(() => new Map(ops.map((o) => [o.id, o])), [ops])
  const categories = useMemo(() => [...new Set(styles.map((s) => s.category?.trim()).filter(Boolean) as string[])].sort(), [styles])

  if (!open) return null

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  /** Picking a process fills in what it usually is: outside or not, a check or not, its rate and instructions. */
  const pick = (key: string, operationId: string) => {
    const o = opById.get(operationId)
    set(key, {
      operationId,
      workstationId: '',
      execution: o?.defaultExecution ?? 'IN_HOUSE',
      isQcStep: o?.kind === 'QC',
      skip: o?.kind === 'CUTTING' ? 'NEVER' : 'WITH_APPROVAL',
      ratePerPiece: o?.defaultExecution === 'OUTSOURCED' ? num(o?.jobWorkRate) : '',
      smv: num(o?.smv),
      instructions: o?.instructions ?? '',
    })
  }
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const j = i + d
      if (j < 0 || j >= rs.length) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const kinds = rows.map((r) => opById.get(r.operationId)?.kind)
  const blocker = !code.trim()
    ? 'Give it a code.'
    : !name.trim()
      ? 'Give it a name.'
      : applies === 'STYLE' && !styleId
        ? 'Pick the style it is for.'
        : applies === 'CATEGORY' && !category.trim()
          ? 'Say which category of styles it is for.'
          : rows.some((r) => !r.operationId)
            ? 'Pick a process on every step.'
            : kinds[0] !== 'CUTTING'
              ? 'Start with cutting: that is where the pieces are made.'
              : kinds.filter((k) => k === 'CUTTING').length > 1
                ? 'Cut once: only one cutting step.'
                : null
  const noCheck = rows.length > 0 && !rows.some((r, i) => r.isQcStep || kinds[i] === 'QC')

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    const payload = {
      code: code.trim(),
      name: name.trim(),
      styleId: applies === 'STYLE' ? styleId : null,
      category: applies === 'CATEGORY' ? category.trim() : null,
      notes: notes.trim() || null,
      isActive,
      steps: rows.map((r, i) => ({
        sequence: i + 1,
        operationId: r.operationId,
        departmentId: opById.get(r.operationId)!.departmentId,
        workstationId: r.workstationId || null,
        execution: r.execution,
        skip: kinds[i] === 'CUTTING' ? 'NEVER' : r.skip,
        isQcStep: r.isQcStep,
        smv: r.smv === '' ? null : Number(r.smv),
        ratePerPiece: r.ratePerPiece === '' ? null : Number(r.ratePerPiece),
        instructions: r.instructions.trim() || null,
      })),
    }
    try {
      const res = isEdit && record ? await api.patch<{ message?: string }>(`/masters/routings/${record.id}`, payload) : await api.post<{ message?: string }>('/masters/routings', payload)
      onSaved(res.message ?? 'Routing saved.')
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Is the API running?')
    } finally {
      setSaving(false)
    }
  }

  const unitsFor = (r: Row) => {
    const o = opById.get(r.operationId)
    return units.filter((u) => u.departmentId === o?.departmentId && (r.execution === 'OUTSOURCED' ? u.type === 'JOB_WORK' : u.type === 'IN_HOUSE'))
  }

  return (
    <FormFrame
      icon={Route}
      title={isEdit ? `Edit ${record?.code}` : 'New routing'}
      subtitle={
        isEdit
          ? `Version ${record?.version}${record?._count?.mos ? ` · ${record._count.mos} ${record._count.mos === 1 ? 'order has' : 'orders have'} a copy of its steps, which a change here does not touch` : ''}`
          : 'The steps a garment goes through, in order. Orders take a copy when they are planned.'
      }
      width="max-w-6xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {isEdit ? 'Save routing' : 'Create routing'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : `${rows.length} ${rows.length === 1 ? 'step' : 'steps'}`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {record?.isLocked && (
        <p className="warn-text flex items-start gap-1.5 text-xs">
          <Lock size={13} className="mt-px shrink-0" /> Locked: its steps cannot change until it is unlocked on the list.
        </p>
      )}
      <Section icon={Route} title="Routing">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="form-label">Code</span>
            <input className="form-input font-mono" value={code} placeholder="RT-SH-WASH" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
          <label className="block lg:col-span-3">
            <span className="form-label">Name</span>
            <input className="form-input" value={name} placeholder="Shirt with washing" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">For</span>
            <SmartSelect className="form-input" value={applies} onChange={(e) => setApplies(e.target.value as Applies)}>
              <option value="STYLE">One style</option>
              <option value="CATEGORY">Every style of a category</option>
              <option value="ANY">Any style</option>
            </SmartSelect>
          </label>
          {applies === 'STYLE' && (
            <label className="block lg:col-span-2">
              <span className="form-label">Style</span>
              <SmartSelect className="form-input" value={styleId} onChange={(e) => setStyleId(e.target.value)}>
                <option value="">Select…</option>
                {styles.map((s) => (
                  <option key={s.id} value={s.id} data-sub={s.category ?? undefined}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </SmartSelect>
            </label>
          )}
          {applies === 'CATEGORY' && (
            <label className="block lg:col-span-2">
              <span className="form-label">Category</span>
              <SmartSelect className="form-input" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Select…</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </SmartSelect>
            </label>
          )}
          {applies === 'ANY' && <p className="text-muted-foreground self-end pb-2 text-xs lg:col-span-2">Offered for any order whose styles have no routing of their own.</p>}
          <label className="flex items-center gap-2 self-end pb-2 text-xs">
            <input type="checkbox" className="accent-primary" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Offered on new orders
          </label>
        </div>
      </Section>

      <Section
        icon={ListOrdered}
        title="Steps, in the order the garment moves"
        actions={
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setRows((rs) => [...rs, blank()])}>
            <Plus size={13} /> Add step
          </button>
        }
      >
        <div className="space-y-2">
          {rows.map((r, i) => {
            const o = opById.get(r.operationId)
            const isCut = o?.kind === 'CUTTING'
            return (
              <div key={r.key} className="border-border bg-card rounded-lg border p-2.5">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-12 sm:items-end">
                  <div className="text-primary flex items-center gap-1 font-mono text-xs sm:col-span-1 sm:pb-2">
                    {i + 1}
                    <span className="ml-auto flex sm:hidden">
                      <button type="button" className="btn-ghost p-1" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} earlier`}>
                        <ArrowUp size={13} />
                      </button>
                      <button type="button" className="btn-ghost p-1" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move step ${i + 1} later`}>
                        <ArrowDown size={13} />
                      </button>
                    </span>
                  </div>
                  <label className="col-span-2 block sm:col-span-3">
                    <span className="form-label">Process</span>
                    <SmartSelect className="form-input h-9" value={r.operationId} onChange={(e) => pick(r.key, e.target.value)} aria-label={`Step ${i + 1} process`}>
                      <option value="">Select…</option>
                      {ops.map((op) => (
                        <option key={op.id} value={op.id} data-sub={op.department?.name ?? undefined}>
                          {op.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="form-label">Done</span>
                    <SmartSelect className="form-input h-9" value={r.execution} disabled={isCut} onChange={(e) => set(r.key, { execution: e.target.value as Execution, workstationId: '' })} aria-label={`Step ${i + 1} where`}>
                      <option value="IN_HOUSE">On our floor</option>
                      <option value="OUTSOURCED">Outside</option>
                    </SmartSelect>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="form-label">{r.execution === 'OUTSOURCED' ? 'Usual unit' : 'Line'}</span>
                    <SmartSelect className="form-input h-9" value={r.workstationId} onChange={(e) => set(r.key, { workstationId: e.target.value })} aria-label={`Step ${i + 1} unit`}>
                      <option value="">{r.execution === 'OUTSOURCED' ? 'Picked when sent' : 'Any'}</option>
                      {unitsFor(r).map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="form-label">Leaving it out</span>
                    <SmartSelect
                      className="form-input h-9"
                      value={isCut ? 'NEVER' : r.skip}
                      disabled={isCut}
                      onChange={(e) => set(r.key, { skip: e.target.value as Skip })}
                      aria-label={`Step ${i + 1} leaving out`}
                    >
                      {SKIPS.map((s) => (
                        <option key={s.value} value={s.value} data-sub={s.help}>
                          {s.label}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="block sm:col-span-1">
                    <span className="form-label">Rate / pc</span>
                    <StepInput decimals className="form-input h-9 text-right tabular-nums" value={r.ratePerPiece} placeholder="—" onValueChange={(v) => set(r.key, { ratePerPiece: v })} aria-label={`Step ${i + 1} rate per piece`} />
                  </label>
                  <div className="flex items-center justify-between gap-2 sm:col-span-1 sm:justify-end sm:pb-1.5">
                    <label className="flex items-center gap-1 text-xs" title="A check: pieces are passed or failed here">
                      <input type="checkbox" className="accent-primary" checked={r.isQcStep} onChange={(e) => set(r.key, { isQcStep: e.target.checked })} aria-label={`Step ${i + 1} is a check`} />
                      Check
                    </label>
                    <span className="hidden sm:flex">
                      <button type="button" className="btn-ghost p-1" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} earlier`}>
                        <ArrowUp size={13} />
                      </button>
                      <button type="button" className="btn-ghost p-1" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move step ${i + 1} later`}>
                        <ArrowDown size={13} />
                      </button>
                    </span>
                    <button
                      type="button"
                      className="btn-ghost text-muted-foreground hover:text-destructive p-1"
                      onClick={() => setRows((rs) => (rs.length === 1 ? rs : rs.filter((x) => x.key !== r.key)))}
                      disabled={rows.length === 1}
                      aria-label={`Remove step ${i + 1}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-12">
                  <label className="block sm:col-span-2 sm:col-start-2">
                    <span className="form-label">SMV</span>
                    <StepInput decimals className="form-input h-8 text-right text-xs tabular-nums" value={r.smv} placeholder="—" onValueChange={(v) => set(r.key, { smv: v })} aria-label={`Step ${i + 1} standard minutes`} />
                  </label>
                  <label className="block sm:col-span-9">
                    <span className="form-label">Instructions for the floor</span>
                    <input className="form-input h-8 text-xs" value={r.instructions} maxLength={500} placeholder={isCut ? 'Lay face up; check shade lot before cutting' : 'What the department must know for this style'} onChange={(e) => set(r.key, { instructions: e.target.value })} />
                  </label>
                </div>
                {o && (
                  <p className="text-muted-foreground mt-1.5 text-[11px]">
                    {o.department?.name ?? 'Its department'}
                    {isCut ? ' · makes the pieces and the bundles' : o.kind === 'QC' || r.isQcStep ? ' · passes or fails pieces' : ''}
                    {r.execution === 'OUTSOURCED' ? ' · goes out on a job work order and a job-work challan' : ''}
                  </p>
                )}
              </div>
            )
          })}
        </div>
        {noCheck && (
          <p className="warn-text mt-2 flex items-start gap-1.5 text-xs">
            <Info size={13} className="mt-px shrink-0" /> There is no check on this route, so pieces reach finished goods without one.
          </p>
        )}
      </Section>

      <label className="block">
        <span className="form-label">Notes</span>
        <textarea className="form-input" rows={2} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </label>
    </FormFrame>
  )
}
