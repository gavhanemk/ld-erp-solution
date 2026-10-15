'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Loader2, Lock, Plus, Route, Save, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { Flow } from './floor/types'

/**
 * The stages an order's pieces go through, set up and changed in one window.
 *
 * Routings are kept per style in Masters → Routings. Here the style's own one
 * is picked already and its stages listed, ready to load as they are or to
 * change for this order alone: add a stage, drop one, move it, send it
 * outside. Once loaded the same window changes them again, with the stages
 * the pieces have already reached locked. The routing itself is never touched.
 */

interface RoutingStep {
  id: string
  operationId: string
  departmentId: string
  workstationId: string | null
  isQcStep: boolean
  execution: 'IN_HOUSE' | 'OUTSOURCED'
  skip: 'OPTIONAL' | 'WITH_APPROVAL' | 'NEVER'
  ratePerPiece: string | number | null
  instructions: string | null
  operation: { name: string; kind: string; instructions: string | null; jobWorkRate: string | number | null }
}
interface RoutingOption {
  id: string
  code: string
  name: string
  version: number
  applies: 'STYLE' | 'CATEGORY' | 'ANY'
  category: string | null
  style: { code: string } | null
  problem: string | null
  steps: RoutingStep[]
}
interface Operation {
  id: string
  name: string
  departmentId: string
  kind: string
  defaultExecution: 'IN_HOUSE' | 'OUTSOURCED'
  jobWorkRate: string | number | null
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
interface Row {
  key: string
  /** An existing stage of the order, when it is kept. */
  id: string | null
  /** Pieces have reached it: it stays where it is. */
  fixed: boolean
  name: string
  kind: string
  operationId: string
  departmentId: string
  execution: 'IN_HOUSE' | 'OUTSOURCED'
  workstationId: string
  isQcStep: boolean
  skip: 'OPTIONAL' | 'WITH_APPROVAL' | 'NEVER'
  ratePerPiece: string
  instructions: string
}

let seq = 0
const num = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)))

/** A routing's steps as rows to change. */
const rowsOfRouting = (r: RoutingOption): Row[] =>
  r.steps.map((s) => ({
    key: `r${++seq}`,
    id: null,
    fixed: false,
    name: s.operation.name,
    kind: s.operation.kind,
    operationId: s.operationId,
    departmentId: s.departmentId,
    execution: s.execution,
    workstationId: s.workstationId ?? '',
    isQcStep: s.isQcStep || s.operation.kind === 'QC',
    skip: s.operation.kind === 'CUTTING' ? 'NEVER' : s.skip,
    ratePerPiece: num(s.ratePerPiece ?? s.operation.jobWorkRate),
    instructions: s.instructions ?? s.operation.instructions ?? '',
  }))

/** The order's own stages as rows, those the pieces have reached locked. */
const rowsOfFlow = (flow: Flow): Row[] => {
  const lastTouched = flow.steps.reduce((at, s, i) => {
    const f = (s as unknown as { figures?: { received: number; inTransit: number; waiting: number; inHand: number; atVendor: number } }).figures
    const busy = !!s.lastActivity || (f && f.received + f.inTransit + f.waiting + f.inHand + f.atVendor > 0) || flow.jobWorkOrders.some((j) => j.step.id === s.id)
    return busy ? i : at
  }, -1)
  return flow.steps.map((s, i) => ({
    key: `r${++seq}`,
    id: s.id,
    fixed: i <= lastTouched,
    name: s.name,
    kind: s.kind,
    operationId: s.operationId,
    departmentId: s.departmentId,
    execution: s.execution,
    workstationId: s.workstationId ?? '',
    isQcStep: s.isQcStep,
    skip: s.skip,
    ratePerPiece: num(s.ratePerPiece),
    instructions: s.instructions ?? '',
  }))
}

/** What a row would save, to tell whether anything was changed. */
const shape = (rows: Row[]) =>
  JSON.stringify(rows.map((r) => [r.operationId, r.execution, r.workstationId, r.isQcStep, r.skip, r.ratePerPiece, r.instructions.trim()]))

