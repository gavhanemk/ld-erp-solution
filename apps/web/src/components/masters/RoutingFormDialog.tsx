'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Info, ListOrdered, Loader2, Lock, Plus, Route, Save, SlidersHorizontal, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

/**
 * A routing: the ordered path a garment takes through the factory.
 *
 * For one style, for every style of a category (all formal shirts), or for
 * any style. Each step is a process done by its department — on our floor or
 * at an outside unit — and says who may leave it out, and whether it is a
 * check.
 *
 * Laid out as one short row per step — the process, where it is done, the
 * unit and the rate, which are what a person scans for — with the rest of the
 * step (leaving it out, the check, standard minutes, instructions) in a panel
 * beside the list for whichever step is picked. The rows used to carry all
 * nine controls each, two lines deep, and a routing of eleven steps was a wall
 * of boxes. Steps move by dragging the handle, or with the arrows.
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
  workstation?: { id: string; name: string; type: string } | null
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
  /** Switched off in the Process Master since this routing used it. */
  inactive?: boolean
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

const SKIPS: Array<{ value: Skip; label: string; short: string; help: string }> = [
  { value: 'OPTIONAL', label: 'Can be left out', short: 'Optional', help: 'Anyone recording production can leave it out, with a reason' },
  { value: 'WITH_APPROVAL', label: 'Manager only', short: 'Manager only', help: 'Only a production manager can leave it out, with a reason' },
  { value: 'NEVER', label: 'Never left out', short: 'Always', help: 'Every piece goes through it' },
]

const APPLIES: Array<{ value: Applies; label: string }> = [
  { value: 'STYLE', label: 'One style' },
  { value: 'CATEGORY', label: 'A category' },
  { value: 'ANY', label: 'Any style' },
]

let seq = 0
const blank = (): Row => ({ key: `n${++seq}`, operationId: '', workstationId: '', execution: 'IN_HOUSE', skip: 'WITH_APPROVAL', isQcStep: false, smv: '', ratePerPiece: '', instructions: '' })
const num = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)))
const rowsOf = (steps: RoutingStep[] | undefined): Row[] =>
  steps?.length
    ? [...steps]
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
    : [blank()]

