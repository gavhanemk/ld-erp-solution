'use client'
import { useEffect, useState } from 'react'
import { ChevronRight, CircleCheck, ListOrdered, Loader2, Plus, Route, Truck } from 'lucide-react'
import type { SampleRouteStep, SampleSpecGap } from '@ld-erp/shared'
import { api, apiErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { LoadingRow, Notice } from '@/components/settings/ui'
import { PROCESS_KINDS } from '@/components/masters/processFormFields'
import type { Lookups } from '../types'
import {
  blankStep,
  moveRow,
  newStep,
  plural,
  routeHasSteps,
  routeRules,
  ROUTE_TEXT,
  stepDoneAt,
  stepsOf,
  stepWithOperation,
  type EditStep,
  type SpecDraft,
} from '../specRules'
import { CELL, READOUT, RowTools, TabGaps, TH, useConfirm, Warn } from './parts'

type Update = (change: (d: SpecDraft) => SpecDraft) => void
/** A routing as GET /sampling/:id/routings offers it, best fit first. */
interface RoutingChoice {
  id: string
  code: string
  name: string
  version: number
  style: { code: string; name: string } | null
  category: string | null
  applies: 'STYLE' | 'CATEGORY' | 'ANY'
  problem: string | null
  steps: number
}

const kindLabel = (kind: string) => PROCESS_KINDS.find((k) => k.value === kind)?.label ?? kind

/**
 * The round's making route, as the routing master lays a route out: one row a
 * step, in order, each a process from the Operation master with where it is
 * done and who does it. It can start from the usual route (the first cutting,
 * stitching, finishing and check processes in use) or from one of the style's
 * routings, without their rates. Every route is cut first, and once.
 *
 * A line grid of the ERP: Alt+A adds a step, Alt+Delete removes one.
 */
export function RouteTab({
  draft,
  update,
  lookups,
  requestId,
  styleCode,
  gaps,
}: {
  draft: SpecDraft
  update: Update
  lookups: Lookups
  requestId: string
  /** The request's style, to say whose routings are offered; null with none yet. */
  styleCode: string | null
  gaps: SampleSpecGap[]
}) {
  const { ask, dialog } = useConfirm()
  const [usual, setUsual] = useState<{ loading: boolean; error: string }>({
    loading: false,
    error: '',
  })
  const [picking, setPicking] = useState(false)
  const opById = new Map(lookups.operations.map((o) => [o.id, o]))
  const deptName = (id: string) => lookups.departments.find((d) => d.id === id)?.name
  const rules = routeRules(draft.route)
  const filled = routeHasSteps(draft.route)

  const setStep = (key: string, change: (s: EditStep) => EditStep) =>
    update((d) => ({ ...d, route: d.route.map((s) => (s.key === key ? change(s) : s)) }))
  const replaceRoute = (steps: SampleRouteStep[]) =>
    update((d) => ({ ...d, route: stepsOf(steps) }))
  const addStep = () => update((d) => ({ ...d, route: [...d.route, newStep()] }))
  const removeStep = (s: EditStep, i: number) => {
    const go = () => update((d) => ({ ...d, route: d.route.filter((x) => x.key !== s.key) }))
    if (blankStep(s)) return go()
    ask({
      title: `Remove ${s.name.trim() || `step ${i + 1}`}?`,
      description: `${s.name.trim() || 'This step'} comes off the making route, with who does it and its instructions.`,
      confirmLabel: 'Remove the step',
      run: go,
    })
  }
  const takeUsual = async () => {
    setUsual({ loading: true, error: '' })
    try {
      const res = await api.get<{ data: SampleRouteStep[] }>('/sampling/route-template')
      setUsual({ loading: false, error: '' })
      if (!res.data.length)
        return setUsual({
          loading: false,
          error:
            'No cutting, stitching, finishing or check process is in use in Routing Masters → Processes, so there is no usual route. Add the steps one by one.',
        })
      if (!filled) return replaceRoute(res.data)
      ask({
        title: 'Replace the route with the usual one?',
        description: `The usual route is ${res.data.map((s) => s.name).join(' → ')}. It replaces the ${plural(draft.route.length, 'step')} on this round’s route, with who does them and their instructions.`,
        confirmLabel: 'Use the usual route',
        run: () => replaceRoute(res.data),
      })
    } catch (e) {
      setUsual({
        loading: false,
        error: apiErrorMessage(e, 'Could not read the usual route. Try again.'),
      })
    }
  }

  return (
    <div className="space-y-4">
      <Section
        icon={Route}
        title={
          draft.route.length
            ? `Making route (${plural(draft.route.length, 'step')})`
            : 'Making route'
        }
        actions={
          <>
            <button
              type="button"
              className="btn-secondary h-8 px-3 text-xs"
              disabled={usual.loading}
              onClick={() => void takeUsual()}
              title="The first cutting, stitching, finishing and check processes in Routing Masters"
            >
              {usual.loading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ListOrdered size={14} />
              )}
              Use the usual route
            </button>
            <button
              type="button"
              className="btn-secondary h-8 px-3 text-xs"
              onClick={() => setPicking(true)}
              title="Copy the steps of one of the style’s routings, without their rates"
            >
              <Route size={14} /> Start from a routing
            </button>
            <button
              type="button"
              className="btn-secondary h-8 px-3 text-xs"
              data-grid-add
              aria-keyshortcuts="Alt+A"
              disabled={draft.route.length >= 20}
              onClick={addStep}
            >
              <Plus size={14} /> Add a step
            </button>
          </>
        }
      >
        {usual.error && (
          <div className="mb-3">
            <Notice kind="error">{usual.error}</Notice>
          </div>
        )}
        {/* The whole route in one line, as the routing master shows it. */}
        {draft.route.length > 0 && (
          <ol
            className="border-border bg-secondary/40 mb-3 flex flex-wrap items-center gap-x-1 gap-y-1.5 rounded-lg border px-3 py-2.5 text-sm"
            aria-label="The route"
          >
            {draft.route.map((s, i) => (
              <li key={s.key} className="flex items-center gap-1">
                {i > 0 && (
                  <ChevronRight size={14} className="text-muted-foreground shrink-0" aria-hidden />
                )}
                <span
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
                    s.operationId ? 'border-border bg-card' : 'border-accent border-dashed'
                  )}
                >
                  <span className="text-primary font-mono">{i + 1}</span>
                  {/* A process's name can run to 200 characters: the line shows its start. */}
                  <span
                    className="max-w-[16rem] truncate"
                    title={s.name || opById.get(s.operationId)?.name || undefined}
                  >
                    {s.name || opById.get(s.operationId)?.name || 'Pick a process'}
                  </span>
                  {s.execution === 'OUTSOURCED' && (
                    <Truck size={12} className="text-muted-foreground" aria-label="outside unit" />
                  )}
                  {s.operationId && s.kind === 'QC' && (
                    <CircleCheck size={12} className="text-primary" aria-label="a check" />
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
        <div data-grid className="border-border bg-card overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[1240px] table-fixed text-sm">
            <colgroup>
              <col className="w-10" />
              <col className="w-56" />
              <col className="w-44" />
              <col className="w-40" />
              <col className="w-36" />
              <col className="w-52" />
              <col />
              <col className="w-24" />
            </colgroup>
            <thead className="bg-secondary/60">
              <tr className="border-border border-b">
                <th className={cn(TH, 'pl-3')}>#</th>
                <th className={TH}>Process</th>
                <th className={TH}>Step name</th>
                <th className={TH}>Department</th>
                <th className={TH}>Done at</th>
                <th className={TH}>Contractor or outside unit</th>
                <th className={TH}>Instructions</th>
                <th className={cn(TH, 'pr-3')}>
                  <span className="sr-only">Move or remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.route.map((s, i) => {
                const op = opById.get(s.operationId)
                const wrong =
                  rules.steps[i] || (!s.operationId ? 'Pick the process for this step.' : '')
                const isCut = !!s.operationId && s.kind === 'CUTTING'
                const deptGone = !!s.departmentId && !deptName(s.departmentId)
                const outside = s.execution === 'OUTSOURCED'
                const takers = lookups.contractors.filter((c) =>
                  c.operationIds.includes(s.operationId)
                )
                const service = lookups.jobWorkers.filter((v) => v.category === 'SERVICE')
                const others = lookups.jobWorkers.filter((v) => v.category !== 'SERVICE')
                return (
                  <tr key={s.key} data-grid-row className="border-border/50 border-b align-top">
                    <td className="text-primary py-2 pl-3 pr-1 font-mono text-xs font-semibold leading-9">
                      {i + 1}
                    </td>
                    <td className="px-1.5 py-1.5">
                      <SmartSelect
                        className={cn(CELL, 'w-full', wrong && 'border-accent')}
                        value={s.operationId}
                        aria-label={`Step ${i + 1} process`}
                        title={wrong || undefined}
                        onChange={(e) => {
                          const next = opById.get(e.target.value)
                          if (next)
                            setStep(s.key, (x) =>
                              stepWithOperation(x, next, opById.get(x.operationId))
                            )
                        }}
                      >
                        <option value="">Pick a process…</option>
                        {s.operationId && !op && (
                          <option value={s.operationId}>Not in use any more: pick another</option>
                        )}
                        {lookups.operations.map((o) => (
                          <option
                            key={o.id}
                            value={o.id}
                            data-sub={[kindLabel(o.kind), deptName(o.departmentId)]
                              .filter(Boolean)
                              .join(' · ')}
                          >
                            {o.name}
                          </option>
                        ))}
                      </SmartSelect>
                      {wrong && s.operationId && (
                        <span className="warn-text mt-1 block text-xs">{wrong}</span>
                      )}
                      {!s.operationId && s.name.trim() && (
                        <span className="text-muted-foreground mt-1 block text-xs">
                          Was “{s.name}” before steps named a process.
                        </span>
                      )}
                    </td>
                    <td className="px-1.5 py-1.5">
                      <input
                        className={cn(CELL, 'w-full')}
                        maxLength={200}
                        placeholder={op?.name ?? 'Step name'}
                        value={s.name}
                        onChange={(e) => setStep(s.key, (x) => ({ ...x, name: e.target.value }))}
                        aria-label={`Step ${i + 1} name`}
                      />
                    </td>
                    <td className="px-1.5 py-1.5">
                      {op ? (
                        // A process is done by its own department, as in Routing
                        // Masters: the route becomes a routing at handover.
                        <div
                          className={cn(
                            READOUT,
                            'justify-start',
                            !deptName(op.departmentId) && 'border-accent warn-text'
                          )}
                          title="A process is done by its own department, as in Routing Masters"
                          aria-label={`Step ${i + 1} department`}
                        >
                          <span className="truncate">
                            {deptName(op.departmentId) ?? 'No longer in use'}
                          </span>
                        </div>
                      ) : (
                        <SmartSelect
                          className={cn(CELL, 'w-full', deptGone && 'border-accent')}
                          value={s.departmentId}
                          aria-label={`Step ${i + 1} department`}
                          onChange={(e) =>
                            setStep(s.key, (x) => ({ ...x, departmentId: e.target.value }))
                          }
                        >
                          <option value="">The process’s own</option>
                          {deptGone && (
                            <option value={s.departmentId}>No longer in use: pick another</option>
                          )}
                          {lookups.departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </SmartSelect>
                      )}
                    </td>
                    <td className="px-1.5 py-1.5">
                      <SmartSelect
                        className={cn(CELL, 'w-full')}
                        value={s.execution}
                        disabled={isCut}
                        title={
                          isCut ? 'Cutting makes the pieces, so it is done on our floor' : undefined
                        }
                        aria-label={`Step ${i + 1} where it is done`}
                        onChange={(e) =>
                          setStep(s.key, (x) =>
                            stepDoneAt(x, e.target.value as EditStep['execution'])
                          )
                        }
                      >
                        <option value="IN_HOUSE">Our floor</option>
                        <option value="OUTSOURCED">Outside unit</option>
                      </SmartSelect>
                    </td>
                    <td className="px-1.5 py-1.5">
                      {outside ? (
                        <SmartSelect
                          className={cn(CELL, 'w-full', !s.vendorId && 'border-accent')}
                          value={s.vendorId ?? ''}
                          aria-label={`Step ${i + 1} outside unit`}
                          title="The supplier the pieces go to on a job-work challan"
                          onChange={(e) =>
                            setStep(s.key, (x) => ({ ...x, vendorId: e.target.value || null }))
                          }
                        >
                          <option value="">Pick the outside unit…</option>
                          {service.length > 0 && (
                            <optgroup label="Service suppliers">
                              {service.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {others.length > 0 && (
                            <optgroup label="Other suppliers">
                              {others.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </SmartSelect>
                      ) : (
                        <SmartSelect
                          className={cn(CELL, 'w-full')}
                          value={s.contractorId ?? ''}
                          aria-label={`Step ${i + 1} contractor`}
                          title="Who does this step; contractors are added under Routing Masters"
                          onChange={(e) =>
                            setStep(s.key, (x) => ({ ...x, contractorId: e.target.value || null }))
                          }
                        >
                          <option value="">
                            {!s.operationId
                              ? 'Pick the process first'
                              : takers.length
                                ? 'Any contractor'
                                : 'None take this process'}
                          </option>
                          {s.contractorId && !takers.some((c) => c.id === s.contractorId) && (
                            <option value={s.contractorId}>
                              Does not take this process: pick another
                            </option>
                          )}
                          {takers.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </SmartSelect>
                      )}
                    </td>
                    <td className="px-1.5 py-1.5">
                      <input
                        className={cn(CELL, 'w-full')}
                        maxLength={500}
                        placeholder={
                          isCut
                            ? 'Lay face up; check the shade before cutting'
                            : 'What the department must know'
                        }
                        value={s.instructions}
                        onChange={(e) =>
                          setStep(s.key, (x) => ({ ...x, instructions: e.target.value }))
                        }
                        aria-label={`Step ${i + 1} instructions`}
                      />
                    </td>
                    <td className="py-1.5 pl-1 pr-3">
                      <RowTools
                        index={i}
                        count={draft.route.length}
                        noun="step"
                        onMove={(dir) => update((d) => ({ ...d, route: moveRow(d.route, i, dir) }))}
                        onRemove={() => removeStep(s, i)}
                      />
                    </td>
                  </tr>
                )
              })}
              {!draft.route.length && (
                <tr>
                  <td colSpan={8} className="text-muted-foreground px-3 py-4 text-center text-sm">
                    No steps yet. Use the usual route, start from one of the style’s routings, or
                    add the steps one by one, starting with cutting.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {(rules.problems.length > 0 || rules.noCheck) && (
          <div className="mt-2 space-y-1">
            {rules.problems.map((p) => (
              <Warn key={p}>{p}</Warn>
            ))}
            {rules.noCheck && <Warn>{ROUTE_TEXT.noCheck}</Warn>}
          </div>
        )}
      </Section>
      <TabGaps gaps={gaps.filter((g) => !rules.problems.includes(g.message))} />
      {picking && (
        <RoutingPicker
          requestId={requestId}
          styleCode={styleCode}
          stepsNow={filled ? draft.route.length : 0}
          onClose={() => setPicking(false)}
          onPicked={(steps) => {
            setPicking(false)
            replaceRoute(steps)
          }}
        />
      )}
      {dialog}
    </div>
  )
}

const APPLIES: Record<RoutingChoice['applies'], (r: RoutingChoice) => string> = {
  STYLE: (r) => `For ${r.style?.code ?? 'this style'} only`,
  CATEGORY: (r) => `For ${r.category ?? 'one category of'} styles`,
  ANY: () => 'For any style',
}

/**
 * The style's routings, best fit first, as an order is offered them. Picking
 * one copies its steps, without rates, over this round's route; the window's
 * button says so before it does.
 */
function RoutingPicker({
  requestId,
  styleCode,
  stepsNow,
  onClose,
  onPicked,
}: {
  requestId: string
  styleCode: string | null
  /** Steps on the route now, which the routing's replace. */
  stepsNow: number
  onClose: () => void
  onPicked: (steps: SampleRouteStep[]) => void
}) {
  const [list, setList] = useState<RoutingChoice[] | null>(null)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState('')
  const [copying, setCopying] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setList(null)
    setError('')
    api
      .get<{ data: RoutingChoice[] }>(`/sampling/${requestId}/routings`)
      .then((r) => {
        if (!live) return
        setList(r.data)
        setChosen((c) => c || (r.data.find((x) => !x.problem)?.id ?? ''))
      })
      .catch((e) => live && setError(apiErrorMessage(e, 'Could not read the routings. Try again.')))
    return () => {
      live = false
    }
  }, [requestId, attempt])

  const copy = async () => {
    if (!chosen) return
    setCopying(true)
    setError('')
    try {
      const res = await api.get<{ data: SampleRouteStep[] }>(
        `/sampling/${requestId}/routings/${chosen}/steps`
      )
      onPicked(res.data)
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not read that routing’s steps. Try again.'))
      setCopying(false)
    }
  }
  const picked = list?.find((r) => r.id === chosen)

  return (
    <FormFrame
      icon={Route}
      title="Start from a routing"
      subtitle={
        styleCode
          ? `${styleCode}’s routings in Routing Masters, best fit first. The steps are copied without their rates; change them after.`
          : 'Routings are offered once the request has its style.'
      }
      width="max-w-2xl"
      busy={copying}
      error={error && list ? error : null}
      onClose={onClose}
      footerNote={
        picked && stepsNow
          ? `Replaces the ${plural(stepsNow, 'step')} on this round’s route.`
          : undefined
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={copying}>
          Cancel
        </button>
      }
      primary={
        <button
          type="button"
          className="btn-primary"
          disabled={!picked || copying}
          onClick={() => void copy()}
        >
          {copying && <Loader2 size={15} className="animate-spin" />}
          {picked && stepsNow
            ? `Replace the route with ${plural(picked.steps, 'step')}`
            : picked
              ? `Use its ${plural(picked.steps, 'step')}`
              : 'Use these steps'}
        </button>
      }
    >
      {list === null && !error && <LoadingRow label="Reading the routings…" />}
      {list === null && error && (
        <Notice kind="error">
          {error}{' '}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </Notice>
      )}
      {list && !list.length && (
        <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
          {styleCode
            ? `No routing in Routing Masters fits ${styleCode} yet. Use the usual route, or add the steps one by one.`
            : 'Set the request’s style in Request & tech pack first: routings are offered for its style.'}
        </p>
      )}
      {list && list.length > 0 && (
        <div role="radiogroup" aria-label="Routings" className="space-y-1.5">
          {list.map((r) => (
            <label
              key={r.id}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5',
                chosen === r.id ? 'border-primary/60 bg-primary/5' : 'border-border bg-card'
              )}
            >
              <input
                type="radio"
                name="sample-routing"
                className="accent-primary mt-1"
                checked={chosen === r.id}
                onChange={() => setChosen(r.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  <span className="font-mono">{r.code}</span> · {r.name}{' '}
                  <span className="text-muted-foreground font-normal">v{r.version}</span>
                </span>
                <span className="text-muted-foreground block text-xs">
                  {APPLIES[r.applies](r)} · {plural(r.steps, 'step')}
                </span>
                {r.problem && <span className="warn-text mt-0.5 block text-xs">{r.problem}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
    </FormFrame>
  )
}
