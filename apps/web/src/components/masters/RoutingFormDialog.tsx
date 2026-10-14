'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Info, ListOrdered, Loader2, Lock, Plus, Route, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

/**
 * A routing: the processes a garment of a style goes through.
 *
 * Cutting comes first and the last process puts pieces into finished goods;
 * in between, the floor sends bundles on in whatever order the work needs,
 * picking from these processes on each transfer — the order here is only the
 * usual one, offered first.
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
  isActive?: boolean
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
  // A process's less-used settings — SMV, instructions, leaving it out — open on demand.
  const [more, setMore] = useState<Record<string, boolean>>({})

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
      masterResource<Operation>('operations').list({ limit: 300, sort: 'sortOrder', order: 'asc' }),
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
            ? 'Pick a process on every line.'
            : kinds[0] !== 'CUTTING'
              ? 'Start with cutting: that is where the pieces are made.'
              : kinds.filter((k) => k === 'CUTTING').length > 1
                ? 'Cut once: only one cutting process.'
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
          : 'The processes a garment of this style goes through. Orders take a copy when they are planned.'
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
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : `${rows.length} ${rows.length === 1 ? 'process' : 'processes'}`}
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
        title="Processes this style needs"
        actions={
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setRows((rs) => [...rs, blank()])}>
            <Plus size={13} /> Add process
          </button>
        }
      >
        <p className="text-muted-foreground mb-3 text-xs">
          List every process the garment must go through. Cutting comes first, and the last one puts the pieces into finished goods. In between, the
          floor sends bundles on in whatever order the work needs, picking from these on each transfer — the order here is just the usual one.
        </p>
        {/* The column names once, not on every process. */}
        <div className="text-muted-foreground mb-1 hidden grid-cols-[2rem_minmax(0,3fr)_minmax(0,1.6fr)_minmax(0,1.8fr)_6.5rem_6.5rem_10.5rem] gap-2 px-[9px] text-[11px] font-semibold uppercase tracking-wide md:grid">
          <span />
          <span>Process</span>
          <span>Done at</span>
          <span>Line or unit</span>
          <span className="text-right">Rate / pc</span>
          <span>QC check</span>
          <span />
        </div>
        <div className="space-y-1.5">
          {rows.map((r, i) => {
            const o = opById.get(r.operationId)
            const isCut = o?.kind === 'CUTTING'
            const last = i === rows.length - 1
            const open = Boolean(more[r.key])
            // Switched-off processes are offered only where a routing already has them.
            const choices = ops.filter((op) => op.isActive !== false || op.id === r.operationId)
            return (
              <div key={r.key} className="border-border bg-card rounded-lg border p-2">
                <div className="grid grid-cols-2 items-center gap-2 md:grid-cols-[2rem_minmax(0,3fr)_minmax(0,1.6fr)_minmax(0,1.8fr)_6.5rem_6.5rem_10.5rem]">
                  <span className="text-primary font-mono text-xs font-semibold">{i + 1}</span>
                  <div className="col-span-2 md:col-span-1">
                    <SmartSelect className="form-input h-9" value={r.operationId} onChange={(e) => pick(r.key, e.target.value)} aria-label={`Process ${i + 1}`}>
                      <option value="">Pick a process…</option>
                      {choices.map((op) => (
                        <option key={op.id} value={op.id} data-sub={op.isActive === false ? 'Switched off in the Process master' : (op.department?.name ?? undefined)}>
                          {op.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </div>
                  <SmartSelect className="form-input h-9" value={r.execution} disabled={isCut} onChange={(e) => set(r.key, { execution: e.target.value as Execution, workstationId: '' })} aria-label={`Process ${i + 1} done at`}>
                    <option value="IN_HOUSE">Our floor</option>
                    <option value="OUTSOURCED">Outside unit</option>
                  </SmartSelect>
                  <SmartSelect className="form-input h-9" value={r.workstationId} onChange={(e) => set(r.key, { workstationId: e.target.value })} aria-label={`Process ${i + 1} line or unit`}>
                    <option value="">{r.execution === 'OUTSOURCED' ? 'Picked when sent' : 'Any line'}</option>
                    {unitsFor(r).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </SmartSelect>
                  <StepInput decimals className="form-input h-9 text-right tabular-nums" value={r.ratePerPiece} placeholder="Rate" onValueChange={(v) => set(r.key, { ratePerPiece: v })} aria-label={`Process ${i + 1} rate per piece`} />
                  <button
                    type="button"
                    onClick={() => set(r.key, { isQcStep: !r.isQcStep })}
                    aria-pressed={r.isQcStep}
                    title="A check: pieces are passed or failed here"
                    className={`flex h-9 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-medium ${r.isQcStep ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    <ShieldCheck size={13} /> {r.isQcStep ? 'Check' : 'No'}
                  </button>
                  <span className="col-span-2 flex items-center justify-end gap-0.5 md:col-span-1">
                    <button type="button" className="btn-ghost h-8 px-1.5 text-xs" onClick={() => setMore((m) => ({ ...m, [r.key]: !open }))} aria-expanded={open} title="SMV, instructions, leaving it out">
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} More
                    </button>
                    <button type="button" className="btn-ghost p-1" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move process ${i + 1} up`}>
                      <ArrowUp size={13} />
                    </button>
                    <button type="button" className="btn-ghost p-1" onClick={() => move(i, 1)} disabled={last} aria-label={`Move process ${i + 1} down`}>
                      <ArrowDown size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-muted-foreground hover:text-destructive p-1"
                      onClick={() => setRows((rs) => (rs.length === 1 ? rs : rs.filter((x) => x.key !== r.key)))}
                      disabled={rows.length === 1}
                      aria-label={`Remove process ${i + 1}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
                {o && (
                  <p className="text-muted-foreground mt-1 pl-0 text-[11px] md:pl-10">
                    {o.department?.name ?? 'Its department'}
                    {isCut ? ' · first: makes the pieces and the bundles' : last ? ' · last: puts the pieces into finished goods' : ''}
                    {!isCut && (o.kind === 'QC' || r.isQcStep) ? ' · passes or fails pieces' : ''}
                    {r.execution === 'OUTSOURCED' ? ' · goes out on a job-work challan' : ''}
                    {o.isActive === false ? ' · switched off in the Process master' : ''}
                  </p>
                )}
                {open && (
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[2rem_8rem_minmax(0,1fr)_12rem] md:pl-0">
                    <span className="hidden md:block" />
                    <label className="block">
                      <span className="form-label">SMV</span>
                      <StepInput decimals className="form-input h-8 text-right text-xs tabular-nums" value={r.smv} placeholder="—" onValueChange={(v) => set(r.key, { smv: v })} aria-label={`Process ${i + 1} standard minutes`} />
                    </label>
                    <label className="block">
                      <span className="form-label">Instructions for the floor</span>
                      <input className="form-input h-8 text-xs" value={r.instructions} maxLength={500} placeholder={isCut ? 'Lay face up; check shade lot before cutting' : 'What the department must know for this style'} onChange={(e) => set(r.key, { instructions: e.target.value })} />
                    </label>
                    <label className="block">
                      <span className="form-label">Leaving it out of an order</span>
                      <SmartSelect className="form-input h-8" value={isCut ? 'NEVER' : r.skip} disabled={isCut} onChange={(e) => set(r.key, { skip: e.target.value as Skip })} aria-label={`Process ${i + 1} leaving out`}>
                        {SKIPS.map((sk) => (
                          <option key={sk.value} value={sk.value} data-sub={sk.help}>
                            {sk.label}
                          </option>
                        ))}
                      </SmartSelect>
                    </label>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {noCheck && (
          <p className="warn-text mt-2 flex items-start gap-1.5 text-xs">
            <Info size={13} className="mt-px shrink-0" /> There is no check among these, so pieces reach finished goods without one.
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