export function RoutingFormDialog({
  open,
  onClose,
  onSaved,
  record,
  preset,
}: {
  open: boolean
  onClose: () => void
  onSaved: (message: string) => void
  record?: Routing | null
  /**
   * A new routing begun from a style's page: for that style, and a copy of
   * another routing's steps to start from. Keep it in state on the caller's
   * side — a fresh object each render would reset the form as it is typed in.
   */
  preset?: { styleId?: string; from?: Routing | null } | null
}) {
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
  const [selected, setSelected] = useState<string | null>(null)
  // Dragging: only from the handle, so a select or a number box inside the row
  // still takes the mouse normally.
  const [armed, setArmed] = useState<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const from = record ?? preset?.from ?? null
    setCode(record?.code ?? '')
    setName(record?.name ?? (preset?.from ? preset.from.name : ''))
    setApplies(record ? (record.styleId ? 'STYLE' : record.category ? 'CATEGORY' : 'ANY') : 'STYLE')
    setStyleId(record?.styleId ?? preset?.styleId ?? '')
    setCategory(record?.category ?? '')
    setNotes(record?.notes ?? '')
    setIsActive(record?.isActive ?? true)
    const next = rowsOf(from?.steps)
    setRows(next)
    setSelected(next[0]?.key ?? null)
    setError(null)
  }, [open, record, preset])

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

  // The list is the processes in use. One switched off since this routing was
  // made still has to show on its step, or the step reads "Pick a process" and
  // the routing cannot be saved at all — so the routing's own are added back.
  const opById = useMemo(() => {
    const map = new Map<string, Operation>(ops.map((o) => [o.id, o]))
    for (const s of (record ?? preset?.from)?.steps ?? []) {
      if (map.has(s.operationId) || !s.operation) continue
      map.set(s.operationId, {
        id: s.operationId,
        code: s.operation.code,
        name: s.operation.name,
        departmentId: s.departmentId,
        kind: s.operation.kind ?? 'OTHER',
        defaultExecution: s.execution ?? 'IN_HOUSE',
        jobWorkRate: null,
        smv: null,
        instructions: null,
        department: s.department ? { name: s.department.name } : null,
        inactive: true,
      })
    }
    return map
  }, [ops, record, preset])
  const processOptions = useMemo(() => [...opById.values()], [opById])
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
  /** Drops the dragged step where the one under the pointer is. */
  const moveTo = (fromKey: string, toKey: string) =>
    setRows((rs) => {
      const from = rs.findIndex((r) => r.key === fromKey)
      const to = rs.findIndex((r) => r.key === toKey)
      if (from < 0 || to < 0 || from === to) return rs
      const next = [...rs]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  const endDrag = () => {
    setDragKey(null)
    setOverKey(null)
    setArmed(null)
  }
  const addStep = () => {
    const r = blank()
    setRows((rs) => [...rs, r])
    setSelected(r.key)
  }
  const remove = (key: string) => {
    if (rows.length === 1) return
    const i = rows.findIndex((r) => r.key === key)
    const next = rows.filter((r) => r.key !== key)
    setRows(next)
    if (selected === key) setSelected(next[Math.min(i, next.length - 1)]?.key ?? null)
  }

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

  const selIndex = Math.max(0, rows.findIndex((r) => r.key === selected))
  const sel = rows[selIndex]
  const selOp = sel ? opById.get(sel.operationId) : undefined
  const selIsCut = selOp?.kind === 'CUTTING'

  return (
    <FormFrame
      icon={Route}
      title={isEdit ? `Edit ${record?.code}` : 'New routing'}
      subtitle={
        isEdit
          ? `Version ${record?.version}${record?._count?.mos ? ` · ${record._count.mos} ${record._count.mos === 1 ? 'order has' : 'orders have'} a copy of its steps, which a change here does not touch` : ''}`
          : preset?.from
            ? `Starting from the steps of ${preset.from.code}. Change what this style does differently.`
            : 'The steps a garment goes through, in order. Orders take a copy when they are planned.'
      }
      width="max-w-6xl"
      primary={
        <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none" onClick={() => void save()} disabled={saving || !!blocker}>
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
          <Lock size={13} className="mt-px shrink-0" /> Locked: its steps cannot change until it is unlocked.
        </p>
      )}

      <Section icon={Route} title="Routing">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="block lg:col-span-1">
            <span className="form-label">Code</span>
            <input className="form-input font-mono" value={code} placeholder="RT-SH-WASH" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
          <label className="block lg:col-span-3">
            <span className="form-label">Name</span>
            <input className="form-input" value={name} placeholder="Shirt with washing" onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="sm:col-span-2 lg:col-span-2">
            <span className="form-label">For</span>
            <div className="border-border bg-field flex rounded-lg border p-0.5" role="radiogroup" aria-label="Which styles it is for">
              {APPLIES.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  role="radio"
                  aria-checked={applies === a.value}
                  onClick={() => setApplies(a.value)}
                  className={cn('flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors', applies === a.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            {applies === 'STYLE' && (
              <label className="block">
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
              <label className="block">
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
            {applies === 'ANY' && <p className="text-muted-foreground pt-6 text-xs">Followed by any style that has no routing of its own and none for its category.</p>}
          </div>
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm lg:col-span-2">
            <input type="checkbox" className="accent-primary h-4 w-4" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Offered on new orders
          </label>
        </div>
      </Section>

      <Section
        icon={ListOrdered}
        title="Steps, in the order the garment moves"
        actions={
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={addStep}>
            <Plus size={13} /> Add step
          </button>
        }
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <ol className="space-y-1.5 lg:col-span-2" aria-label="Steps">
            {rows.map((r, i) => {
              const o = opById.get(r.operationId)
              const isCut = o?.kind === 'CUTTING'
              const skip = SKIPS.find((s) => s.value === (isCut ? 'NEVER' : r.skip))!
              return (
                <li
                  key={r.key}
                  draggable={armed === r.key}
                  onDragStart={(e) => {
                    setDragKey(r.key)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    if (!dragKey) return
                    e.preventDefault()
                    if (overKey !== r.key) setOverKey(r.key)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragKey) moveTo(dragKey, r.key)
                    endDrag()
                  }}
                  onDragEnd={endDrag}
                  onClick={() => setSelected(r.key)}
                  className={cn(
                    'bg-card rounded-lg border px-2 py-1.5 transition-colors',
                    sel?.key === r.key ? 'border-primary ring-primary/25 ring-2' : 'border-border',
                    overKey === r.key && dragKey && dragKey !== r.key && 'border-primary border-dashed',
                    dragKey === r.key && 'opacity-50',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
                      onMouseDown={() => setArmed(r.key)}
                      onMouseUp={() => setArmed(null)}
                      aria-label={`Drag step ${i + 1} to move it`}
                      title="Drag to move"
                    >
                      <GripVertical size={15} />
                    </button>
                    <span className="text-primary w-5 text-center font-mono text-xs font-semibold">{i + 1}</span>
                    <SmartSelect className="form-input h-9 min-w-0 flex-1 basis-40" value={r.operationId} onChange={(e) => pick(r.key, e.target.value)} aria-label={`Step ${i + 1} process`}>
                      <option value="">Pick a process…</option>
                      {processOptions.map((op) => (
                        <option key={op.id} value={op.id} data-sub={op.department?.name ?? undefined}>
                          {op.inactive ? `${op.name} (no longer in use)` : op.name}
                        </option>
                      ))}
                    </SmartSelect>
                    <SmartSelect
                      className="form-input h-9 w-28"
                      value={r.execution}
                      disabled={isCut}
                      onChange={(e) => set(r.key, { execution: e.target.value as Execution, workstationId: '' })}
                      aria-label={`Step ${i + 1} where it is done`}
                    >
                      <option value="IN_HOUSE">Our floor</option>
                      <option value="OUTSOURCED">Outside unit</option>
                    </SmartSelect>
                    <SmartSelect className="form-input h-9 w-36" value={r.workstationId} onChange={(e) => set(r.key, { workstationId: e.target.value })} aria-label={`Step ${i + 1} unit`}>
                      <option value="">{r.execution === 'OUTSOURCED' ? 'Unit: picked when sent' : 'Line: any'}</option>
                      {unitsFor(r).map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </SmartSelect>
                    <StepInput
                      decimals
                      className="form-input h-9 w-20 text-right tabular-nums"
                      value={r.ratePerPiece}
                      placeholder="₹ / pc"
                      onValueChange={(v) => set(r.key, { ratePerPiece: v })}
                      aria-label={`Step ${i + 1} rate per piece`}
                    />
                    <span className="ml-auto flex items-center gap-0.5">
                      <span className="flex flex-col">
                        <button type="button" className="btn-ghost px-1 py-0" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} earlier`}>
                          <ArrowUp size={12} />
                        </button>
                        <button type="button" className="btn-ghost px-1 py-0" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move step ${i + 1} later`}>
                          <ArrowDown size={12} />
                        </button>
                      </span>
                      <button
                        type="button"
                        className="btn-ghost text-muted-foreground hover:text-destructive p-1"
                        onClick={(e) => {
                          e.stopPropagation()
                          remove(r.key)
                        }}
                        disabled={rows.length === 1}
                        aria-label={`Remove step ${i + 1}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </div>
                  {/* What the panel holds, in a line, so the list alone tells the whole route. */}
                  {o && (
                    <p className="text-muted-foreground mt-1 pl-12 text-[11px]">
                      {o.department?.name ?? 'Its department'}
                      {r.isQcStep || o.kind === 'QC' ? ' · check' : ''}
                      {` · ${skip.short.toLowerCase()}`}
                      {r.smv ? ` · ${r.smv} min` : ''}
                      {r.instructions.trim() ? ' · has instructions' : ''}
                    </p>
                  )}
                </li>
              )
            })}
          </ol>

          {/* The picked step's other settings. Beside the list on a wide screen, under it on a narrow one. */}
          <aside className="border-border bg-secondary/40 space-y-3 self-start rounded-xl border p-3 lg:sticky lg:top-0 lg:col-span-1" aria-label="Step settings">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={14} className="text-primary shrink-0" />
              <p className="text-foreground text-sm font-semibold">
                Step {selIndex + 1}
                {selOp ? ` · ${selOp.name}` : ''}
              </p>
            </div>
            {!sel || !selOp ? (
              <p className="text-muted-foreground text-xs">Pick the process for this step first.</p>
            ) : (
              <>
                <p className="text-muted-foreground text-xs">
                  {selOp.department?.name ?? 'Its department'}
                  {selIsCut ? ' — makes the pieces and the bundles.' : selOp.kind === 'QC' || sel.isQcStep ? ' — passes or fails pieces.' : '.'}
                  {sel.execution === 'OUTSOURCED' ? ' Goes out on a job work order and a job-work challan.' : ''}
                </p>

                <fieldset>
                  <legend className="form-label">Leaving it out</legend>
                  <div className="space-y-1.5">
                    {SKIPS.map((s) => {
                      const value = selIsCut ? 'NEVER' : sel.skip
                      return (
                        <label
                          key={s.value}
                          className={cn(
                            'flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-xs',
                            value === s.value ? 'border-primary bg-primary/5' : 'border-border bg-card',
                            selIsCut && 'cursor-not-allowed opacity-60',
                          )}
                        >
                          <input type="radio" className="accent-primary mt-0.5" checked={value === s.value} disabled={selIsCut} onChange={() => set(sel.key, { skip: s.value })} />
                          <span>
                            <span className="text-foreground block font-medium">{s.label}</span>
                            <span className="text-muted-foreground">{selIsCut ? 'Cutting makes the pieces, so it is never left out.' : s.help}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </fieldset>

                <label className="border-border bg-card flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-xs">
                  <input type="checkbox" className="accent-primary mt-0.5" checked={sel.isQcStep} onChange={(e) => set(sel.key, { isQcStep: e.target.checked })} />
                  <span>
                    <span className="text-foreground block font-medium">A check</span>
                    <span className="text-muted-foreground">Pieces are passed or failed here, not made</span>
                  </span>
                </label>

                <label className="block">
                  <span className="form-label">Standard minutes for one piece (SMV)</span>
                  <StepInput decimals className="form-input h-9 w-32 text-right tabular-nums" value={sel.smv} placeholder="—" onValueChange={(v) => set(sel.key, { smv: v })} />
                </label>

                <label className="block">
                  <span className="form-label">Instructions for the floor</span>
                  <textarea
                    className="form-input text-xs"
                    rows={3}
                    value={sel.instructions}
                    maxLength={500}
                    placeholder={selIsCut ? 'Lay face up; check shade lot before cutting' : 'What the department must know for this style'}
                    onChange={(e) => set(sel.key, { instructions: e.target.value })}
                  />
                </label>
              </>
            )}
          </aside>
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
