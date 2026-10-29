'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CircleCheck, GripVertical, Info, ListOrdered, Loader2, Lock, Plus, Route, Save, Trash2, Truck } from 'lucide-react'
import { api, ApiError, can, masterResource, type Paginated } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { changed } from './routing/track'
import { MasterFormDialog } from '@/components/masters/MasterFormDialog'
import { styleFormFields } from '@/components/masters/styleFormFields'
import { processFormFields } from '@/components/masters/processFormFields'
import { lineFormFields } from '@/components/masters/lineFormFields'
import { contractorFormFields } from '@/components/masters/contractorFormFields'
import { NewItemDialog, type NewItem } from '@/components/purchase/NewItemDialog'

/**
 * A routing: the ordered path a garment takes through the factory.
 *
 * For one style, for every style of a category (all formal shirts), or for
 * any style, and cut from one fabric — picked from the fabric items in stock,
 * with how much is on hand beside each. Nobody types a code; the system makes
 * one from the style. Each step is a process done by its department — on our
 * floor or at an outside unit — and says who may leave it out, and whether it
 * is a check.
 *
 * Laid out for reading as much as for filling in: the route in one line at
 * the top with its totals, then one row a step under plain column headings —
 * the process, where it is done, the line or unit, minutes and rate a piece,
 * and whether it may be skipped — with a step's instructions and its check
 * opening under its own row. Processes not yet on the route are offered as
 * buttons, each going where the Process Master's order puts it. Steps move by
 * dragging the handle, or with the arrows.
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
  contractorId?: string | null
  smv?: number | string | null
  ratePerPiece?: number | string | null
  isQcStep: boolean
  execution?: Execution
  skip?: Skip
  instructions?: string | null
  operation?: { id: string; name: string; code: string; kind?: Kind }
  department?: { id: string; name: string }
  workstation?: { id: string; name: string; type: string } | null
  contractor?: { id: string; name: string } | null
}

type Person = { id: string; name: string } | null

export interface Routing {
  id: string
  /** Made by the system from the style; no longer typed or shown here. */
  code: string
  name: string
  styleId: string | null
  category: string | null
  fabricItemId?: string | null
  fabric?: { id: string; code: string; name: string; uom?: { symbol: string } | null } | null
  version: number
  isLocked: boolean
  isActive: boolean
  notes: string | null
  createdAt?: string
  updatedAt?: string
  createdBy?: Person
  updatedBy?: Person
  style?: { id: string; code: string; name: string } | null
  steps?: RoutingStep[]
  _count?: { mos: number; boms?: number }
}

/** A fabric item with stock records, as GET /masters/routings/fabrics lists it. */
interface Fabric {
  id: string
  code: string
  name: string
  uom: string
  onHand: number
  customers: number
  /** Not among the fabrics with stock any more, but this routing has it. */
  missing?: boolean
}

const qty = (n: number, uom: string) => `${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${uom}`
/** What the fabric picker says under a fabric's name: how much is in the godown. */
const stockLine = (f: Fabric) =>
  f.missing
    ? 'Not in the stock records now'
    : f.onHand + f.customers <= 0
      ? 'None in stock now'
      : [f.onHand > 0 ? `${qty(f.onHand, f.uom)} in stock` : null, f.customers > 0 ? `${qty(f.customers, f.uom)} customers'` : null].filter(Boolean).join(' · ')

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
  /** The one process it does, when it is tied to one (a Final QC line). */
  operationId?: string | null
  type: 'IN_HOUSE' | 'JOB_WORK'
}
/** A contractor from the Routing Masters, and the process they do. */
interface Contractor {
  id: string
  name: string
  operationId: string
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
  contractorId: string
  execution: Execution
  skip: Skip
  isQcStep: boolean
  smv: string
  ratePerPiece: string
  instructions: string
}

const SKIPS: Array<{ value: Skip; label: string; help: string }> = [
  { value: 'NEVER', label: 'Never skipped', help: 'Every piece goes through it' },
  { value: 'WITH_APPROVAL', label: 'Manager can skip', help: 'Only a production manager can leave it out, with a reason' },
  { value: 'OPTIONAL', label: 'Anyone can skip', help: 'Anyone recording production can leave it out, with a reason' },
]