export function StagesDialog({
  moId,
  moNumber,
  styleIds,
  flow,
  onClose,
  onSaved,
}: {
  moId: string
  moNumber: string
  styleIds: string[]
  /** The order's flow once its stages are loaded; absent, they are set up from a routing. */
  flow?: Flow | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const loaded = !!flow?.steps.length
  const [routings, setRoutings] = useState<RoutingOption[] | null>(null)
  const [routingId, setRoutingId] = useState('')
  const [rows, setRows] = useState<Row[]>(() => (loaded && flow ? rowsOfFlow(flow) : []))
  const [start, setStart] = useState(() => (loaded && flow ? shape(rowsOfFlow(flow)) : ''))
  const [ops, setOps] = useState<Operation[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [more, setMore] = useState<Record<string, boolean>>({})
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([
      // Every process, so a stage on a process since switched off still shows its name; only active ones are offered.
      masterResource<Operation>('operations').list({ limit: 300, sort: 'sortOrder', order: 'asc' }),
      masterResource<Unit>('workstations').list({ limit: 300, active: true }),
      loaded ? Promise.resolve(null) : api.get<{ data: RoutingOption[] }>(`/production/routings/for?styleIds=${encodeURIComponent(styleIds.join(','))}`),
    ])
      .then(([o, w, r]) => {
        if (!alive) return
        setOps((o as Paginated<Operation>).data)
        setUnits((w as Paginated<Unit>).data)
        if (r) {
          setRoutings(r.data)
          // The style's own routing is the one, as Masters → Routings has it.
          const best = r.data.find((x) => !x.problem)
          if (best) {
            setRoutingId(best.id)
            const fresh = rowsOfRouting(best)
            setRows(fresh)
            setStart(shape(fresh))
          }
        }
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the processes.'))
    return () => {
      alive = false
    }
  }, [loaded, styleIds])

  const opById = useMemo(() => new Map(ops.map((o) => [o.id, o])), [ops])
  const routing = routings?.find((r) => r.id === routingId)
  const changed = shape(rows) !== start

  const pickRouting = (id: string) => {
    setRoutingId(id)
    const r = routings?.find((x) => x.id === id)
    const fresh = r ? rowsOfRouting(r) : []
    setRows(fresh)
    setStart(shape(fresh))
    setMore({})
  }

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  // Cutting comes first and stays first; locked stages stay where they are.
  const pinned = (r: Row) => r.fixed || r.kind === 'CUTTING'
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const j = i + d
      if (j < 0 || j >= rs.length || pinned(rs[i]) || pinned(rs[j])) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const add = () => {
    const blank: Row = { key: `r${++seq}`, id: null, fixed: false, name: '', kind: '', operationId: '', departmentId: '', execution: 'IN_HOUSE', workstationId: '', isQcStep: false, skip: 'WITH_APPROVAL', ratePerPiece: '', instructions: '' }
    // In before packing, which stays the last stage; otherwise at the end.
    setRows((rs) => (rs.length && rs[rs.length - 1].kind === 'PACKING' && !rs[rs.length - 1].fixed ? [...rs.slice(0, -1), blank, rs[rs.length - 1]] : [...rs, blank]))
  }
  const pickProcess = (key: string, id: string) => {
    const op = opById.get(id)
    set(key, {
      operationId: id,
      departmentId: op?.departmentId ?? '',
      name: op?.name ?? '',
      kind: op?.kind ?? '',
      execution: op?.defaultExecution ?? 'IN_HOUSE',
      isQcStep: op?.kind === 'QC',
      workstationId: '',
      ratePerPiece: op?.defaultExecution === 'OUTSOURCED' && op?.jobWorkRate != null ? num(op.jobWorkRate) : '',
      instructions: op?.instructions ?? '',
    })
  }

  const blocker = !rows.length
    ? loaded
      ? 'An order needs at least its cutting stage.'
      : 'Pick the routing first.'
    : rows.some((r) => !r.operationId)
      ? 'Pick a process for every stage.'
      : loaded && changed && reason.trim().length < 5
        ? 'Say why the stages are changing.'
        : loaded && !changed
          ? 'Nothing changed yet.'
          : null

  const steps = () =>
    rows.map((r) => ({
      id: r.id,
      operationId: r.operationId,
      departmentId: r.departmentId || opById.get(r.operationId)?.departmentId,
      execution: r.execution,
      workstationId: r.workstationId || null,
      isQcStep: r.isQcStep,
      skip: r.skip,
      ratePerPiece: r.ratePerPiece === '' ? null : Number(r.ratePerPiece),
      instructions: r.instructions.trim() || null,
    }))

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = loaded
        ? await api.patch<{ message?: string }>(`/production/orders/${moId}/route`, { reason: reason.trim(), steps: steps() })
        : await api.post<{ message?: string }>(`/production/orders/${moId}/routing`, { routingId, ...(changed ? { steps: steps() } : {}) })
      onSaved(res.message ?? 'Stages saved.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the stages.')
    } finally {
      setSaving(false)
    }
  }

  const fromLine = loaded
    ? flow?.mo.routing
      ? `From routing ${flow.mo.routing.code} — ${flow.mo.routing.name}. Changes here are for ${moNumber} only.`
      : `Changes here are for ${moNumber} only.`
    : routing
      ? `${routing.applies === 'STYLE' ? `The routing for style ${routing.style?.code}` : routing.applies === 'CATEGORY' ? `The routing for ${routing.category} styles` : 'A routing for any style'}. Change any stage for ${moNumber} alone — the routing stays as it is.`
      : null

  return (
    <FormFrame
      icon={Route}
      title={`${moNumber} · stages`}
      subtitle={loaded ? 'The stages each piece goes through, in order, from cutting to packing.' : 'Set up the stages each piece goes through, from cutting to packing.'}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {loaded ? 'Save changes' : 'Save stages'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="text-muted-foreground">{blocker}</span> : `${rows.length} stages${changed && !loaded ? ', changed for this order' : ''}.`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {/* Where the stages come from. */}
      {!loaded && (
        <div className="border-border bg-card rounded-xl border px-4 py-3">
          {!routings ? (
            <div className="skeleton h-9 w-full rounded-lg" />
          ) : routings.every((r) => r.problem) ? (
            <p className="warn-text flex items-start gap-1.5 text-sm">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              No routing is set for this order&apos;s style yet. Set one in Production → Routings, then come back.
            </p>
          ) : (
            <label className="block">
              <span className="form-label">Routing</span>
              <SmartSelect className="form-input" value={routingId} onChange={(e) => pickRouting(e.target.value)}>
                {routings.map((r) => (
                  <option
                    key={r.id}
                    value={r.id}
                    disabled={!!r.problem}
                    data-sub={r.problem ?? `${r.applies === 'STYLE' ? `For style ${r.style?.code}` : r.applies === 'CATEGORY' ? `For every ${r.category} style` : 'For any style'} · ${r.steps.length} stages`}
                  >
                    {r.code} — {r.name}
                  </option>
                ))}
              </SmartSelect>
            </label>
          )}
          {fromLine && <p className="text-muted-foreground mt-1.5 text-xs">{fromLine}</p>}
        </div>
      )}
      {loaded && fromLine && <p className="text-muted-foreground px-1 text-sm">{fromLine}</p>}

      {/* The stages, top to bottom, as the pieces go. */}
      {rows.length > 0 && (
        <ol className="space-y-0">
          {rows.map((r, i) => {
            const o = opById.get(r.operationId)
            const open = !!more[r.key]
            const last = i === rows.length - 1
            const unitsHere = units.filter((u) => u.departmentId === (r.departmentId || o?.departmentId) && (r.execution === 'OUTSOURCED' ? u.type === 'JOB_WORK' : u.type === 'IN_HOUSE'))
            return (
              <li key={r.key} className="relative flex gap-3">
                {/* The line joining one stage to the next. */}
                <div className="flex flex-col items-center">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums ${
                      r.fixed ? 'border-border bg-secondary text-muted-foreground' : r.isQcStep ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-card text-foreground'
                    }`}
                  >
                    {r.fixed ? <Lock size={12} /> : i + 1}
                  </span>
                  {!last && <span className="bg-border w-px flex-1" />}
                </div>
                <div className={`mb-2 min-w-0 flex-1 rounded-xl border px-3 py-2.5 ${r.fixed ? 'border-border bg-secondary/40' : 'border-border bg-card'}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.fixed || r.kind === 'CUTTING' ? (
                      <span className="text-foreground min-w-[10rem] flex-1 text-sm font-semibold">{r.name || o?.name}</span>
                    ) : (
                      <div className="min-w-[10rem] flex-1">
                        <SmartSelect className="form-input h-9" value={r.operationId} onChange={(e) => pickProcess(r.key, e.target.value)} aria-label={`Process for stage ${i + 1}`}>
                          <option value="">Pick a process…</option>
                          {ops
                            .filter((op) => op.kind !== 'CUTTING' && (op.isActive !== false || op.id === r.operationId))
                            .map((op) => (
                              <option key={op.id} value={op.id} data-sub={op.department?.name ?? undefined}>
                                {op.name}
                              </option>
                            ))}
                        </SmartSelect>
                      </div>
                    )}
                    {/* Where it is done: our own floor, or sent outside. */}
                    {r.kind !== 'CUTTING' && !r.fixed ? (
                      <div className="border-border bg-secondary inline-flex rounded-lg border p-0.5 text-xs" role="group" aria-label={`Where stage ${i + 1} is done`}>
                        {(['IN_HOUSE', 'OUTSOURCED'] as const).map((x) => (
                          <button
                            key={x}
                            type="button"
                            onClick={() => set(r.key, { execution: x, workstationId: '' })}
                            className={`rounded-md px-2.5 py-1 ${r.execution === x ? 'bg-card text-foreground font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                          >
                            {x === 'IN_HOUSE' ? 'Our factory' : 'Outside'}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">{r.execution === 'OUTSOURCED' ? 'Outside' : 'Our factory'}</span>
                    )}
                    {r.kind !== 'CUTTING' && !r.fixed ? (
                      <label className="text-foreground flex items-center gap-1.5 text-xs">
                        <input type="checkbox" className="accent-primary" checked={r.isQcStep} onChange={(e) => set(r.key, { isQcStep: e.target.checked })} />
                        Quality check
                      </label>
                    ) : (
                      r.isQcStep && <span className="badge-info">Quality check</span>
                    )}
                    <div className="ml-auto flex items-center gap-0.5">
                      {!pinned(r) && (
                        <>
                          <button type="button" className="btn-ghost p-1" onClick={() => move(i, -1)} disabled={i === 0 || pinned(rows[i - 1])} aria-label={`Move stage ${i + 1} up`}>
                            <ArrowUp size={14} />
                          </button>
                          <button type="button" className="btn-ghost p-1" onClick={() => move(i, 1)} disabled={last} aria-label={`Move stage ${i + 1} down`}>
                            <ArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            className="btn-ghost text-muted-foreground hover:text-destructive p-1"
                            onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                            aria-label={`Remove stage ${i + 1}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px]">
                    <span className="text-muted-foreground">
                      {o?.department?.name ? `${o.department.name} department` : ''}
                      {r.workstationId ? ` · ${units.find((u) => u.id === r.workstationId)?.name ?? ''}` : ''}
                      {r.ratePerPiece ? ` · ₹${r.ratePerPiece}/pc` : ''}
                      {r.fixed ? ' · pieces have reached it, so it stays' : r.kind === 'CUTTING' ? ' · always first' : ''}
                    </span>
                    <button type="button" className="text-primary inline-flex items-center gap-0.5 font-medium hover:underline" onClick={() => setMore((m) => ({ ...m, [r.key]: !m[r.key] }))}>
                      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {open ? 'Less' : 'More'}
                    </button>
                  </div>
                  {open && (
                    <div className="border-border mt-2 grid gap-2 border-t pt-2 sm:grid-cols-3">
                      <label className="block">
                        <span className="form-label">{r.execution === 'OUTSOURCED' ? 'Usual outside unit' : 'Line'}</span>
                        <SmartSelect className="form-input h-9" value={r.workstationId} onChange={(e) => set(r.key, { workstationId: e.target.value })}>
                          <option value="">{r.execution === 'OUTSOURCED' ? 'Picked when sent' : 'Any line'}</option>
                          {unitsHere.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </SmartSelect>
                      </label>
                      <label className="block">
                        <span className="form-label">Rate per piece (₹)</span>
                        <StepInput decimals className="form-input h-9 text-right tabular-nums" value={r.ratePerPiece} placeholder="—" onValueChange={(v) => set(r.key, { ratePerPiece: v })} />
                      </label>
                      {r.kind !== 'CUTTING' && !r.fixed && (
                        <label className="block">
                          <span className="form-label">Can it be skipped?</span>
                          <SmartSelect className="form-input h-9" value={r.skip} onChange={(e) => set(r.key, { skip: e.target.value as Row['skip'] })}>
                            <option value="OPTIONAL">Yes, by anyone</option>
                            <option value="WITH_APPROVAL">Only by a manager</option>
                            <option value="NEVER">Never</option>
                          </SmartSelect>
                        </label>
                      )}
                      <label className="block sm:col-span-3">
                        <span className="form-label">Instructions for the floor</span>
                        <input className="form-input h-9" value={r.instructions} maxLength={1000} placeholder="e.g. press at 150°C, no steam" onChange={(e) => set(r.key, { instructions: e.target.value })} />
                      </label>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
          <li className="flex gap-3">
            <span className="w-7 shrink-0" />
            <button type="button" className="btn-secondary h-9 px-3 text-sm" onClick={add} disabled={!ops.length}>
              <Plus size={14} /> Add a stage
            </button>
          </li>
        </ol>
      )}

      {loaded && changed && (
        <label className="block">
          <span className="form-label">Why are the stages changing?</span>
          <input className="form-input" value={reason} maxLength={500} placeholder="e.g. Buyer added kaj buttons" onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
    </FormFrame>
  )
}
