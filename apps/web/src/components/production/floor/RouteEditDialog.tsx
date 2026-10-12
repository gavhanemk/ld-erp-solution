'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Loader2, Lock, Plus, Route, Save, Trash2 } from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { Flow } from './types'

/**
 * This order's own route, changed for it alone — a buyer adds kaj buttons, a
 * wash is dropped. Only ahead of the pieces: steps they have reached, or gone
 * past, stay where they are, and only their instructions, rate and unit can
 * change. The routing master is not touched.
 */

interface Operation {
  id: string
  name: string
  departmentId: string
  kind: string
  defaultExecution: 'IN_HOUSE' | 'OUTSOURCED'
  jobWorkRate: string | number | null
  instructions: string | null
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
  id: string | null
  fixed: boolean
  name: string
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

export function RouteEditDialog({ flow, onClose, onSaved }: { flow: Flow; onClose: () => void; onSaved: (message: string) => void }) {
  // Pieces have reached a step when anything has happened there or it holds anything.
  const lastTouched = flow.steps.reduce((at, s, i) => {
    const f = s.figures
    const busy = !!s.lastActivity || (f && f.received + f.inTransit + f.waiting + f.inHand + f.atVendor > 0) || flow.jobWorkOrders.some((j) => j.step.id === s.id)
    return busy ? i : at
  }, -1)
  const [rows, setRows] = useState<Row[]>(() =>
    flow.steps.map((s, i) => ({
      key: `r${++seq}`,
      id: s.id,
      fixed: i <= lastTouched,
      name: s.name,
      operationId: s.operationId,
      departmentId: s.departmentId,
      execution: s.execution,
      workstationId: s.workstationId ?? '',
      isQcStep: s.isQcStep,
      skip: s.skip,
      ratePerPiece: s.ratePerPiece != null ? String(s.ratePerPiece) : '',
      instructions: s.instructions ?? '',
    })),
  )
  const [ops, setOps] = useState<Operation[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([masterResource<Operation>('operations').list({ limit: 300, active: true, sort: 'sortOrder', order: 'asc' }), masterResource<Unit>('workstations').list({ limit: 300, active: true })])
      .then(([o, w]) => {
        if (!alive) return
        setOps((o as Paginated<Operation>).data)
        setUnits((w as Paginated<Unit>).data)
      })
      .catch(() => alive && setError('Could not load the processes.'))
    return () => {
      alive = false
    }
  }, [])
  const opById = useMemo(() => new Map(ops.map((o) => [o.id, o])), [ops])

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const firstFree = rows.findIndex((r) => !r.fixed)
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const j = i + d
      if (j < 0 || j >= rs.length || rs[i].fixed || rs[j].fixed) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const add = () =>
    setRows((rs) => [
      ...rs,
      { key: `r${++seq}`, id: null, fixed: false, name: '', operationId: '', departmentId: '', execution: 'IN_HOUSE', workstationId: '', isQcStep: false, skip: 'WITH_APPROVAL', ratePerPiece: '', instructions: '' },
    ])