const APPLIES: Array<{ value: Applies; label: string }> = [
  { value: 'STYLE', label: 'One style' },
  { value: 'CATEGORY', label: 'A category' },
  { value: 'ANY', label: 'Any style' },
]

/** The step columns, the same on the heading and every row of a wide screen. */
const COLS = 'lg:grid-cols-[2.75rem_minmax(9rem,1fr)_8rem_minmax(9rem,1.2fr)_minmax(9rem,1.1fr)_5.5rem_5.5rem_10rem_6.5rem]'

let seq = 0
const blank = (): Row => ({ key: `n${++seq}`, operationId: '', workstationId: '', contractorId: '', execution: 'IN_HOUSE', skip: 'WITH_APPROVAL', isQcStep: false, smv: '', ratePerPiece: '', instructions: '' })
const num = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)))
const figure = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
const rowsOf = (steps: RoutingStep[] | undefined): Row[] =>
  steps?.length
    ? [...steps]
        .sort((a, b) => a.sequence - b.sequence)
        .map((s) => ({
          key: `s${++seq}`,
          operationId: s.operationId,
          workstationId: s.workstationId ?? '',
          contractorId: s.contractorId ?? '',
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
  const [contractors, setContractors] = useState<Contractor[]>([])
  /*
   * A choice that is not in a list yet, being added from that list without
   * leaving the routing: saved to its master, then picked where it was asked
   * for. `rowKey` is the step it was asked for on.
   */
  const [adding, setAdding] = useState<null | { kind: 'style' | 'process' | 'line' | 'contractor'; rowKey?: string; typed: string }>(null)
  // A fabric being added: the new-item window, with the fabric category picked.
  const [newFabric, setNewFabric] = useState(false)
  const [itemCategories, setItemCategories] = useState<Array<{ id: string; name: string; parentId: string | null }>>([])
  const mayAdd = can('masters', 'create')
  const [styles, setStyles] = useState<StyleOption[]>([])
  const [fabrics, setFabrics] = useState<Fabric[]>([])
  const [name, setName] = useState('')
  const [fabricItemId, setFabricItemId] = useState('')
  const [applies, setApplies] = useState<Applies>('STYLE')
  const [styleId, setStyleId] = useState('')
  const [category, setCategory] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [rows, setRows] = useState<Row[]>([blank()])
  /** The step whose instructions and check are open under its row. */
  const [openKey, setOpenKey] = useState<string | null>(null)
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
    setName(record?.name ?? (preset?.from ? preset.from.name : ''))
    setFabricItemId(from?.fabricItemId ?? '')
    setApplies(record ? (record.styleId ? 'STYLE' : record.category ? 'CATEGORY' : 'ANY') : 'STYLE')
    setStyleId(record?.styleId ?? preset?.styleId ?? '')
    setCategory(record?.category ?? '')
    setNotes(record?.notes ?? '')
    setIsActive(record?.isActive ?? true)
    setRows(rowsOf(from?.steps))
    setOpenKey(null)
    setError(null)
  }, [open, record, preset])

  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.all([
      masterResource<Operation>('operations').list({ limit: 300, active: true, sort: 'sortOrder', order: 'asc' }),
      masterResource<Unit>('workstations').list({ limit: 300, active: true }),
      masterResource<StyleOption>('styles').list({ limit: 500, active: true }),
      api.get<{ data: Fabric[] }>('/masters/routings/fabrics'),
      masterResource<Contractor>('contractors').list({ limit: 500, active: true }),
    ])
      .then(([o, w, s, f, c]) => {
        if (!alive) return
        setOps((o as Paginated<Operation>).data)
        setUnits((w as Paginated<Unit>).data)
        setContractors((c as Paginated<Contractor>).data)
        setStyles((s as Paginated<StyleOption>).data)
        setFabrics(f.data)
      })
      .catch(() => alive && setError('Could not load the processes, units and fabrics. Is the API running?'))
    return () => {
      alive = false
    }
  }, [open])

  // The list is the processes in use. One switched off since this routing was
  // made still has to show on its step, or the step reads "Pick a process" and
  // the routing cannot be saved at all — so the routing's own are added back,
  // marked, for the step to be changed or taken off.
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
  // Where a process comes in the Process Master: the order it offers them in.
  const rank = useMemo(() => new Map(ops.map((o, i) => [o.id, i])), [ops])
  // The fabrics with stock records — and the routing's own, the same way as
  // its processes, if it has since dropped off that list.
  const fabricOptions = useMemo(() => {
    const own = (record ?? preset?.from)?.fabric
    if (!own || fabrics.some((f) => f.id === own.id)) return fabrics
    return [...fabrics, { id: own.id, code: own.code, name: own.name, uom: own.uom?.symbol ?? '', onHand: 0, customers: 0, missing: true }]
  }, [fabrics, record, preset])
  const categories = useMemo(() => [...new Set(styles.map((s) => s.category?.trim()).filter(Boolean) as string[])].sort(), [styles])

  if (!open) return null

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  /** What a process usually is: outside or not, a check or not, its rate, minutes and instructions. */
  const defaultsOf = (operationId: string, given?: Operation): Omit<Row, 'key'> => {
    const o = given ?? opById.get(operationId)
    return {
      operationId,
      workstationId: '',
      contractorId: '',
      execution: o?.defaultExecution ?? 'IN_HOUSE',
      isQcStep: o?.kind === 'QC',
      skip: o?.kind === 'CUTTING' ? 'NEVER' : 'WITH_APPROVAL',
      ratePerPiece: o?.defaultExecution === 'OUTSOURCED' ? num(o?.jobWorkRate) : '',
      smv: num(o?.smv),
      instructions: o?.instructions ?? '',
    }
  }
  const pick = (key: string, operationId: string) => set(key, defaultsOf(operationId))
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
  const addStep = () => setRows((rs) => [...rs, blank()])
  /**
   * A process added from the buttons goes where the Process Master's order
   * puts it — washing after stitching, packing last — and never before
   * cutting. A blank step left on the route is filled instead.
   */
  const addProcess = (operationId: string) =>
    setRows((rs) => {
      const row = { key: `n${++seq}`, ...defaultsOf(operationId) }
      const empty = rs.findIndex((r) => !r.operationId)
      if (empty >= 0) return rs.map((r, i) => (i === empty ? { ...row, key: r.key } : r))
      const mine = rank.get(operationId) ?? Infinity
      let at = rs.findIndex((r) => (rank.get(r.operationId) ?? Infinity) > mine)
      if (at === -1) at = rs.length
      if (at === 0 && opById.get(rs[0]?.operationId)?.kind === 'CUTTING' && opById.get(operationId)?.kind !== 'CUTTING') at = 1
      const next = [...rs]
      next.splice(at, 0, row)
      return next
    })
  const remove = (key: string) => {
    if (rows.length === 1) return
    setRows((rs) => rs.filter((r) => r.key !== key))
    if (openKey === key) setOpenKey(null)
  }

  const kinds = rows.map((r) => opById.get(r.operationId)?.kind)
  const blocker = !name.trim()
    ? 'Give it a name.'
    : applies === 'STYLE' && !styleId
      ? 'Pick the style it is for.'
      : applies === 'CATEGORY' && !category.trim()
        ? 'Say which category of styles it is for.'
        : rows.some((r) => !r.operationId)
          ? 'Pick a process on every step, or take the empty step off.'
          : kinds[0] !== 'CUTTING'
            ? 'Start with cutting: that is where the pieces are made.'
            : kinds.filter((k) => k === 'CUTTING').length > 1
              ? 'Cut once: only one cutting step.'
              : null
  const noCheck = rows.length > 0 && !rows.some((r, i) => r.isQcStep || kinds[i] === 'QC')
  const offRoute = rows.filter((r) => opById.get(r.operationId)?.inactive)

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    // No code: the API makes one from the style.
    const payload = {
      name: name.trim(),
      styleId: applies === 'STYLE' ? styleId : null,
      category: applies === 'CATEGORY' ? category.trim() : null,
      fabricItemId: fabricItemId || null,
      notes: notes.trim() || null,
      isActive,
      steps: rows.map((r, i) => ({
        sequence: i + 1,
        operationId: r.operationId,
        departmentId: opById.get(r.operationId)!.departmentId,
        workstationId: r.workstationId || null,
        contractorId: r.contractorId || null,
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
    // A line tied to one process is offered for that process only; the rest for any of their department's.
    return units.filter(
      (u) =>
        (u.operationId ? u.operationId === r.operationId : u.departmentId === o?.departmentId) &&
        (r.execution === 'OUTSOURCED' ? u.type === 'JOB_WORK' : u.type === 'IN_HOUSE'),
    )
  }
  /** The contractors who do this step's process. */
  const contractorsFor = (r: Row) => contractors.filter((c) => c.operationId === r.operationId)

  // The route's totals, for the line above the steps.
  const minutes = rows.reduce((t, r) => t + (Number(r.smv) || 0), 0)
  const rupees = rows.reduce((t, r) => t + (Number(r.ratePerPiece) || 0), 0)
  const outside = rows.filter((r) => r.execution === 'OUTSOURCED').length
  const notOnRoute = ops.filter((o) => !rows.some((r) => r.operationId === o.id))

  return (
    <FormFrame
      icon={Route}
      title={isEdit ? `Edit ${record?.name}` : 'New routing'}
      subtitle={
        isEdit && record
          ? [
              `Version ${record.version}`,
              changed(record),
              record._count?.mos ? `${record._count.mos} ${record._count.mos === 1 ? 'order has' : 'orders have'} a copy of its steps, which a change here does not touch` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : preset?.from
            ? `Starting from the steps of ${preset.from.code}. Change what this style does differently.`
            : 'The steps a garment goes through, in order. Orders take a copy when they are planned.'
      }
      width="max-w-7xl"
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
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : `${rows.length} ${rows.length === 1 ? 'step' : 'steps'} · saving makes a new version for orders to come`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {record?.isLocked && (
        <p className="warn-text flex items-start gap-1.5 text-xs">
          <Lock size={13} className="mt-px shrink-0" /> Locked: its steps cannot change until it is unlocked.
        </p>
      )}

      <Section icon={Route} title="What it is for">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="block lg:col-span-2">
            <span className="form-label">Name</span>
            <input className="form-input" value={name} placeholder="e.g. Shirt with washing" onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="lg:col-span-2">
            <span className="form-label">Used for</span>
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
          <div className="lg:col-span-2">
            {applies === 'STYLE' && (
              <label className="block">
                <span className="form-label">Style</span>
                <SmartSelect
                  className="form-input"
                  value={styleId}
                  onChange={(e) => setStyleId(e.target.value)}
                  onCreate={mayAdd ? (typed) => setAdding({ kind: 'style', typed }) : undefined}
                  createNoun="style"
                >
                  <option value="">Pick the style…</option>
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
                  <option value="">Pick the category…</option>
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
          <label className="block lg:col-span-3">
            <span className="form-label">Fabric (optional)</span>
            <SmartSelect
              className="form-input"
              value={fabricItemId}
              onChange={(e) => setFabricItemId(e.target.value)}
              aria-label="Fabric"
              onCreate={
                mayAdd
                  ? () => {
                      setNewFabric(true)
                      if (!itemCategories.length)
                        void api
                          .get<{ data: Array<{ id: string; name: string; parentId: string | null }> }>('/masters/item-categories?limit=500')
                          .then((r) => setItemCategories(r.data))
                          .catch(() => {})
                    }
                  : undefined
              }
              createNoun="fabric"
            >
              <option value="">{fabricOptions.length ? 'Any fabric' : 'No fabric in stock records'}</option>
              {fabricOptions.map((f) => (
                <option key={f.id} value={f.id} data-sub={stockLine(f)}>
                  {f.name}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="border-border bg-card flex cursor-pointer items-start gap-2.5 self-end rounded-lg border px-3 py-2 text-sm lg:col-span-3">
            <input type="checkbox" className="accent-primary mt-0.5 h-4 w-4" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span>
              <span className="text-foreground block font-medium">Offered on new orders</span>
              <span className="text-muted-foreground text-xs">Untick to stop using it; orders that have its steps keep them.</span>
            </span>
          </label>
        </div>
      </Section>

      <Section
        icon={ListOrdered}
        title="Steps, in the order the garment moves"
        actions={
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={addStep}>
            <Plus size={13} /> Blank step
          </button>
        }
      >
        {/* The whole route in one line, and what it adds up to. */}
        <div className="border-border bg-secondary/40 mb-3 rounded-lg border px-3 py-2.5">
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-sm" aria-label="The route">
            {rows.map((r, i) => {
              const o = opById.get(r.operationId)
              return (
                <li key={r.key} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight size={14} className="text-muted-foreground shrink-0" aria-hidden />}
                  <button
                    type="button"
                    onClick={() => setOpenKey(openKey === r.key ? null : r.key)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                      !o ? 'border-amber-500/50 text-amber-700 border-dashed' : o.inactive ? 'border-red-500/40 text-red-600' : 'border-border bg-card text-foreground hover:border-primary/50',
                    )}
                    title={o ? `${o.name}${r.execution === 'OUTSOURCED' ? ', at an outside unit' : ''}` : 'No process picked yet'}
                  >
                    <span className="text-primary font-mono">{i + 1}</span>
                    {o?.name ?? 'Pick a process'}
                    {r.execution === 'OUTSOURCED' && <Truck size={12} className="text-muted-foreground" aria-label="outside unit" />}
                    {(r.isQcStep || o?.kind === 'QC') && <CircleCheck size={12} className="text-primary" aria-label="a check" />}
                  </button>
                </li>
              )
            })}
          </ol>
          <p className="text-muted-foreground mt-2 text-xs">
            {rows.length} {rows.length === 1 ? 'step' : 'steps'}
            {minutes > 0 ? ` · ${figure(minutes)} standard minutes a piece` : ''}
            {rupees > 0 ? ` · ₹${figure(rupees)} a piece in rates` : ''}
            {outside ? ` · ${outside} at an outside unit` : ''}
          </p>
        </div>

        {/* The headings, on a wide screen; on a narrow one each box carries its own. */}
        <div className={cn('text-muted-foreground hidden gap-2 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide lg:grid', COLS)}>
          <span>Step</span>
          <span>Process</span>
          <span>Done at</span>
          <span>Line or unit</span>
          <span>Contractor</span>
          <span className="text-right">Minutes / pc</span>
          <span className="text-right">Rate ₹ / pc</span>
          <span>If skipped</span>
          <span className="sr-only">Move, details, remove</span>
        </div>

        <ol className="space-y-1.5" aria-label="Steps">
          {rows.map((r, i) => {
            const o = opById.get(r.operationId)
            const isCut = o?.kind === 'CUTTING'
            const isOpen = openKey === r.key
            const extras = (r.isQcStep || o?.kind === 'QC' ? 1 : 0) + (r.instructions.trim() ? 1 : 0)
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
                className={cn(
                  'bg-card rounded-lg border transition-colors',
                  !r.operationId ? 'border-amber-500/50' : o?.inactive ? 'border-red-500/40' : isOpen ? 'border-primary/60' : 'border-border',
                  overKey === r.key && dragKey && dragKey !== r.key && 'border-primary border-dashed',
                  dragKey === r.key && 'opacity-50',
                )}
              >
                <div className={cn('grid grid-cols-2 items-center gap-2 px-2 py-1.5 sm:grid-cols-4', COLS)}>
                  <div className="col-span-2 flex items-center gap-1 sm:col-span-4 lg:col-span-1">
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
                    <span className="text-primary font-mono text-sm font-semibold">{i + 1}</span>
                  </div>
                  <label className="col-span-2 block min-w-0 sm:col-span-4 lg:col-span-1">
                    <span className="form-label lg:sr-only">Process</span>
                    <SmartSelect
                      className="form-input h-9"
                      value={r.operationId}
                      onChange={(e) => pick(r.key, e.target.value)}
                      aria-label={`Step ${i + 1} process`}
                      onCreate={mayAdd ? (typed) => setAdding({ kind: 'process', rowKey: r.key, typed }) : undefined}
                      createNoun="process"
                    >
                      <option value="">Pick a process…</option>
                      {processOptions.map((op) => (
                        <option key={op.id} value={op.id} data-sub={op.department?.name ?? undefined}>
                          {op.inactive ? `${op.name} (switched off in the Routing Masters)` : op.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="block min-w-0">
                    <span className="form-label lg:sr-only">Done at</span>
                    <SmartSelect
                      className="form-input h-9"
                      value={r.execution}
                      disabled={isCut}
                      onChange={(e) => set(r.key, { execution: e.target.value as Execution, workstationId: '', contractorId: '' })}
                      aria-label={`Step ${i + 1} where it is done`}
                    >
                      <option value="IN_HOUSE">Our floor</option>
                      <option value="OUTSOURCED">Outside unit</option>
                    </SmartSelect>
                  </label>
                  <label className="block min-w-0">
                    <span className="form-label lg:sr-only">Line or unit</span>
                    <SmartSelect
                      className="form-input h-9"
                      value={r.workstationId}
                      onChange={(e) => set(r.key, { workstationId: e.target.value })}
                      aria-label={`Step ${i + 1} line or unit`}
                      onCreate={mayAdd && r.operationId ? (typed) => setAdding({ kind: 'line', rowKey: r.key, typed }) : undefined}
                      createNoun={r.execution === 'OUTSOURCED' ? 'outside unit' : 'line or table'}
                    >
                      <option value="">{r.execution === 'OUTSOURCED' ? 'Picked when sent' : 'Any line'}</option>
                      {unitsFor(r).map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="block min-w-0">
                    <span className="form-label lg:sr-only">Contractor</span>
                    <SmartSelect
                      className="form-input h-9"
                      value={r.contractorId}
                      disabled={r.execution === 'OUTSOURCED'}
                      onChange={(e) => set(r.key, { contractorId: e.target.value })}
                      aria-label={`Step ${i + 1} contractor`}
                      onCreate={mayAdd && r.operationId && r.execution !== 'OUTSOURCED' ? (typed) => setAdding({ kind: 'contractor', rowKey: r.key, typed }) : undefined}
                      createNoun="contractor"
                      title={r.execution === 'OUTSOURCED' ? 'An outside unit is paid as the unit, not through a contractor' : 'Who does this step; add them under Routing Masters, Contractors'}
                    >
                      <option value="">{r.execution === 'OUTSOURCED' ? '—' : contractorsFor(r).length ? 'Any contractor' : 'None added yet'}</option>
                      {contractorsFor(r).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <label className="block min-w-0">
                    <span className="form-label lg:sr-only">Minutes / pc</span>
                    <StepInput
                      decimals
                      className="form-input h-9 text-right tabular-nums"
                      value={r.smv}
                      placeholder="—"
                      onValueChange={(v) => set(r.key, { smv: v })}
                      aria-label={`Step ${i + 1} standard minutes a piece`}
                      title="Standard minutes for one piece (SMV)"
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="form-label lg:sr-only">Rate ₹ / pc</span>
                    <StepInput
                      decimals
                      className="form-input h-9 text-right tabular-nums"
                      value={r.ratePerPiece}
                      placeholder="—"
                      onValueChange={(v) => set(r.key, { ratePerPiece: v })}
                      aria-label={`Step ${i + 1} rate per piece`}
                      title={r.execution === 'OUTSOURCED' ? 'What the outside unit is paid a piece' : 'The rate a piece for this step'}
                    />
                  </label>
                  <label className="col-span-2 block min-w-0 sm:col-span-2 lg:col-span-1">
                    <span className="form-label lg:sr-only">If skipped</span>
                    <SmartSelect
                      className="form-input h-9"
                      value={isCut ? 'NEVER' : r.skip}
                      disabled={isCut}
                      onChange={(e) => set(r.key, { skip: e.target.value as Skip })}
                      aria-label={`Step ${i + 1} who may skip it`}
                      title={isCut ? 'Cutting makes the pieces, so it is never skipped' : SKIPS.find((s) => s.value === r.skip)?.help}
                    >
                      {SKIPS.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  <div className="col-span-2 flex items-center justify-end gap-0.5 sm:col-span-2 lg:col-span-1">
                    <button
                      type="button"
                      className={cn('btn-ghost relative p-1.5', isOpen && 'text-primary')}
                      onClick={() => setOpenKey(isOpen ? null : r.key)}
                      aria-expanded={isOpen}
                      aria-label={`Step ${i + 1} instructions and check`}
                      title="Instructions and check"
                    >
                      <ChevronDown size={15} className={cn('transition-transform', isOpen && 'rotate-180')} />
                      {extras > 0 && !isOpen && <span className="bg-primary absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full" aria-hidden />}
                    </button>
                    <button type="button" className="btn-ghost p-1" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} earlier`} title="Earlier">
                      <ArrowUp size={14} />
                    </button>
                    <button type="button" className="btn-ghost p-1" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move step ${i + 1} later`} title="Later">
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-muted-foreground hover:text-destructive p-1"
                      onClick={() => remove(r.key)}
                      disabled={rows.length === 1}
                      aria-label={`Remove step ${i + 1}`}
                      title="Take this step off"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* What the row does not show, in a line — only when there is something: a
                    department other than the process's own name, a check, instructions. */}
                {o &&
                  !isOpen &&
                  (() => {
                    const dept = o.department?.name
                    const said = [
                      dept && dept.toLowerCase() !== o.name.toLowerCase() ? `Done by ${dept}` : null,
                      r.isQcStep || o.kind === 'QC' ? 'a check: pieces pass or fail here' : null,
                      r.instructions.trim() || null,
                      o.inactive ? 'switched off in the Routing Masters: change it or take the step off' : null,
                    ].filter(Boolean)
                    return said.length ? <p className="text-muted-foreground -mt-0.5 truncate px-2 pb-1.5 text-[11px] lg:pl-[3.75rem]">{said.join(' · ')}</p> : null
                  })()}

                {isOpen && (
                  <div className="border-border bg-secondary/30 grid gap-3 border-t px-3 py-3 md:grid-cols-[16rem_1fr] lg:pl-[3.75rem]">
                    <div className="space-y-2">
                      <p className="text-muted-foreground text-xs">
                        {o ? (
                          <>
                            Done by {o.department?.name ?? 'its department'}
                            {isCut ? ': makes the pieces and the bundles.' : '.'}
                            {r.execution === 'OUTSOURCED' ? ' Goes out on a job-work challan.' : ''}
                          </>
                        ) : (
                          'Pick the process for this step first.'
                        )}
                      </p>
                      <label className="border-border bg-card flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-xs">
                        <input type="checkbox" className="accent-primary mt-0.5" checked={r.isQcStep} onChange={(e) => set(r.key, { isQcStep: e.target.checked })} />
                        <span>
                          <span className="text-foreground block font-medium">A check</span>
                          <span className="text-muted-foreground">Pieces are passed or failed here, not made</span>
                        </span>
                      </label>
                    </div>
                    <label className="block">
                      <span className="form-label">Instructions for the floor</span>
                      <textarea
                        className="form-input text-xs"
                        rows={3}
                        value={r.instructions}
                        maxLength={500}
                        placeholder={isCut ? 'Lay face up; check shade lot before cutting' : 'What the department must know for this style'}
                        onChange={(e) => set(r.key, { instructions: e.target.value })}
                      />
                    </label>
                  </div>
                )}
              </li>
            )
          })}
        </ol>

        {/* Processes not yet on the route, one press each. */}
        {notOnRoute.length > 0 && (
          <div className="mt-3">
            <p className="text-muted-foreground mb-1.5 text-xs">Add a process — it goes where the Routing Masters&apos; order puts it; move it if this style differs:</p>
            <div className="flex flex-wrap gap-1.5">
              {notOnRoute.map((op) => (
                <button
                  key={op.id}
                  type="button"
                  onClick={() => addProcess(op.id)}
                  className="border-border bg-card text-foreground hover:border-primary/60 hover:text-primary flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
                  title={op.department?.name ?? undefined}
                >
                  <Plus size={12} /> {op.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {offRoute.length > 0 && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600">
            <Info size={13} className="mt-px shrink-0" />
            {offRoute.map((r) => opById.get(r.operationId)?.name).join(', ')} {offRoute.length === 1 ? 'is' : 'are'} switched off in the Routing Masters. Take{' '}
            {offRoute.length === 1 ? 'it' : 'them'} off the route, or pick another process.
          </p>
        )}
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

      {adding?.kind === 'style' && (
        <MasterFormDialog<StyleOption & { id: string }>
          open
          stacked
          onClose={() => setAdding(null)}
          onSaved={() => {}}
          onCreated={(row) => {
            setStyles((ss) => [...ss, row])
            setStyleId(row.id)
          }}
          resource="styles"
          fields={styleFormFields}
          initialValues={{ ...(adding.typed ? { name: adding.typed } : {}), isActive: true }}
          title="Style"
          columns={4}
          wide
        />
      )}
      {adding?.kind === 'process' && (
        <MasterFormDialog<Operation>
          open
          stacked
          onClose={() => setAdding(null)}
          onSaved={() => {}}
          onCreated={(row) => {
            setOps((os) => [...os, row])
            if (adding.rowKey) set(adding.rowKey, defaultsOf(row.id, row))
          }}
          resource="operations"
          fields={processFormFields}
          initialValues={{ ...(adding.typed ? { name: adding.typed } : {}), isActive: true }}
          title="Process"
          columns={3}
        />
      )}
      {adding?.kind === 'line' &&
        (() => {
          const step = rows.find((x) => x.key === adding.rowKey)
          const o = step ? opById.get(step.operationId) : undefined
          return (
            <MasterFormDialog<Unit>
              open
              stacked
              onClose={() => setAdding(null)}
              onSaved={() => {}}
              onCreated={(row) => {
                setUnits((us) => [...us, row])
                // Picked on the step when it fits it: its process (or department) and where it is done.
                const fits =
                  step &&
                  (row.operationId ? row.operationId === step.operationId : row.departmentId === o?.departmentId) &&
                  (step.execution === 'OUTSOURCED' ? row.type === 'JOB_WORK' : row.type === 'IN_HOUSE')
                if (fits && adding.rowKey) set(adding.rowKey, { workstationId: row.id })
              }}
              resource="workstations"
              fields={lineFormFields}
              initialValues={{
                ...(adding.typed ? { name: adding.typed } : {}),
                departmentId: o?.departmentId ?? '',
                operationId: step?.operationId ?? '',
                type: step?.execution === 'OUTSOURCED' ? 'JOB_WORK' : 'IN_HOUSE',
                isActive: true,
              }}
              title="Line"
              columns={4}
              wide
            />
          )
        })()}
      {adding?.kind === 'contractor' &&
        (() => {
          const step = rows.find((x) => x.key === adding.rowKey)
          return (
            <MasterFormDialog<Contractor>
              open
              stacked
              onClose={() => setAdding(null)}
              onSaved={() => {}}
              onCreated={(row) => {
                setContractors((cs) => [...cs, row])
                if (step && row.operationId === step.operationId && adding.rowKey) set(adding.rowKey, { contractorId: row.id })
              }}
              resource="contractors"
              fields={contractorFormFields}
              initialValues={{ ...(adding.typed ? { name: adding.typed } : {}), operationId: step?.operationId ?? '', isActive: true }}
              title="Contractor"
              columns={3}
            />
          )
        })()}
      {newFabric && (
        <NewItemDialog
          categories={itemCategories}
          categoryId={itemCategories.find((c) => !c.parentId && /fabric/i.test(c.name))?.id}
          onClose={() => setNewFabric(false)}
          onCreated={(item: NewItem) => {
            setNewFabric(false)
            setFabrics((fs) => [...fs, { id: item.id, code: item.code, name: item.name, uom: item.uom?.symbol ?? '', onHand: 0, customers: 0 }])
            setFabricItemId(item.id)
          }}
        />
      )}
    </FormFrame>
  )
}
