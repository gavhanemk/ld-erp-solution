'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, ExternalLink, Info, Loader2, Lock, RefreshCw, Route, Save } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { Flow } from './floor/types'

/**
 * The stages an order's pieces go through, set up and looked after in one
 * window.
 *
 * Which stages an order has, and their order, come only from its style's
 * routing in Masters → Routings: here the routing is picked and its stages
 * loaded as they are. To leave a stage out or change the order, the routing
 * is changed there; an order already loaded then takes the routing's new
 * stages from here — the stages the pieces have reached stay as they are.
 * What can still be set for one order is each stage's own settings: done in
 * our factory or outside, the unit, the rate, a quality check, instructions.
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
  /** Pieces have reached it: it stays as it is. */
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
  skipped: boolean
}
/** What the order's stages would become if taken afresh from its routing. */
interface FromRouting {
  routing: { code: string; name: string; version: number }
  loadedVersion: number | null
  kept: string[]
  now: string[]
  next: string[]
}

let seq = 0
const num = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)))

/** A routing's steps as rows. */
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
    skipped: false,
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
    skipped: !!s.skippedAt,
  }))
}

/** What a row would save, to tell whether anything was changed. */
const shape = (rows: Row[]) => JSON.stringify(rows.map((r) => [r.execution, r.workstationId, r.isQcStep, r.ratePerPiece, r.instructions.trim()]))

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
  // The routing was changed since this order's stages were loaded: what taking its new stages would do.
  const routingMoved = loaded && !!flow?.mo.routing && flow.mo.routing.latest !== flow.mo.routing.version
  const [fresh, setFresh] = useState<FromRouting | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([
      // Every process, so a stage on a process since switched off still shows its name.
      masterResource<Operation>('operations').list({ limit: 300, sort: 'sortOrder', order: 'asc' }),
      masterResource<Unit>('workstations').list({ limit: 300, active: true }),
      loaded ? Promise.resolve(null) : api.get<{ data: RoutingOption[] }>(`/production/routings/for?styleIds=${encodeURIComponent(styleIds.join(','))}`),
      routingMoved ? api.get<{ data: FromRouting }>(`/production/orders/${moId}/route/from-routing`) : Promise.resolve(null),
    ])
      .then(([o, w, r, f]) => {
        if (!alive) return
        setOps((o as Paginated<Operation>).data)
        setUnits((w as Paginated<Unit>).data)
        if (f) setFresh(f.data)
        if (r) {
          setRoutings(r.data)
          // The style's own routing is the one, as Masters → Routings has it.
          const best = r.data.find((x) => !x.problem)
          if (best) {
            setRoutingId(best.id)
            const fromRouting = rowsOfRouting(best)
            setRows(fromRouting)
            setStart(shape(fromRouting))
          }
        }
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the processes.'))
    return () => {
      alive = false
    }
  }, [loaded, styleIds, routingMoved, moId])

  const opById = useMemo(() => new Map(ops.map((o) => [o.id, o])), [ops])
  const routing = routings?.find((r) => r.id === routingId)
  const changed = shape(rows) !== start
  const routingCode = loaded ? flow?.mo.routing?.code : routing?.code

  const pickRouting = (id: string) => {
    setRoutingId(id)
    const r = routings?.find((x) => x.id === id)
    const fromRouting = r ? rowsOfRouting(r) : []
    setRows(fromRouting)
    setStart(shape(fromRouting))
    setMore({})
  }

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const blocker = !rows.length
    ? loaded
      ? 'This order has no stages.'
      : 'Pick the routing first.'
    : loaded && changed && reason.trim().length < 5
      ? 'Say why the settings are changing.'
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

  // The routing's new stages, ahead of the pieces.
  const takeNew = async () => {
    if (reason.trim().length < 5) return setError('Say why the order takes the routing’s new stages, in a few words.')
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${moId}/route/from-routing`, { reason: reason.trim() })
      onSaved(res.message ?? 'Stages taken from the routing.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not take the routing’s new stages.')
    } finally {
      setSaving(false)
    }
  }

  const fromLine = loaded
    ? flow?.mo.routing
      ? `From routing ${flow.mo.routing.code} — ${flow.mo.routing.name} (version ${flow.mo.routing.version}).`
      : null
    : routing
      ? `${routing.applies === 'STYLE' ? `The routing for style ${routing.style?.code}` : routing.applies === 'CATEGORY' ? `The routing for ${routing.category} styles` : 'A routing for any style'}.`
      : null

  return (
    <FormFrame
      icon={Route}
      title={`${moNumber} · stages`}
      subtitle={loaded ? 'The stages each piece goes through, in order, from cutting to packing.' : 'Set up the stages each piece goes through, from cutting to packing.'}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {loaded ? 'Save settings' : 'Load these stages'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="text-muted-foreground">{blocker}</span> : `${rows.length} stages${changed && !loaded ? ', with settings for this order' : ''}.`}
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
              No routing is set for this order&apos;s style yet. Set one in Masters → Routings, then come back.
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

      {/* Which stages and their order: the routing's alone. */}
      <p className="border-border bg-secondary/40 text-muted-foreground flex items-start gap-1.5 rounded-lg border px-3 py-2 text-xs">
        <Info size={13} className="mt-px shrink-0" />
        <span>
          Which stages there are, and their order, come from the routing. To leave a stage out or change the order, change {routingCode ?? 'the routing'} in{' '}
          <a className="text-primary font-medium hover:underline" href="/masters/routings" target="_blank" rel="noopener">
            Masters → Routings <ExternalLink size={11} className="inline" />
          </a>
          {loaded ? ', then take its new stages here.' : '. Here you can set each stage’s own settings for this order: our factory or outside, unit, rate, check, instructions.'}
        </span>
      </p>

      {/* The routing changed after the stages were loaded: the stages ahead of the pieces can follow it. */}
      {routingMoved && (
        <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <p className="text-foreground font-semibold">
            {flow!.mo.routing!.code} has changed since these stages were loaded (version {flow!.mo.routing!.version} → {flow!.mo.routing!.latest}).
          </p>
          {!fresh ? (
            <div className="skeleton mt-2 h-10 w-full rounded-lg" />
          ) : (
            <div className="mt-1.5 space-y-1 text-xs">
              <p>
                <span className="text-muted-foreground">Now: </span>
                {fresh.now.join(' → ')}
              </p>
              <p>
                <span className="text-muted-foreground">From the routing: </span>
                <span className="text-foreground font-medium">{fresh.next.join(' → ')}</span>
              </p>
              {fresh.kept.length > 0 && (
                <p className="text-muted-foreground">
                  {fresh.kept.join(', ')} {fresh.kept.length === 1 ? 'stays as it is' : 'stay as they are'}: pieces have been through.
                </p>
              )}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="block min-w-[14rem] flex-1">
              <span className="form-label">Why</span>
              <input className="form-input h-9" value={reason} maxLength={500} placeholder="e.g. Buyer added kaj buttons" onChange={(e) => setReason(e.target.value)} />
            </label>
            <button type="button" className="btn-primary h-9 px-3 text-sm" onClick={() => void takeNew()} disabled={saving || !fresh}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Take the routing&apos;s new stages
            </button>
          </div>
        </div>
      )}

      {/* The stages, top to bottom, as the pieces go. */}
      {rows.length > 0 && (
        <ol className="space-y-0">
          {rows.map((r, i) => {
            const o = opById.get(r.operationId)
            const open = !!more[r.key]
            const last = i === rows.length - 1
            const locked = r.fixed || r.kind === 'CUTTING'
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
                <div className={`mb-2 min-w-0 flex-1 rounded-xl border px-3 py-2.5 ${r.fixed ? 'border-border bg-secondary/40' : 'border-border bg-card'} ${r.skipped ? 'opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-foreground min-w-[10rem] flex-1 text-sm font-semibold ${r.skipped ? 'line-through' : ''}`}>{r.name || o?.name}</span>
                    {/* Where it is done: our own floor, or sent outside. */}
                    {!locked ? (
                      <div className="border-border bg-secondary inline-flex rounded-lg border p-0.5 text-xs" role="group" aria-label={`Where ${r.name} is done`}>
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
                    {!locked ? (
                      <label className="text-foreground flex items-center gap-1.5 text-xs">
                        <input type="checkbox" className="accent-primary" checked={r.isQcStep} onChange={(e) => set(r.key, { isQcStep: e.target.checked })} />
                        Quality check
                      </label>
                    ) : (
                      r.isQcStep && <span className="badge-info">Quality check</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px]">
                    <span className="text-muted-foreground">
                      {o?.department?.name ? `${o.department.name} department` : ''}
                      {r.workstationId ? ` · ${units.find((u) => u.id === r.workstationId)?.name ?? ''}` : ''}
                      {r.ratePerPiece ? ` · ₹${r.ratePerPiece}/pc` : ''}
                      {r.skipped ? ' · left out' : r.fixed ? ' · pieces have reached it, so it stays' : r.kind === 'CUTTING' ? ' · always first' : ''}
                    </span>
                    {!r.fixed && (
                      <button type="button" className="text-primary inline-flex items-center gap-0.5 font-medium hover:underline" onClick={() => setMore((m) => ({ ...m, [r.key]: !m[r.key] }))}>
                        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {open ? 'Less' : 'More'}
                      </button>
                    )}
                  </div>
                  {open && !r.fixed && (
                    <div className="border-border mt-2 grid gap-2 border-t pt-2 sm:grid-cols-2">
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
                      <label className="block sm:col-span-2">
                        <span className="form-label">Instructions for the floor</span>
                        <input className="form-input h-9" value={r.instructions} maxLength={1000} placeholder="e.g. press at 150°C, no steam" onChange={(e) => set(r.key, { instructions: e.target.value })} />
                      </label>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {loaded && changed && (
        <label className="block">
          <span className="form-label">Why are the settings changing?</span>
          <input className="form-input" value={reason} maxLength={500} placeholder="e.g. Kaj buttons done outside this time" onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
    </FormFrame>
  )
}