  const blocker = rows.some((r) => !r.operationId) ? 'Pick a process on every step.' : reason.trim().length < 5 ? 'Say why the route is changing.' : null
  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(`/production/orders/${flow.mo.id}/route`, {
        reason: reason.trim(),
        steps: rows.map((r) => ({
          id: r.id,
          operationId: r.operationId,
          departmentId: r.departmentId || opById.get(r.operationId)?.departmentId,
          execution: r.execution,
          workstationId: r.workstationId || null,
          isQcStep: r.isQcStep,
          skip: r.skip,
          ratePerPiece: r.ratePerPiece === '' ? null : Number(r.ratePerPiece),
          instructions: r.instructions.trim() || null,
        })),
      })
      onSaved(res.message ?? 'Route changed.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the route.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Route}
      title={`Change the route of ${flow.mo.moNumber}`}
      subtitle="For this order alone. The routing it came from stays as it is."
      width="max-w-5xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save route
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : `${rows.length} steps`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section
        icon={Route}
        title="Steps"
        actions={
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={add}>
            <Plus size={13} /> Add step
          </button>
        }
      >
        <div className="space-y-2">
          {rows.map((r, i) => {
            const o = opById.get(r.operationId)
            return (
              <div key={r.key} className={`rounded-lg border p-2.5 ${r.fixed ? 'border-border bg-secondary/40' : 'border-border bg-card'}`}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-12 sm:items-end">
                  <div className="text-primary flex items-center gap-1 font-mono text-xs sm:col-span-1 sm:pb-2">
                    {i + 1}
                    {r.fixed && <Lock size={11} className="text-muted-foreground" aria-label="Pieces have reached it" />}
                  </div>
                  {r.fixed ? (
                    <div className="col-span-2 sm:col-span-4 sm:pb-2">
                      <p className="text-foreground text-sm font-medium">{r.name}</p>
                      <p className="text-muted-foreground text-[11px]">Pieces have reached it: it stays where it is.</p>
                    </div>
                  ) : (
                    <>
                      <label className="col-span-2 block sm:col-span-3">
                        <span className="form-label">Process</span>
                        <SmartSelect
                          className="form-input h-9"
                          value={r.operationId}
                          onChange={(e) => {
                            const op = opById.get(e.target.value)
                            set(r.key, {
                              operationId: e.target.value,
                              departmentId: op?.departmentId ?? '',
                              name: op?.name ?? '',
                              execution: op?.defaultExecution ?? 'IN_HOUSE',
                              isQcStep: op?.kind === 'QC',
                              workstationId: '',
                              ratePerPiece: op?.defaultExecution === 'OUTSOURCED' && op?.jobWorkRate != null ? String(Number(op.jobWorkRate)) : '',
                              instructions: op?.instructions ?? '',
                            })
                          }}
                        >
                          <option value="">Select…</option>
                          {ops
                            .filter((op) => op.kind !== 'CUTTING')
                            .map((op) => (
                              <option key={op.id} value={op.id} data-sub={op.department?.name ?? undefined}>
                                {op.name}
                              </option>
                            ))}
                        </SmartSelect>
                      </label>
                      <label className="block sm:col-span-1">
                        <span className="form-label">Done</span>
                        <SmartSelect className="form-input h-9" value={r.execution} onChange={(e) => set(r.key, { execution: e.target.value as Row['execution'], workstationId: '' })}>
                          <option value="IN_HOUSE">Floor</option>
                          <option value="OUTSOURCED">Outside</option>
                        </SmartSelect>
                      </label>
                    </>
                  )}
                  <label className="block sm:col-span-2">
                    <span className="form-label">{r.execution === 'OUTSOURCED' ? 'Usual unit' : 'Line'}</span>
                    <SmartSelect className="form-input h-9" value={r.workstationId} onChange={(e) => set(r.key, { workstationId: e.target.value })}>
                      <option value="">{r.execution === 'OUTSOURCED' ? 'Picked when sent' : 'Any'}</option>
                      {units
                        .filter((u) => u.departmentId === (r.departmentId || o?.departmentId) && (r.execution === 'OUTSOURCED' ? u.type === 'JOB_WORK' : u.type === 'IN_HOUSE'))
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                    </SmartSelect>
                  </label>
                  {!r.fixed && (
                    <label className="block sm:col-span-2">
                      <span className="form-label">Leaving it out</span>
                      <SmartSelect className="form-input h-9" value={r.skip} onChange={(e) => set(r.key, { skip: e.target.value as Row['skip'] })}>
                        <option value="OPTIONAL">Can be left out</option>
                        <option value="WITH_APPROVAL">Manager only</option>
                        <option value="NEVER">Never left out</option>
                      </SmartSelect>
                    </label>
                  )}
                  <label className={`block ${r.fixed ? 'sm:col-span-3' : 'sm:col-span-1'}`}>
                    <span className="form-label">Rate / pc</span>
                    <StepInput decimals className="form-input h-9 text-right tabular-nums" value={r.ratePerPiece} placeholder="—" onValueChange={(v) => set(r.key, { ratePerPiece: v })} />
                  </label>
                  <div className="flex items-center justify-end gap-1 sm:col-span-2 sm:pb-1.5">
                    {!r.fixed && (
                      <>
                        <label className="mr-1 flex items-center gap-1 text-xs">
                          <input type="checkbox" className="accent-primary" checked={r.isQcStep} onChange={(e) => set(r.key, { isQcStep: e.target.checked })} />
                          Check
                        </label>
                        <button type="button" className="btn-ghost p-1" onClick={() => move(i, -1)} disabled={i <= firstFree} aria-label={`Move step ${i + 1} earlier`}>
                          <ArrowUp size={13} />
                        </button>
                        <button type="button" className="btn-ghost p-1" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move step ${i + 1} later`}>
                          <ArrowDown size={13} />
                        </button>
                        <button type="button" className="btn-ghost text-muted-foreground hover:text-destructive p-1" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={`Remove step ${i + 1}`}>
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <label className="mt-2 block">
                  <span className="form-label">Instructions for the floor</span>
                  <input className="form-input h-8 text-xs" value={r.instructions} maxLength={1000} onChange={(e) => set(r.key, { instructions: e.target.value })} />
                </label>
              </div>
            )
          })}
        </div>
      </Section>
      <label className="block">
        <span className="form-label">Why it is changing</span>
        <input className="form-input" value={reason} maxLength={500} placeholder="Buyer added kaj buttons" onChange={(e) => setReason(e.target.value)} />
      </label>
    </FormFrame>
  )
}
