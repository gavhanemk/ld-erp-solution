'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  History,
  Printer,
  LockKeyhole,
  PackageOpen,
} from 'lucide-react'
import { api, ApiError, apiErrorMessage, can } from '@/lib/api'
import { formatDate, formatRupees } from '@/lib/utils'
import {
  SAMPLE_MATERIAL_SOURCE_LABEL,
  SAMPLE_CLOSEOUT_LABEL,
  SAMPLE_REASON_MIN,
  SAMPLE_STATE_LABEL,
  lineRequiredQty,
  type SampleCloseOutKind,
  type SampleItemOption,
  type SampleNeed,
} from '@ld-erp/shared'
import { FormFrame } from '@/components/ui/FormFrame'
import { StepInput } from '@/components/ui/StepInput'
import { Field, SampleSpecEditor } from './SampleSpecEditor'
import type { SampleRequest, Lookups, SampleMaterial, SampleRound } from './types'
import { SmartSelect } from '@/components/ui/SmartSelect'
import {
  colourGrid,
  colourSummary,
  developmentHandoverText,
  developmentStyleOf,
  eventLabel,
  eventNote,
  handoverBoms,
  isSampleSet,
  closeOutBlocker,
  coverOf,
  issueCap,
  leftovers,
  lineColour,
  lineItem,
  lineSourcing,
  makingBlocker,
  orderSummary,
  SOURCING_STATUS_LABEL,
  materialActions,
  materialHeld,
  measureMatrix,
  MATERIAL_KIND_LABEL,
  roundItems,
  sampleFlow,
  SET_TEXT,
  stageInput,
  stepFacts,
  storeNote,
  withRequestStyle,
  type MaterialKind,
  type SampleSection,
} from './samplingFlow'
import { limitDecimals, materialCost, MATERIAL_COST_LABEL, plural, rateFigure } from './specRules'
import { SampleRequestEditor } from './SampleRequestEditor'
import { SampleFiles } from './SampleFiles'
import { SampleStyleCard } from './SampleStyleCard'
import { PurchaseOrderDialog } from '@/components/purchase/PurchaseOrderDialog'
import Link from 'next/link'

const STALE_TEXT =
  'This request changed in another window. Your entries are still here, but have not been saved. Copy any details you need, then reopen the request to review the latest version.'

export function SampleWorkspace({
  initial,
  lookups: loaded,
  back,
  onItemsFound,
}: {
  initial: SampleRequest
  lookups: Lookups
  back: () => void
  /** Materials found or added from the sample BOM, for the page's lists to keep. */
  onItemsFound: (items: SampleItemOption[]) => void
}) {
  const [request, setRequest] = useState(initial),
    [selected, setSelected] = useState(initial.rounds[0].id),
    [tab, setTab] = useState<SampleSection>(() => sampleFlow(initial).section)
  const [dirty, setDirty] = useState(false)
  const [editingRequest, setEditingRequest] = useState(false)
  // Files being sent: the rest of the request waits, as it does for a save.
  const [filing, setFiling] = useState(false)
  // Bumped when the style changes, so the draft specification reopens as the
  // server refitted it rather than as it was on screen.
  const [specEpoch, setSpecEpoch] = useState(0)
  // The version every action is sent with. Read from here, not from the
  // request on screen: several files are filed one after another, each
  // moving the version on before the screen has drawn the last.
  const versionRef = useRef(initial.version)
  versionRef.current = Math.max(versionRef.current, request.version)
  const lookups = useMemo(() => withRequestStyle(loaded, request.style), [loaded, request.style])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    // What the server allowed but wants said, such as a route with no check.
    [warnings, setWarnings] = useState<string[]>([])
  // The material line whose issue, use or return window is open.
  const [recording, setRecording] = useState('')
  // The line being waived (or its waiver taken off), and the leftover being closed out.
  const [waiving, setWaiving] = useState('')
  const [closing, setClosing] = useState<{ itemId: string; warehouseId: string } | null>(null)
  // Sourcing: the lines ticked to order together, and the order being raised for them.
  const [buyTicks, setBuyTicks] = useState<Set<string>>(new Set())
  const [ordering, setOrdering] = useState<{
    needs: SampleNeed[]
    sampleStoreId: string | null
  } | null>(null)
  const [preparing, setPreparing] = useState(false)
  const round = request.rounds.find((x) => x.id === selected) ?? request.rounds[0],
    latest = request.rounds[0].id === round.id
  // The materials the round's lines name, offered by its editor with the page's list.
  const ownItems = useMemo(() => roundItems(round), [round])
  const edit = can('sampling', 'edit') && !request.cancelledAt,
    approve = can('sampling', 'approve') && !request.cancelledAt
  const flow = sampleFlow(request, round, lookups.sizes)
  // The round's style when it was made in sampling: nothing to hand over yet.
  const madeHere = developmentStyleOf(request, round)
  // The making steps for the side panel: released rows, or the draft's route.
  const makingSteps = round.stages.length
    ? round.stages.map((s) => ({ name: s.name, done: !!s.completedAt }))
    : round.specification.route.map((s) => ({ name: s.name, done: false }))
  const changeRound = (id: string) => {
    if (dirty && !window.confirm('Discard the unsaved specification changes?')) return
    setDirty(false)
    setSelected(id)
    setRecording('')
    setBuyTicks(new Set())
    setTab(
      sampleFlow(
        request,
        request.rounds.find((r) => r.id === id)!
      ).section
    )
    setError('')
    setMessage('')
    setWarnings([])
  }
  /**
   * One action on the request, with the latest version, and the warnings the
   * server sends with it. Throws a sentence a clerk can act on; the file
   * panel, the style windows and the material window show it where the
   * person is working, and `act` below shows it over the page.
   */
  const send = async (action: string, data: unknown, roundId = round.id) => {
    try {
      const res = await api.post<{ data: SampleRequest; warnings?: string[] }>(
        `/sampling/${request.id}/actions`,
        { version: versionRef.current, roundId, action, data }
      )
      versionRef.current = res.data.version
      setRequest(res.data)
      if (['CREATE_STYLE', 'LINK_STYLE', 'UPDATE_STYLE'].includes(action))
        setSpecEpoch((n) => n + 1)
      return { updated: res.data, warnings: res.warnings ?? [] }
    } catch (e) {
      const stale =
        (e instanceof ApiError && e.code === 'STALE_SAMPLE') ||
        (e instanceof Error && e.message.includes('another window'))
      throw new Error(stale ? STALE_TEXT : apiErrorMessage(e))
    }
  }
  const post = async (action: string, data: unknown, roundId = round.id) =>
    (await send(action, data, roundId)).updated
  const act = async (action: string, data: unknown, roundId = round.id) => {
    setBusy(true)
    setError('')
    setMessage('')
    setWarnings([])
    try {
      const { updated, warnings: said } = await send(action, data, roundId)
      setWarnings(said)
      if (['SAVE_DRAFT', 'SAVE_SPEC', 'RELEASE'].includes(action)) setDirty(false)
      if (action === 'NEW_ROUND') {
        setSelected(updated.rounds[0].id)
        setTab('Technical')
      }
      if (
        ['RELEASE', 'STAGE', 'QC', 'SUBMIT', 'DECIDE', 'HANDOVER', 'ACCEPT_HANDOVER'].includes(
          action
        )
      )
        setTab(sampleFlow(updated).section)
      setMessage(
        action === 'SAVE_DRAFT'
          ? 'Draft saved. You can leave this request and finish the specification later.'
          : action === 'UPDATE_REQUEST'
            ? 'Request details updated. The changes are recorded in activity history.'
            : action === 'RELEASE'
              ? 'Released for sampling. The next action is shown below.'
              : 'Saved. The next action is shown below.'
      )
      return updated
    } catch (e) {
      setError(e instanceof Error ? e.message : apiErrorMessage(e))
      return null
    } finally {
      setBusy(false)
    }
  }
  /** One material entry from its window: the window shows a refusal where it was typed. */
  const recordMaterial = async (
    m: SampleMaterial,
    d: { kind: MaterialKind; qty: number; reason: string; warehouseId?: string }
  ) => {
    setError('')
    setMessage('')
    setWarnings([])
    await post('MATERIAL', { ...d, materialId: m.id })
    setRecording('')
    setMessage(
      `${MATERIAL_KIND_LABEL[d.kind]}: ${d.qty} ${m.item?.uom?.symbol ?? ''} of ${m.item?.name ?? 'the material'} recorded. The next action is shown below.`
    )
  }
  const held = materialHeld
  /** The request as the server has it now: after an order is raised in Purchase, say. */
  const reload = async () => {
    const res = await api.get<{ data: SampleRequest }>(`/sampling/${request.id}`)
    versionRef.current = Math.max(versionRef.current, res.data.version)
    setRequest(res.data)
  }
  // Buying is open on the latest released round, to whoever may raise purchase orders.
  const canBuy =
    can('purchase', 'create') && latest && round.state === 'RELEASED' && !request.cancelledAt
  const toOrder = round.materials.filter(
    (m) => lineSourcing(m, coverOf(request, round, m)).status === 'TO_ORDER'
  )
  const ticked = toOrder.filter((m) => buyTicks.has(m.id))
  /**
   * Opens a purchase order for the ticked lines: their needs as Purchase reads
   * them (the item's GST from its HSN, what is still to buy), delivered to the
   * sample store.
   */
  const raiseOrder = async () => {
    setError('')
    setMessage('')
    setPreparing(true)
    try {
      const res = await api.get<{
        data: { needs: SampleNeed[]; sampleStores: Array<{ id: string; name: string }> }
      }>(`/sampling/needs?requestId=${request.id}`)
      const needs = res.data.needs.filter((n) => buyTicks.has(n.sampleMaterialId))
      if (!res.data.sampleStores.length)
        setError(
          'No store is set up as a sample store yet. Mark one in Masters → Warehouses, so what is bought for samples is kept apart from bulk stock.'
        )
      else if (!needs.length) {
        setError('Those lines are already on order in full. The list below is up to date now.')
        await reload()
      } else setOrdering({ needs, sampleStoreId: res.data.sampleStores[0].id })
    } catch (e) {
      setError(apiErrorMessage(e))
    } finally {
      setPreparing(false)
    }
  }
  const handedOver = request.rounds.some((r) => r.handover)
  // Use, waste and returns can be recorded on any round still holding material.
  // A sample store is Sampling's own: sampling rights issue from it (phase 4).
  const canRecord = edit
  // Leftovers are closed out after a cancellation too.
  const canClose = can('sampling', 'edit')
  const closeBlocked = closeOutBlocker(request)
  const left = leftovers(request)
  /** An item of the request, named as its lines name it. */
  const itemNamed = (itemId: string) => {
    for (const r of request.rounds)
      for (const m of r.materials) if (m.itemId === itemId && m.item) return m.item
    return null
  }
  const storeNamed = (id: string) => lookups.warehouses.find((w) => w.id === id)?.name ?? 'The sample store'
  const waivingLine = waiving ? round.materials.find((m) => m.id === waiving) : undefined
  const recordingLine = recording ? round.materials.find((m) => m.id === recording) : undefined
  const showValue = round.materials.some((m) => m.issuedValue !== undefined)
  const sizeRunName = (id: string) => lookups.sizeGroups.find((g) => g.id === id)?.name ?? id
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button
            className="btn-ghost"
            disabled={busy || filing}
            onClick={() => {
              if (!dirty || window.confirm('Discard the unsaved specification changes?')) back()
            }}
          >
            <ArrowLeft size={15} /> Requests
          </button>
          <h1 className="page-title">
            {request.number} · {request.title}
          </h1>
          <p className="page-subtitle">
            {request.customer?.name ?? 'Internal development'} · {request.brand.name} ·{' '}
            {request.owner}
            {request.requiredAt ? ` · Due ${formatDate(request.requiredAt)}` : ''}
          </p>
        </div>
        <a
          className="btn-secondary print:hidden"
          href={`/print/sample/${request.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Printer size={15} /> Print record
        </a>
      </div>
      <div className="glass-card space-y-2 p-4">
        <p className="text-muted-foreground text-xs">Sample milestone & revision</p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="badge-info">
            {request.cancelledAt ? 'Cancelled' : SAMPLE_STATE_LABEL[round.state]}
          </span>
          <SmartSelect
            className="form-input w-auto"
            value={selected}
            disabled={busy || filing}
            onChange={(e) => changeRound(e.target.value)}
            aria-label="Sample round"
          >
            {request.rounds.map((r) => (
              <option key={r.id} value={r.id} data-sub={colourSummary(r.specification)}>
                Round {r.revision} · {r.specification.milestone} · {SAMPLE_STATE_LABEL[r.state]}
              </option>
            ))}
          </SmartSelect>
          {!latest && (
            <span className="text-muted-foreground text-sm">
              Historical round — specification and decisions are preserved.
            </span>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="warn-text">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-primary">
          {message}
        </p>
      )}
      {warnings.map((w) => (
        <p key={w} role="status" className="warn-text">
          {w}
        </p>
      ))}
      <div className="grid items-start gap-5 xl:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="glass-card p-3 xl:sticky xl:top-4">
          <p className="text-muted-foreground px-3 pt-2 text-xs font-semibold uppercase tracking-wider">
            Round {round.revision} workflow
          </p>
          <p className="px-3 pt-2 text-sm font-medium">{round.specification.milestone}</p>
          <p className="text-muted-foreground px-3 pb-2 text-xs">
            {colourSummary(round.specification)}
          </p>
          <nav aria-label="Sampling stages" className="grid gap-1 sm:grid-cols-2 xl:grid-cols-1">
            {flow.steps.map((step, i) => (
              <button
                key={step.key}
                disabled={busy || filing}
                aria-current={tab === step.key ? 'step' : undefined}
                onClick={() => setTab(step.key)}
                className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${tab === step.key ? 'border-primary/40 bg-primary/10' : 'hover:bg-muted/60 border-transparent'}`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.status === 'Complete' ? 'bg-primary/15 text-primary' : tab === step.key ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
                >
                  {step.status === 'Complete' ? <Check size={13} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{step.title}</span>
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    {!latest && (step.status === 'Current' || step.status === 'Waiting')
                      ? 'Previous round'
                      : step.status}
                    {step.key === 'Making'
                      ? ` · ${makingSteps.filter((s) => s.done).length}/${makingSteps.length} steps`
                      : ''}
                  </span>
                  {step.key === 'Making' && (
                    <span className="border-border mt-2 block space-y-1 border-l pl-2">
                      {makingSteps.map((stage, j) => (
                        <span
                          key={j}
                          className="text-muted-foreground flex items-center gap-1.5 text-xs"
                        >
                          {stage.done ? (
                            <Check size={11} className="text-primary" />
                          ) : (
                            <span className="h-1 w-1 rounded-full bg-current" />
                          )}
                          {stage.name || 'New operation'}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </nav>
          <button
            disabled={busy || filing}
            className={`border-border mt-3 flex w-full items-center gap-2 border-t px-3 pt-3 text-sm ${tab === 'History' ? 'text-primary' : 'text-muted-foreground'}`}
            onClick={() => setTab('History')}
          >
            <History size={16} /> Activity & request actions
          </button>
        </aside>
        <div className="min-w-0 space-y-4">
          <div className="border-primary/25 bg-primary/5 rounded-xl border p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-2xl">
                <p className="text-primary mb-1 text-xs font-semibold uppercase tracking-wider">
                  {!latest
                    ? 'Historical round'
                    : request.cancelledAt
                      ? 'Closed request'
                      : round.handover?.acceptedAt
                        ? 'Completed'
                        : 'Next action'}
                </p>
                <h2 className="text-lg font-semibold">
                  {!latest ? `Review round ${round.revision}` : flow.title}
                </h2>
                <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                  {!latest
                    ? 'Specifications and decisions are preserved. Any material still held can be reconciled in Material preparation.'
                    : flow.description}
                </p>
              </div>
              {latest &&
                !request.cancelledAt &&
                (tab !== flow.section || selected !== flow.targetRoundId) && (
                  <button
                    className="btn-primary"
                    disabled={busy || filing}
                    onClick={() => {
                      if (selected !== flow.targetRoundId) changeRound(flow.targetRoundId)
                      setTab(flow.section)
                    }}
                  >
                    Continue <ArrowRight size={15} />
                  </button>
                )}
            </div>
          </div>
          <div>
            <h2 className="text-lg font-semibold">
              {flow.steps.find((s) => s.key === tab)?.title ?? 'Activity & request actions'}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {flow.steps.find((s) => s.key === tab)?.description}
            </p>
          </div>
          <fieldset disabled={busy || filing} className="min-w-0">
            {tab === 'Brief' && (
              <div className="glass-card space-y-4 p-5">
                {edit && !handedOver && (
                  <div>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={dirty}
                      onClick={() => {
                        setError('')
                        setEditingRequest(true)
                      }}
                    >
                      Edit request details
                    </button>
                    {dirty && (
                      <p className="text-muted-foreground mt-2 text-xs">
                        Save your technical draft before editing request details.
                      </p>
                    )}
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {[
                    ['Buyer', request.customer?.name ?? 'Internal development'],
                    ['Brand', request.brand.name],
                    ['Sampling owner', request.owner],
                    [
                      'Required by',
                      request.requiredAt ? formatDate(request.requiredAt) : 'Not set',
                    ],
                    ['Buyer reference', request.buyerRef || 'Not provided'],
                    ['Buyer style reference', request.buyerStyleRef || 'Not provided'],
                    ['Season', request.season || 'Not set'],
                    ['Garment category', request.garmentCategory || 'Not set'],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p className="text-muted-foreground text-xs">{label}</p>
                      <p className="mt-1 font-medium">{value}</p>
                    </div>
                  ))}
                </div>
                <div className="border-border border-t pt-4">
                  <h3 className="mb-2 text-sm font-semibold">Requirements & design references</h3>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{request.brief}</p>
                </div>
              </div>
            )}
            {tab === 'Brief' && (
              <div className="mt-4 space-y-4">
                <SampleFiles
                  request={request}
                  canEdit={can('sampling', 'edit')}
                  closedReason={
                    request.cancelledAt
                      ? 'This request is cancelled; its files are kept with it.'
                      : handedOver
                        ? 'This request has a production handover; its files are kept with it.'
                        : ''
                  }
                  post={(action, data) => post(action, data)}
                  onBusyChange={setFiling}
                />
                <SampleStyleCard
                  request={request}
                  lookups={lookups}
                  canEdit={edit && !handedOver}
                  held={
                    dirty
                      ? 'Save the technical draft first: changing the style refits the draft specification.'
                      : ''
                  }
                  post={(action, data) => post(action, data)}
                  notify={(text) => {
                    setError('')
                    setWarnings([])
                    setMessage(text)
                  }}
                />
              </div>
            )}
            <div hidden={tab !== 'Technical'}>
              {round.state === 'DRAFT' && edit && latest ? (
                <div className="space-y-4">
                  <SampleSpecEditor
                    key={`${round.id}-${specEpoch}`}
                    initial={round.specification}
                    lookups={lookups}
                    requestStyle={request.style}
                    onChooseStyle={() => setTab('Brief')}
                    requestId={request.id}
                    hasBuyer={!!request.customerId}
                    roundItems={ownItems}
                    onItemsFound={onItemsFound}
                    busy={busy}
                    onDirtyChange={setDirty}
                    save={async (s) => {
                      const updated = await act('SAVE_DRAFT', s)
                      return updated?.rounds.find((r) => r.id === round.id)?.specification ?? null
                    }}
                    release={approve ? (s) => void act('RELEASE', s) : undefined}
                  />
                </div>
              ) : (
                <SpecView round={round} lookups={lookups} />
              )}
            </div>
            {tab === 'Sourcing' && (
              <div className="space-y-3">
                <p className="text-muted-foreground text-sm">
                  Material we buy for this sample is ordered on purchase orders that name this
                  request, delivered to the sample store, and received there against the order. What
                  is on order and received is read off those orders. Material the buyer sends comes
                  in on a customer goods receipt instead.
                </p>
                {round.state === 'DRAFT' ? (
                  <div className="glass-card flex items-start gap-3 p-5 text-sm">
                    <PackageOpen size={18} className="text-muted-foreground shrink-0" />
                    Material is bought once the specification is released. Finish the materials in
                    the specification first.
                  </div>
                ) : round.materials.length === 0 ? (
                  <div className="glass-card flex items-start gap-3 p-5 text-sm">
                    <PackageOpen size={18} className="text-muted-foreground shrink-0" />
                    This round has no material lines.
                  </div>
                ) : (
                  <div className="glass-card overflow-x-auto">
                    <table className="data-table w-full">
                      <caption className="px-4 py-2 text-left text-sm font-semibold">
                        What the sample needs · {plural(round.materials.length, 'line')}
                      </caption>
                      <thead>
                        <tr>
                          {canBuy && (
                            <th className="w-10">
                              <span className="sr-only">Order</span>
                            </th>
                          )}
                          <th>Part</th>
                          <th>Material</th>
                          <th>Colour</th>
                          <th className="text-right">Required</th>
                          <th className="text-right">Ordered</th>
                          <th className="text-right">Received</th>
                          <th className="text-right">To buy</th>
                          <th>Where it stands</th>
                          <th>Orders</th>
                        </tr>
                      </thead>
                      <tbody>
                        {round.materials.map((m, i) => {
                          const s = lineSourcing(m, coverOf(request, round, m))
                          const unit = m.item?.uom?.symbol ?? ''
                          const orderable = canBuy && s.status === 'TO_ORDER'
                          return (
                            <tr key={m.id} data-row tabIndex={i === 0 ? 0 : -1}>
                              {canBuy && (
                                <td>
                                  {orderable && (
                                    <input
                                      type="checkbox"
                                      data-row-open
                                      checked={buyTicks.has(m.id)}
                                      onChange={() =>
                                        setBuyTicks((prev) => {
                                          const next = new Set(prev)
                                          if (next.has(m.id)) next.delete(m.id)
                                          else next.add(m.id)
                                          return next
                                        })
                                      }
                                      aria-label={`Order ${m.item?.name ?? 'this material'}`}
                                    />
                                  )}
                                </td>
                              )}
                              <td>{m.component || '—'}</td>
                              <td className="min-w-[10rem]">
                                {m.item ? (
                                  <>
                                    {m.item.name}
                                    <span className="text-muted-foreground block font-mono text-xs">
                                      {m.item.code}
                                    </span>
                                  </>
                                ) : (
                                  <span className="warn-text">No material picked</span>
                                )}
                              </td>
                              <td>{lineColour(m.colour)}</td>
                              <td className="whitespace-nowrap text-right tabular-nums">
                                {s.required}{' '}
                                <span className="text-muted-foreground text-xs">{unit}</span>
                              </td>
                              <td className="text-right tabular-nums">
                                {s.status === 'BUYER' ? '—' : s.ordered}
                              </td>
                              <td className="text-right tabular-nums">
                                {s.status === 'BUYER' ? '—' : s.received}
                              </td>
                              <td className="text-right font-semibold tabular-nums">
                                {s.status === 'BUYER' || s.status === 'ISSUED' || s.status === 'WAIVED'
                                  ? '—'
                                  : s.toBuy}
                              </td>
                              <td>
                                <span
                                  className={
                                    s.status === 'TO_ORDER'
                                      ? 'badge-warning'
                                      : s.status === 'RECEIVED' || s.status === 'ISSUED'
                                        ? 'badge-success'
                                        : s.status === 'WAIVED'
                                          ? 'badge-neutral'
                                          : 'badge-info'
                                  }
                                >
                                  {SOURCING_STATUS_LABEL[s.status]}
                                </span>
                                {s.status === 'BUYER' && (
                                  <Link
                                    href="/inventory/customer-material"
                                    className="text-primary mt-1 block text-xs hover:underline"
                                  >
                                    Receive it from the buyer
                                  </Link>
                                )}
                              </td>
                              <td className="min-w-[14rem] text-xs">
                                {(m.orders ?? []).length ? (
                                  <ul className="space-y-0.5">
                                    {(m.orders ?? []).map((o) => (
                                      <li key={o.id}>
                                        <Link
                                          href={`/purchase/orders?q=${encodeURIComponent(o.poNumber)}`}
                                          className="text-primary hover:underline"
                                        >
                                          {orderSummary(o, unit)}
                                        </Link>
                                        {o.deliveryDate &&
                                          !o.shortClosed &&
                                          !o.cancelled &&
                                          +o.receivedQty < +o.qty && (
                                            <span className="text-muted-foreground">
                                              {' '}
                                              · due {formatDate(String(o.deliveryDate))}
                                            </span>
                                          )}
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <span className="text-muted-foreground">None yet</span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {canBuy && toOrder.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={!ticked.length || preparing}
                      onClick={() => void raiseOrder()}
                    >
                      {preparing
                        ? 'Opening…'
                        : `Raise purchase order${ticked.length ? ` for ${plural(ticked.length, 'line')}` : ''}`}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() =>
                        setBuyTicks(
                          ticked.length === toOrder.length
                            ? new Set()
                            : new Set(toOrder.map((m) => m.id))
                        )
                      }
                    >
                      {ticked.length === toOrder.length
                        ? 'Clear the ticks'
                        : 'Tick every line to order'}
                    </button>
                    <p className="text-muted-foreground text-xs">
                      Tick the lines one supplier sends, then raise their order. The rest stay here
                      until they are ordered.
                    </p>
                  </div>
                )}
                {!canBuy && toOrder.length > 0 && latest && !request.cancelledAt && (
                  <p className="text-muted-foreground text-sm">
                    {plural(toOrder.length, 'line')} still to order. Raising a purchase order needs
                    purchase rights; the purchase team can pick these under Select from sample needs
                    on the order form.
                  </p>
                )}
              </div>
            )}
            {tab === 'Materials' && (
              <div className="space-y-3">
                <p className="text-muted-foreground text-sm">
                  A sample’s material is issued from the sample store, up to what this request
                  bought and received there (what an earlier round left counts too). Each line
                  is issued from one store, picked at its first issue. Record use or waste
                  against that issue; it does not deduct stock again. Return unused material to
                  the store it came from. A line not needed after all can be waived before making
                  starts.
                </p>
                {round.materials.length === 0 ? (
                  <div className="glass-card flex items-start gap-3 p-5 text-sm">
                    <PackageOpen size={18} className="text-muted-foreground shrink-0" />
                    {round.state === 'DRAFT'
                      ? 'No material lines yet. Add them under Materials in the specification and save the draft; they are issued once the round is released.'
                      : 'This round has no material lines.'}
                  </div>
                ) : (
                  <div className="glass-card overflow-x-auto">
                    <table className="data-table w-full">
                      <caption className="px-4 py-2 text-left text-sm font-semibold">
                        Sample BOM · {plural(round.materials.length, 'line')}
                        {round.state === 'DRAFT' && (
                          <span className="text-muted-foreground ml-2 text-xs font-normal">
                            Issued once the round is released
                          </span>
                        )}
                      </caption>
                      <thead>
                        <tr>
                          <th>Part</th>
                          <th>Material</th>
                          <th>Colour</th>
                          <th>Source</th>
                          <th className="text-right">Required</th>
                          <th className="text-right">Issued</th>
                          <th className="text-right">Used</th>
                          <th className="text-right">Waste</th>
                          <th className="text-right">Returned</th>
                          <th className="text-right">Held</th>
                          <th>Store</th>
                          {showValue && <th className="text-right">Net value</th>}
                          {canRecord && (
                            <th>
                              <span className="sr-only">Record</span>
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {round.materials.map((m, i) => {
                          const allowed = materialActions(round, m)
                          return (
                            // A list row of the ERP: ↑/↓ move between lines, Enter issues.
                            <tr key={m.id} data-row tabIndex={i === 0 ? 0 : -1}>
                              <td>{m.component || '—'}</td>
                              <td className="min-w-[10rem]">
                                {m.item ? (
                                  <>
                                    {m.item.name}
                                    <span className="text-muted-foreground block font-mono text-xs">
                                      {m.item.code}
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <span className="warn-text">No material picked</span>
                                    <span className="text-muted-foreground block text-xs">
                                      Nothing can be issued against this line.
                                    </span>
                                  </>
                                )}
                                {m.waivedAt && (
                                  <span className="mt-1 block text-xs">
                                    <span className="badge-neutral">Not needed</span>{' '}
                                    <span className="text-muted-foreground">
                                      {m.waivedReason}
                                      {m.waivedBy ? ` · ${m.waivedBy}` : ''}
                                    </span>
                                  </span>
                                )}
                              </td>
                              <td>{lineColour(m.colour)}</td>
                              <td>
                                <span
                                  className={
                                    m.source === 'BUYER_SUPPLIED' ? 'badge-info' : 'badge-neutral'
                                  }
                                >
                                  {SAMPLE_MATERIAL_SOURCE_LABEL[m.source] ?? m.source}
                                </span>
                              </td>
                              <td className="whitespace-nowrap text-right tabular-nums">
                                {+m.plannedQty}{' '}
                                <span className="text-muted-foreground text-xs">
                                  {m.item?.uom?.symbol}
                                </span>
                              </td>
                              <td className="text-right tabular-nums">{+m.issuedQty}</td>
                              <td className="text-right tabular-nums">{+m.usedQty}</td>
                              <td className="text-right tabular-nums">{+m.wasteQty}</td>
                              <td className="text-right tabular-nums">{+m.returnedQty}</td>
                              <td className="text-right font-semibold tabular-nums">{held(m)}</td>
                              <td>
                                {m.warehouse?.name ?? (
                                  <span className="text-muted-foreground text-xs">
                                    Picked at the first issue
                                  </span>
                                )}
                              </td>
                              {showValue && (
                                <td className="text-right tabular-nums">
                                  {m.issuedValue !== undefined
                                    ? formatRupees(+m.issuedValue - +(m.returnedValue ?? 0))
                                    : '—'}
                                </td>
                              )}
                              {canRecord && (
                                <td>
                                  <span className="flex flex-wrap items-center gap-2">
                                    {allowed.kinds.length ? (
                                      <button
                                        type="button"
                                        className="btn-secondary whitespace-nowrap"
                                        data-row-open
                                        onClick={() => {
                                          setError('')
                                          setRecording(m.id)
                                        }}
                                      >
                                        {allowed.kinds[0] === 'ISSUE'
                                          ? 'Issue'
                                          : 'Record use or return'}
                                      </button>
                                    ) : (
                                      <span className="text-muted-foreground block max-w-xs text-xs">
                                        {allowed.why}
                                      </span>
                                    )}
                                    {latest && (allowed.waive || allowed.unwaive) && (
                                      <button
                                        type="button"
                                        className="btn-ghost whitespace-nowrap text-xs"
                                        // The row's own action when it has nothing else to record.
                                        data-row-open={allowed.kinds.length ? undefined : true}
                                        onClick={() => {
                                          setError('')
                                          setWaiving(m.id)
                                        }}
                                      >
                                        {allowed.unwaive ? 'Needed after all' : 'Not needed'}
                                      </button>
                                    )}
                                  </span>
                                </td>
                              )}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {showValue && (
                  <p className="text-muted-foreground text-sm">
                    Net material value:{' '}
                    {formatRupees(
                      round.materials.reduce(
                        (t, m) => t + +(m.issuedValue ?? 0) - +(m.returnedValue ?? 0),
                        0
                      )
                    )}{' '}
                    · excludes labour, services and courier
                  </p>
                )}
                {(left.length > 0 || (request.closeOuts ?? []).length > 0) && (
                  <div className="glass-card space-y-3 p-4">
                    <h3 className="font-semibold">
                      {closeBlocked
                        ? 'In the sample store for this request'
                        : 'Left in the sample store for this request'}
                    </h3>
                    {left.length ? (
                      <>
                        <p className="text-muted-foreground text-sm">
                          {closeBlocked
                            ? 'Bought and received for this request, not yet issued. It is kept for this round and the next; once the buyer has decided, what is left can be closed out.'
                            : 'Close out what nobody needs any more: used in the sample, or moved to a general store at what it is carried at.'}
                        </p>
                        <div className="overflow-x-auto">
                        <table className="data-table w-full">
                          <thead>
                            <tr>
                              <th>Material</th>
                              <th>Sample store</th>
                              <th className="text-right">Received for it</th>
                              <th className="text-right">Issued or closed out</th>
                              <th className="text-right">Left</th>
                              {canClose && !closeBlocked && (
                                <th>
                                  <span className="sr-only">Close out</span>
                                </th>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {left.map((s, i) => {
                              const it = itemNamed(s.itemId)
                              return (
                                <tr
                                  key={`${s.itemId}-${s.warehouseId}`}
                                  data-row
                                  tabIndex={i === 0 ? 0 : -1}
                                >
                                  <td>
                                    {it?.name ?? 'Material'}
                                    <span className="text-muted-foreground block font-mono text-xs">
                                      {it?.code}
                                    </span>
                                  </td>
                                  <td>{storeNamed(s.warehouseId)}</td>
                                  <td className="text-right tabular-nums">{s.received}</td>
                                  <td className="text-right tabular-nums">{s.issued + s.closed}</td>
                                  <td className="text-right font-semibold tabular-nums">
                                    {s.available}{' '}
                                    <span className="text-muted-foreground text-xs">
                                      {it?.uom?.symbol}
                                    </span>
                                  </td>
                                  {canClose && !closeBlocked && (
                                    <td>
                                      <button
                                        type="button"
                                        className="btn-secondary whitespace-nowrap"
                                        data-row-open
                                        onClick={() => {
                                          setError('')
                                          setClosing({ itemId: s.itemId, warehouseId: s.warehouseId })
                                        }}
                                      >
                                        Close out
                                      </button>
                                    </td>
                                  )}
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                        </div>
                      </>
                    ) : (
                      <p className="text-muted-foreground text-sm">Nothing is left.</p>
                    )}
                    {(request.closeOuts ?? []).length > 0 && (
                      <ul className="text-muted-foreground space-y-1 text-xs">
                        {request.closeOuts!.map((c) => (
                          <li key={c.id}>
                            {formatDate(c.createdAt)} · {+c.qty} {c.item.uom?.symbol ?? ''} of{' '}
                            {c.item.name} from {c.warehouse.name}:{' '}
                            {c.kind === 'MOVED'
                              ? `moved to ${c.toWarehouse?.name ?? 'a general store'}`
                              : 'used in the sample'}
                            {c.value !== undefined ? ` · ${formatRupees(+c.value)}` : ''} ·{' '}
                            {c.reason} · {c.createdBy.name}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
            {tab === 'Making' && (
              <div className="space-y-4">
                {round.stages.length === 0 && (
                  <p>Release the specification to prepare its making route.</p>
                )}
                {round.stages.length > 0 && isSampleSet(round.specification) && (
                  <p className="bg-muted/40 rounded-lg p-3 text-sm">
                    <span className="font-medium">{colourSummary(round.specification)}.</span>{' '}
                    {SET_TEXT.stage}
                  </p>
                )}
                {round.stages.map((s, i) => {
                  const f = stepFacts(s, lookups)
                  return (
                    <div key={s.id} className="glass-card space-y-3 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="font-semibold">
                          {s.sequence}. {s.name}
                        </h2>
                        {f.process && (
                          <span className={f.outside ? 'badge-purple' : 'badge-neutral'}>
                            {f.doneAt}
                          </span>
                        )}
                      </div>
                      {f.process ? (
                        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          <Fact label="Process" value={f.process} />
                          <Fact label="Department" value={f.department || 'Not set'} />
                          <Fact label={f.outside ? 'Outside unit' : 'Contractor'} value={f.who} />
                          {f.instructions && (
                            <Fact label="Instructions" value={f.instructions} wide />
                          )}
                        </dl>
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          Released before routes named a process: the step’s name is its record.
                        </p>
                      )}
                      {s.completedAt ? (
                        <p>
                          Done {s.doneQty} · Rejected {s.rejectedQty} · {s.responsible} ·{' '}
                          {formatDate(s.completedAt)}
                          <br />
                          {s.notes}
                        </p>
                      ) : edit &&
                        latest &&
                        round.state === 'RELEASED' &&
                        !makingBlocker(round, i) ? (
                        <StageAction
                          key={`${s.id}-${request.version}`}
                          name={s.name}
                          input={stageInput(round, i)}
                          set={isSampleSet(round.specification)}
                          outside={f.outside}
                          save={(d) =>
                            void act('STAGE', { ...(d as Record<string, unknown>), stageId: s.id })
                          }
                        />
                      ) : (
                        <p className="text-muted-foreground flex items-center gap-2 text-sm">
                          <Clock3 size={15} />{' '}
                          {makingBlocker(round, i) ||
                            'Awaiting completion by the sampling operator.'}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {tab === 'Quality' && (
              <div className="space-y-4">
                {!round.stages.length || round.stages.some((s) => !s.completedAt) ? (
                  <div className="glass-card flex items-start gap-3 p-5">
                    <LockKeyhole size={18} className="text-muted-foreground shrink-0" />
                    <p className="text-sm">
                      Complete all making steps before recording QC. Measurement targets are taken
                      from this round's released specification.
                    </p>
                  </div>
                ) : null}
                {round.qc && (
                  <div className="glass-card space-y-2 p-4">
                    <h2 className="font-semibold">
                      QC: {round.qc.passed ? 'Passed' : 'Corrections required'}
                    </h2>
                    {round.qc.results.map((x, i) => (
                      <p key={i}>
                        {lookups.sizes.find((s) => s.id === x.sizeId)?.code} · {x.name}: {x.actual}{' '}
                        {x.unit} · target {x.target} ·{' '}
                        {x.pass ? 'Within tolerance' : 'Outside tolerance'}
                      </p>
                    ))}
                    <p>{round.qc.notes}</p>
                  </div>
                )}
                {approve &&
                  latest &&
                  round.state === 'RELEASED' &&
                  round.stages.length > 0 &&
                  round.stages.every((x) => x.completedAt) && (
                    <QcAction
                      key={`${round.id}-${request.version}`}
                      round={round}
                      lookups={lookups}
                      save={(d) => void act('QC', d)}
                    />
                  )}
                {edit && latest && round.qc?.passed === false && (
                  <ReasonAction
                    label="Start a correction round"
                    save={(reason) => void act('NEW_ROUND', reason)}
                  />
                )}
              </div>
            )}
            {tab === 'Buyer review' && (
              <div className="space-y-4">
                <p className="text-muted-foreground text-sm">
                  Buyer approval covers this round’s style, colours, sizes and specification.
                  Approval with unresolved conditions stays Changes required. Handover prepares a
                  planning reference; it does not create or release a bulk order.
                </p>
                {round.submission && (
                  <div className="glass-card p-4">
                    <h2 className="font-semibold">Submission</h2>
                    <p>
                      {round.submission.qty} pieces to {round.submission.recipient} ·{' '}
                      {round.submission.reference}
                    </p>
                    <p>{round.submission.notes}</p>
                  </div>
                )}
                {round.decision && (
                  <div className="glass-card p-4">
                    <h2 className="font-semibold">
                      Buyer decision · {SAMPLE_STATE_LABEL[round.decision.result]}
                    </h2>
                    <p>
                      {round.decision.buyerName}: {round.decision.evidence}
                    </p>
                    <p>{round.decision.conditions}</p>
                  </div>
                )}
                {edit && latest && round.state === 'QC_PASSED' && (
                  <SubmissionAction
                    available={round.qc?.passedQty ?? 0}
                    set={isSampleSet(round.specification)}
                    save={(d) => void act('SUBMIT', d)}
                  />
                )}
                {approve && latest && round.state === 'SUBMITTED' && (
                  <DecisionAction save={(d) => void act('DECIDE', d)} />
                )}
                {edit &&
                  latest &&
                  (['APPROVED', 'CHANGES_REQUIRED', 'REJECTED'].includes(round.state) ||
                    round.qc?.passed === false) &&
                  !round.handover && (
                    <ReasonAction
                      label="New revision / next milestone"
                      save={(reason) => void act('NEW_ROUND', reason)}
                    />
                  )}
                {!round.qc?.passed && !round.decision && (
                  <div className="glass-card flex gap-3 p-5 text-sm">
                    <LockKeyhole size={18} className="shrink-0" /> Pass internal QC to unlock buyer
                    submission.
                  </div>
                )}
              </div>
            )}
            {tab === 'Handover' && (
              <div className="space-y-4">
                {round.state !== 'APPROVED' && (
                  <div className="glass-card flex gap-3 p-5 text-sm">
                    <LockKeyhole size={18} className="shrink-0" /> Unconditional buyer approval is
                    required before preparing the production package.
                  </div>
                )}
                {round.state === 'APPROVED' &&
                  !round.handover &&
                  request.rounds.some((r) => r.materials.some((m) => held(m) > 0)) && (
                    <div className="glass-card p-5 text-sm">
                      Material remains held on a sampling round. Record its use, waste or return in
                      Material preparation to unlock handover.
                    </div>
                  )}
                {approve &&
                  latest &&
                  round.state === 'APPROVED' &&
                  !round.handover &&
                  request.rounds.every((r) => r.materials.every((m) => held(m) === 0)) &&
                  (madeHere ? (
                    // No BOM or route can be made for a style still in
                    // sampling, so empty pickers would only send people round.
                    <div className="glass-card flex gap-3 p-5 text-sm">
                      <LockKeyhole size={18} className="shrink-0" />
                      {developmentHandoverText(madeHere.code)}
                    </div>
                  ) : (
                    <HandoverAction
                      round={round}
                      lookups={lookups}
                      save={(d) => void act('HANDOVER', d)}
                    />
                  ))}
                {round.handover && (
                  <div className="glass-card space-y-3 p-4">
                    <h2 className="font-semibold">Bulk handover</h2>
                    <p>
                      BOM {round.handover.bomVersion} · Routing version{' '}
                      {round.handover.routingVersion}
                    </p>
                    <p>{round.handover.notes}</p>
                    <p>Prepared by {round.handover.preparedBy}</p>
                    {round.handover.acceptedAt ? (
                      <p>
                        Accepted by {round.handover.acceptedBy} ·{' '}
                        {formatDate(round.handover.acceptedAt)}
                      </p>
                    ) : (
                      edit &&
                      latest &&
                      can('production', 'approve') && (
                        <button
                          className="btn-primary"
                          onClick={() => void act('ACCEPT_HANDOVER', {})}
                        >
                          Accept into production planning
                        </button>
                      )
                    )}
                  </div>
                )}
              </div>
            )}
            {tab === 'History' && (
              <div className="space-y-3">
                <p className="text-muted-foreground">
                  Every saved action is retained. Closed rounds cannot be rewritten.
                </p>
                {request.events.map((e) => (
                  <div key={e.id} className="glass-card p-3">
                    <p>
                      {eventLabel(e.action, e.detail.data)} · {e.detail.by ?? 'User'} · {formatDate(e.createdAt)}
                    </p>
                    <EventNoteLine text={eventNote(e, request.rounds, sizeRunName)} />
                    {e.action === 'UPDATE_REQUEST' && (
                      <div className="mt-2 space-y-2 text-sm">
                        <p>{e.detail.data?.reason}</p>
                        {Object.entries(e.detail.data?.after ?? {})
                          .filter(
                            ([key, value]) =>
                              (value || null) !== (e.detail.data?.before?.[key] || null)
                          )
                          .map(([key, value]) => (
                            <p key={key} className="text-muted-foreground">
                              <span className="font-medium">
                                {(
                                  {
                                    title: 'Title',
                                    customerId: 'Buyer',
                                    brandId: 'Brand',
                                    buyerRef: 'Buyer reference',
                                    owner: 'Owner',
                                    brief: 'Brief',
                                    requiredAt: 'Required by',
                                    buyerStyleRef: 'Buyer style reference',
                                    season: 'Season',
                                    garmentCategory: 'Garment category',
                                  } as Record<string, string>
                                )[key] ?? key}
                                :
                              </span>{' '}
                              {requestChangeValue(key, e.detail.data?.before?.[key], lookups)} →{' '}
                              {requestChangeValue(key, value, lookups)}
                            </p>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
                {approve && !request.cancelledAt && !request.rounds.some((r) => r.handover) && (
                  <ReasonAction
                    label="Cancel request"
                    save={(reason) => void act('CANCEL', reason)}
                  />
                )}{' '}
                {request.cancelledAt && <p>Cancelled: {request.cancelReason}</p>}
              </div>
            )}
          </fieldset>
        </div>
      </div>
      {editingRequest && (
        <SampleRequestEditor
          request={request}
          lookups={lookups}
          busy={busy}
          error={error}
          close={() => setEditingRequest(false)}
          save={(data) => act('UPDATE_REQUEST', data)}
        />
      )}
      {waivingLine && (
        <WaiveWindow
          line={waivingLine}
          onClose={() => setWaiving('')}
          save={async (reason) => {
            const undo = !!waivingLine.waivedAt
            await post('WAIVE_MATERIAL', { materialId: waivingLine.id, reason, undo })
            setWaiving('')
            setMessage(
              undo
                ? `${waivingLine.item?.name ?? 'The material'} is needed again: issue it before making starts.`
                : `${waivingLine.item?.name ?? 'The material'} is marked not needed: making does not wait for it.`
            )
          }}
        />
      )}
      {closing && (
        <CloseOutWindow
          key={`${closing.itemId}-${closing.warehouseId}-${request.version}`}
          item={itemNamed(closing.itemId)}
          storeName={storeNamed(closing.warehouseId)}
          available={
            left.find((s) => s.itemId === closing.itemId && s.warehouseId === closing.warehouseId)
              ?.available ?? 0
          }
          generalStores={lookups.warehouses.filter((w) => w.purpose !== 'SAMPLING')}
          onClose={() => setClosing(null)}
          save={async (d) => {
            await post('CLOSE_MATERIAL', { ...d, ...closing })
            setClosing(null)
            setMessage(
              `${d.qty} ${itemNamed(closing.itemId)?.uom?.symbol ?? ''} closed out: ${SAMPLE_CLOSEOUT_LABEL[d.kind].toLowerCase()}.`
            )
          }}
        />
      )}
      {recordingLine && (
        <MaterialWindow
          key={`${recordingLine.id}-${request.version}`}
          round={round}
          line={recordingLine}
          lookups={lookups}
          request={request}
          onClose={() => setRecording('')}
          save={(d) => recordMaterial(recordingLine, d)}
        />
      )}
      {/* The purchase order form itself, opened on the ticked lines: the order is
        Purchase's document, with Purchase's own rules, and the link back to this
        sample is on each of its lines. */}
      {ordering && (
        <PurchaseOrderDialog
          open
          fromSample={ordering}
          // The form closes itself only when everything went through; a file
          // that did not attach, or an order left as a draft, keeps it open
          // with the reason, while what was saved shows here already.
          onClose={() => setOrdering(null)}
          onSaved={() => {
            setBuyTicks(new Set())
            setMessage(
              'Purchase order saved. Its lines show here as on order; receive the goods into the sample store when they arrive.'
            )
            void reload().catch((e) => setError(apiErrorMessage(e)))
          }}
        />
      )}
    </div>
  )
}

/** A label over its value, for the read-only facts of a round. */
function Fact({ label, value, wide }: { label: string; value: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm font-medium">{value || '—'}</dd>
    </div>
  )
}
/** A figure as typed: no trailing zeros, up to four places. */
const figure = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 4 })

/**
 * A round's specification to read: once released, the record the sample was
 * made to; a draft is shown like this to anyone who cannot edit it. The grid,
 * the measurements and the BOM read as the editor and the printed record lay
 * them out, from the same helpers.
 */
function SpecView({ round, lookups }: { round: SampleRound; lookups: Lookups }) {
  const s = round.specification
  // The size list is in the run's own order, which the grids follow.
  const order = lookups.sizes.map((z) => z.id)
  const code = (id: string) => lookups.sizes.find((z) => z.id === id)?.code ?? 'Unknown size'
  const style = lookups.styles.find((x) => x.id === s.styleId)
  const grid = colourGrid(s, order)
  const matrix = measureMatrix(s, order)
  const cost = materialCost(s)
  return (
    <div className="glass-card space-y-5 p-4">
      <h2 className="flex items-center gap-2 font-semibold">
        <LockKeyhole size={16} />{' '}
        {round.state === 'DRAFT' ? 'Specification' : 'Released specification'} · Round{' '}
        {round.revision}
      </h2>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact
          label="Style"
          value={
            style ? `${style.code} · ${style.name}` : s.styleId ? 'Style no longer in use' : ''
          }
        />
        <Fact label="Milestone" value={s.milestone} />
        <Fact label="Colours & pieces" value={colourSummary(s)} />
        <Fact label="Tech pack" value={s.techPackRef} />
        <Fact label="Pattern" value={s.patternRef} />
        <Fact label="Construction" value={s.construction} wide />
        {s.notes.trim() && <Fact label="Notes" value={s.notes} wide />}
      </dl>

      <div className="overflow-x-auto">
        <table className="data-table w-full">
          <caption className="py-2 text-left text-sm font-semibold">Colours and pieces</caption>
          <thead>
            <tr>
              <th>Colour</th>
              {grid.sizeIds.map((id) => (
                <th key={id} className="text-right">
                  {code(id)}
                </th>
              ))}
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.length ? (
              grid.rows.map((r, i) => (
                <tr key={`${r.colour}-${i}`}>
                  <td>{r.colour || 'Colour not picked'}</td>
                  {grid.sizeIds.map((id) => (
                    <td key={id} className="text-right tabular-nums">
                      {r.qty[id] || '—'}
                    </td>
                  ))}
                  <td className="text-right font-semibold tabular-nums">{r.total}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={grid.sizeIds.length + 2} className="text-muted-foreground">
                  No colours yet.
                </td>
              </tr>
            )}
          </tbody>
          {grid.rows.length > 0 && (
            <tfoot>
              <tr className="font-semibold">
                <td>Total</td>
                {grid.sizeIds.map((id) => (
                  <td key={id} className="text-right tabular-nums">
                    {grid.cols[id]}
                  </td>
                ))}
                <td className="text-right tabular-nums">{grid.total}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="overflow-x-auto">
        <table className="data-table w-full">
          <caption className="py-2 text-left text-sm font-semibold">
            Measurements · the same for every colour
          </caption>
          <thead>
            <tr>
              <th>Point</th>
              <th className="text-right">Tolerance</th>
              {matrix.sizeIds.map((id) => (
                <th key={id} className="text-right">
                  {code(id)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.points.length ? (
              matrix.points.map((p, i) => (
                <tr key={`${p.name}-${i}`}>
                  <td>{p.name || 'Point not named'}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    ± {figure(p.tolerance)} {p.unit}
                  </td>
                  {matrix.sizeIds.map((id) => (
                    <td key={id} className="text-right tabular-nums">
                      {id in p.targets ? figure(p.targets[id]) : '—'}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={matrix.sizeIds.length + 2} className="text-muted-foreground">
                  No measurements yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <table className="data-table w-full">
          <caption className="py-2 text-left text-sm font-semibold">
            Materials · {plural(s.materials.length, 'line')}
          </caption>
          <thead>
            <tr>
              <th>Part</th>
              <th>Material</th>
              <th>Colour</th>
              <th className="text-right">Per piece</th>
              <th className="text-right">Wastage</th>
              <th className="text-right">Required</th>
              <th>Source</th>
              <th className="text-right">Expected rate</th>
            </tr>
          </thead>
          <tbody>
            {s.materials.length ? (
              s.materials.map((l, i) => {
                const it = lineItem(l, round, lookups.items)
                return (
                  <tr key={l.id ?? i}>
                    <td>{l.component || '—'}</td>
                    <td className="min-w-[10rem]">
                      {it.name}
                      {it.code && (
                        <span className="text-muted-foreground block font-mono text-xs">
                          {it.code}
                        </span>
                      )}
                    </td>
                    <td>{lineColour(l.colour)}</td>
                    <td className="text-right tabular-nums">
                      {l.qtyPerPiece ? figure(l.qtyPerPiece) : '—'}
                    </td>
                    <td className="text-right tabular-nums">
                      {l.wastagePct ? `${figure(l.wastagePct)}%` : '—'}
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {figure(lineRequiredQty(l, s))}{' '}
                      <span className="text-muted-foreground text-xs">{it.uom}</span>
                      {l.requiredOverride && (
                        <span className="text-muted-foreground block whitespace-normal text-xs">
                          Typed by hand{l.overrideReason ? `: ${l.overrideReason}` : ''}
                        </span>
                      )}
                    </td>
                    <td>{SAMPLE_MATERIAL_SOURCE_LABEL[l.source]}</td>
                    <td className="text-right tabular-nums">
                      {/* The buyer's material costs us nothing; see Source. */}
                      {l.estRate === null || l.source === 'BUYER_SUPPLIED'
                        ? '—'
                        : `₹${rateFigure(l.estRate)}`}
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={8} className="text-muted-foreground">
                  No materials yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {s.materials.length > 0 && (
          <p className="text-muted-foreground mt-2 text-sm">
            {MATERIAL_COST_LABEL}: {formatRupees(cost.total)}
            {cost.unrated ? ` · ${plural(cost.unrated, 'line')} with no expected rate` : ''}
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="data-table w-full">
          <caption className="py-2 text-left text-sm font-semibold">Making route</caption>
          <thead>
            <tr>
              <th className="text-right">#</th>
              <th>Step</th>
              <th>Process</th>
              <th>Department</th>
              <th>Done at</th>
              <th>Instructions</th>
            </tr>
          </thead>
          <tbody>
            {s.route.length ? (
              s.route.map((step, i) => {
                const f = stepFacts(step, lookups)
                return (
                  <tr key={i}>
                    <td className="text-right tabular-nums">{i + 1}</td>
                    <td>{step.name || 'Step not named'}</td>
                    <td>{f.process || '—'}</td>
                    <td>{f.department || '—'}</td>
                    <td>
                      {f.process ? (
                        <>
                          <span className={f.outside ? 'badge-purple' : 'badge-neutral'}>
                            {f.doneAt}
                          </span>
                          <span className="text-muted-foreground block text-xs">{f.who}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-pre-wrap">{f.instructions || '—'}</td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={6} className="text-muted-foreground">
                  No steps yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Issue, use, waste or return for one material line, in a window. The first
 * issue of a line names its store (STORE_REQUIRED); from then on the store
 * is fixed and shown with the reason (OTHER_STORE). A refusal stays in the
 * window, by what was typed.
 */
function MaterialWindow({
  round,
  line,
  lookups,
  request,
  onClose,
  save,
}: {
  round: SampleRound
  line: SampleMaterial
  lookups: Lookups
  /** For what the request holds in the sample stores (its pool). */
  request: SampleRequest
  onClose: () => void
  save: (d: {
    kind: MaterialKind
    qty: number
    reason: string
    warehouseId?: string
  }) => Promise<void>
}) {
  const allowed = materialActions(round, line)
  const [kind, setKind] = useState<MaterialKind>(allowed.kinds[0] ?? 'USE')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  // Only a sample store is offered. It starts on the one holding this
  // material for the request, else the one the round's other lines use, else
  // the only sample store there is.
  const sampleStores = lookups.warehouses.filter((w) => w.purpose === 'SAMPLING')
  const usedStore =
    (line.warehouseId && sampleStores.some((w) => w.id === line.warehouseId) && issueCap(request, line, line.warehouseId) > 0
      ? line.warehouseId
      : undefined) ??
    sampleStores.find((w) => issueCap(request, line, w.id) > 0)?.id ??
    sampleStores.find((w) => round.materials.some((x) => x.warehouseId === w.id))?.id ??
    (sampleStores.length === 1 ? sampleStores[0].id : '')
  const [warehouseId, setWarehouseId] = useState(usedStore)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const unit = line.item?.uom?.symbol ?? ''
  // An issue is as much as the request holds in that sample store (what is
  // planned is a guide, not a ceiling); use, waste and returns what the line holds.
  const cap = issueCap(request, line, allowed.needsStore ? warehouseId : (line.warehouseId ?? warehouseId))
  // No store picked yet: nothing to measure the quantity against.
  const storeMissing = kind === 'ISSUE' && allowed.needsStore && !warehouseId
  const max = kind === 'ISSUE' ? cap : allowed.held
  const firstIssue = kind === 'ISSUE' && allowed.needsStore
  const fixed = storeNote(line)
  const submit = async () => {
    const n = Number(qty)
    const problem =
      firstIssue && !warehouseId
        ? 'Pick the sample store to issue this material from.'
        : !(n > 0)
          ? 'Enter the quantity.'
          : n > max
            ? max > 0
              ? `No more than ${max} ${unit} for this.`
              : kind === 'ISSUE'
                ? `None of it is in that store for this request yet. Receive it against its purchase order first.`
                : `No more than ${max} ${unit} for this.`
            : !reason.trim()
              ? 'Give the reason or reference.'
              : ''
    if (problem) return setError(problem)
    setBusy(true)
    setError('')
    try {
      await save({ kind, qty: n, reason: reason.trim(), ...(firstIssue ? { warehouseId } : {}) })
    } catch (e) {
      setError(e instanceof Error ? e.message : apiErrorMessage(e))
      setBusy(false)
    }
  }
  const label: Record<MaterialKind, string> = {
    ISSUE: 'Issue material',
    USE: 'Record use',
    WASTE: 'Record waste',
    RETURN: 'Return to store',
  }
  return (
    <FormFrame
      icon={PackageOpen}
      title={kind === 'ISSUE' ? 'Issue material' : 'Record material'}
      subtitle={`${line.item?.name ?? 'Material'} · ${line.component || 'No part named'} · ${lineColour(line.colour)}`}
      width="max-w-2xl"
      primaryInHeader={false}
      busy={busy}
      error={error}
      onClose={onClose}
      primary={
        <button
          type="submit"
          form="sample-material-form"
          className="btn-primary"
          disabled={busy || !allowed.kinds.length}
        >
          {busy ? 'Saving…' : label[kind]}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      }
      footerNote="Issue takes it out of store stock; use and waste are recorded against what was issued."
    >
      <form
        id="sample-material-form"
        onSubmit={(e) => {
          e.preventDefault()
          // Opened over the workspace: the submit stays with this window.
          e.stopPropagation()
          void submit()
        }}
      >
        <fieldset disabled={busy} className="space-y-4 p-2">
          <dl className="bg-muted/40 grid grid-cols-3 gap-3 rounded-lg p-3">
            {[
              ['Required', +line.plannedQty],
              ['Issued', +line.issuedQty],
              ['Still held', allowed.held],
            ].map(([what, value]) => (
              <div key={what}>
                <dt className="text-muted-foreground text-xs">{what}</dt>
                <dd className="mt-0.5 font-semibold tabular-nums">
                  {value} <span className="text-muted-foreground text-xs font-normal">{unit}</span>
                </dd>
              </div>
            ))}
          </dl>
          {line.source === 'BUYER_SUPPLIED' && (
            <p className="text-sm">
              The buyer sends this material. It is issued from the buyer’s own stock in the store,
              kept apart from ours.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Action" required>
              <SmartSelect
                className="form-input"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as MaterialKind)
                  setError('')
                }}
              >
                {allowed.kinds.map((k) => (
                  <option key={k} value={k}>
                    {MATERIAL_KIND_LABEL[k]}
                  </option>
                ))}
              </SmartSelect>
            </Field>
            {firstIssue ? (
              <Field
                label="Store"
                required
                hint={
                  line.source === 'BUYER_SUPPLIED'
                    ? 'Where the buyer’s material was received. Every later issue and return of this line goes through it.'
                    : 'Every later issue and return of this line goes through the same store.'
                }
              >
                <SmartSelect
                  className="form-input"
                  value={warehouseId}
                  onChange={(e) => {
                    setWarehouseId(e.target.value)
                    setError('')
                  }}
                >
                  <option value="">Pick the sample store</option>
                  {sampleStores.map((w) => (
                    <option
                      key={w.id}
                      value={w.id}
                      data-sub={
                        line.source === 'BUYER_SUPPLIED'
                          ? `${issueCap(request, line, w.id)} ${unit} of the buyer’s here`
                          : `${issueCap(request, line, w.id)} ${unit} here for this request`
                      }
                    >
                      {w.name}
                    </option>
                  ))}
                </SmartSelect>
              </Field>
            ) : (
              (kind === 'ISSUE' || kind === 'RETURN') && (
                <Field label="Store" hint={fixed}>
                  <span className="form-input bg-muted/40 block cursor-default">
                    {line.warehouse?.name ?? 'Its store'}
                  </span>
                </Field>
              )
            )}
            <Field
              label={`Quantity${unit ? ` (${unit})` : ''}`}
              required
              hint={
                storeMissing
                  ? `Pick the sample store first · ${allowed.remaining} ${unit} still to issue`
                  : kind === 'ISSUE'
                  ? line.source === 'BUYER_SUPPLIED'
                    ? `${max} ${unit} of the buyer’s in this store · ${allowed.remaining} ${unit} still to issue`
                    : `${max} ${unit} bought for this request in this store · ${allowed.remaining} ${unit} still to issue`
                  : `${max} ${unit} held on this line`
              }
            >
              <StepInput
                className="form-input"
                decimals
                max={storeMissing || max <= 0 ? undefined : max}
                value={qty}
                onValueChange={(v) => {
                  setQty(limitDecimals(v, 3))
                  setError('')
                }}
              />
            </Field>
            <Field label="Reason / reference" required>
              <input
                className="form-input"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </div>
        </fieldset>
      </form>
    </FormFrame>
  )
}
/** What a file or style entry in the activity did, under its heading. */
function EventNoteLine({ text }: { text: string | null }) {
  return text ? <p className="text-muted-foreground mt-1 text-sm">{text}</p> : null
}
function requestChangeValue(key: string, raw: unknown, lookups: Lookups) {
  // Values are as the event recorded them: text, or nothing.
  const value = typeof raw === 'string' ? raw : null
  if (key === 'customerId')
    return lookups.customers.find((c) => c.id === value)?.name ?? value ?? 'Internal development'
  if (key === 'brandId') return lookups.brands.find((b) => b.id === value)?.name ?? value ?? '—'
  return value || '—'
}
function StageAction({
  input,
  name,
  set,
  outside,
  save,
}: {
  input: number
  name: string
  /** Several colours or sizes: the whole set goes on, none rejected here (SET_TEXT.stage). */
  set: boolean
  /** Done by an outside unit, whose own delivery note is the reference. */
  outside: boolean
  save: (d: unknown) => void
}) {
  const [done, setDone] = useState(String(input)),
    [rejected, setRejected] = useState('0'),
    [responsible, setResponsible] = useState(''),
    [reference, setReference] = useState(''),
    [notes, setNotes] = useState('')
  const doneQty = set ? input : Number(done)
  const rejectedQty = set ? 0 : Number(rejected)
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        {set
          ? `${input} pieces received: the whole set goes on together.`
          : `${input} pieces received. Done plus rejected must account for every piece.`}{' '}
        {outside
          ? 'Give the outside unit’s delivery note or challan number as the work reference; this pilot does not issue a statutory challan.'
          : 'Record outside-work references in the notes; this pilot does not issue a statutory challan.'}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {set ? (
          <p className="bg-muted/40 rounded-lg p-3 text-sm sm:col-span-2">
            <span className="font-medium">{input} pieces done</span>, none rejected here.{' '}
            {SET_TEXT.stage}
          </p>
        ) : (
          <>
            <Field label="Done pieces">
              <StepInput className="form-input" max={input} value={done} onValueChange={setDone} />
            </Field>
            <Field label="Rejected pieces">
              <StepInput
                className="form-input"
                max={input}
                value={rejected}
                onValueChange={setRejected}
              />
            </Field>
          </>
        )}
        <Field label={outside ? 'Outside unit / person responsible' : 'Responsible person / unit'}>
          <input
            className="form-input"
            value={responsible}
            onChange={(e) => setResponsible(e.target.value)}
          />
        </Field>
        <Field label="Work reference (optional)">
          <input
            className="form-input"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label={
          set
            ? 'Work performed / defects found'
            : 'Work performed / defects / rejected-piece disposition'
        }
      >
        <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <button
        className="btn-primary"
        disabled={
          !responsible.trim() ||
          !notes.trim() ||
          doneQty < 0 ||
          rejectedQty < 0 ||
          doneQty + rejectedQty !== input ||
          !Number.isInteger(doneQty) ||
          !Number.isInteger(rejectedQty)
        }
        onClick={() =>
          save({
            doneQty,
            rejectedQty,
            responsible,
            reference,
            notes,
          })
        }
      >
        Complete {name.toLowerCase()}
      </button>
    </div>
  )
}
function QcAction({
  round,
  lookups,
  save,
}: {
  round: SampleRound
  lookups: Lookups
  save: (d: unknown) => void
}) {
  // A set is inspected and passed whole (SET_TEXT.qc): every piece the route finished.
  const set = isSampleSet(round.specification)
  const finished = round.stages.at(-1)?.doneQty ?? 0
  const colours = round.specification.colours.filter((r) => r.colour.trim()).length
  const [actuals, setActuals] = useState<string[]>(round.specification.measurements.map(() => '')),
    [passed, setPassed] = useState(set ? String(finished) : ''),
    [notes, setNotes] = useState('')
  const passedQty = set ? finished : Number(passed)
  return (
    <div className="glass-card space-y-3 p-4">
      <h2 className="font-semibold">Measurement inspection</h2>
      {colours > 1 && (
        <p className="text-muted-foreground text-xs">
          Every colour is made to the same targets: enter what one piece of each size measures.
        </p>
      )}
      {round.specification.measurements.map((m, i) => (
        <Field
          key={i}
          label={`${lookups.sizes.find((s) => s.id === m.sizeId)?.code} · ${m.name}`}
          hint={`Target ${m.target} ± ${m.tolerance} ${m.unit}${actuals[i] === '' ? '' : Math.abs(+actuals[i] - m.target) <= m.tolerance + 1e-8 ? ' · Within tolerance' : ' · Outside tolerance'}`}
        >
          <StepInput
            className="form-input"
            decimals
            step={0.1}
            max={10000}
            value={actuals[i]}
            onValueChange={(v) =>
              setActuals((a) => a.map((x, j) => (j === i ? limitDecimals(v, 2) : x)))
            }
          />
        </Field>
      ))}
      {set ? (
        <p className="bg-muted/40 rounded-lg p-3 text-sm">
          <span className="font-medium">{finished} pieces inspected</span>, the whole set.{' '}
          {SET_TEXT.qc}
        </p>
      ) : (
        <Field
          label="Pieces passing workmanship inspection"
          hint={`${finished} pieces finished the making route.`}
        >
          <StepInput
            className="form-input"
            max={finished}
            value={passed}
            onValueChange={setPassed}
          />
        </Field>
      )}
      <Field label="QC findings and disposition of failed pieces">
        <textarea className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <button
        className="btn-primary"
        disabled={
          actuals.some((x) => x === '' || +x < 0) ||
          passedQty < 1 ||
          passedQty > finished ||
          !Number.isInteger(passedQty) ||
          !notes.trim()
        }
        onClick={() =>
          save({
            actuals: actuals.some((x) => x === '') ? [] : actuals.map(Number),
            passedQty,
            notes,
          })
        }
      >
        Record QC
      </button>
    </div>
  )
}
function SubmissionAction({
  available,
  set,
  save,
}: {
  available: number
  /** Several colours or sizes: the whole inspected set is sent (SET_TEXT.submit). */
  set: boolean
  save: (d: unknown) => void
}) {
  const [typed, setQty] = useState(''),
    [recipient, setRecipient] = useState(''),
    [reference, setReference] = useState(''),
    [notes, setNotes] = useState('')
  const qty = set ? String(available) : typed
  return (
    <div className="glass-card space-y-3 p-4">
      <h2 className="font-semibold">Submit to buyer</h2>
      {set ? (
        <p className="bg-muted/40 rounded-lg p-3 text-sm">
          <span className="font-medium">{available} pieces sent</span>, every colour and size.{' '}
          {SET_TEXT.submit}
        </p>
      ) : (
        <Field
          label="Pieces sent"
          hint={`${available} pieces passed QC and are available to submit.`}
        >
          <StepInput className="form-input" max={available} value={typed} onValueChange={setQty} />
        </Field>
      )}
      <Field label="Recipient">
        <input
          className="form-input"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        />
      </Field>
      <Field label="Courier / signed handover reference">
        <input
          className="form-input"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </Field>
      <Field label="Submission notes / remaining samples retained by">
        <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <button
        className="btn-primary"
        disabled={
          +qty < 1 || +qty > available || !recipient.trim() || !reference.trim() || !notes.trim()
        }
        onClick={() => save({ qty: Number(qty), recipient, reference, notes })}
      >
        Record submission
      </button>
    </div>
  )
}
function DecisionAction({ save }: { save: (d: unknown) => void }) {
  const [result, setResult] = useState('CHANGES_REQUIRED'),
    [buyerName, setBuyer] = useState(''),
    [evidence, setEvidence] = useState(''),
    [conditions, setConditions] = useState('')
  return (
    <div className="glass-card space-y-3 p-4">
      <h2 className="font-semibold">Record buyer feedback</h2>
      <Field label="Decision">
        <select className="form-input" value={result} onChange={(e) => setResult(e.target.value)}>
          {['CHANGES_REQUIRED', 'APPROVED', 'REJECTED'].map((x) => (
            <option key={x} value={x}>
              {SAMPLE_STATE_LABEL[x]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Buyer decision maker">
        <input
          className="form-input"
          value={buyerName}
          onChange={(e) => setBuyer(e.target.value)}
        />
      </Field>
      <Field label="Evidence / feedback reference">
        <textarea
          className="form-input"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </Field>
      <Field
        label="Unresolved conditions"
        hint="If corrections are still needed, choose Changes required. Approval requires this field to be empty."
      >
        <textarea
          className="form-input"
          value={conditions}
          onChange={(e) => setConditions(e.target.value)}
        />
      </Field>
      <button
        className="btn-primary"
        disabled={
          !buyerName.trim() || !evidence.trim() || (result === 'APPROVED' && !!conditions.trim())
        }
        onClick={() => save({ result, buyerName, evidence, conditions })}
      >
        Save buyer decision
      </button>
    </div>
  )
}
function ReasonAction({ label, save }: { label: string; save: (s: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <div className="glass-card space-y-3 p-4">
      <h3 className="font-semibold">{label}</h3>
      <p className="text-muted-foreground text-sm">
        {label === 'Cancel request'
          ? 'Account for material first. Include what will happen to any samples already made; the request and its history will be retained.'
          : 'Start a new draft using this round’s specification. Update the design or milestone there; this round and its feedback remain in the history.'}
      </p>
      <Field
        label="Reason and sample disposition"
        required
        hint="Describe what needs to change or what happens to the existing samples."
      >
        <textarea
          className="form-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <button
        className="btn-secondary"
        disabled={reason.trim().length < 5}
        onClick={() => save(reason)}
      >
        {label}
      </button>
    </div>
  )
}
function HandoverAction({
  round,
  lookups,
  save,
}: {
  round: SampleRound
  lookups: Lookups
  save: (d: unknown) => void
}) {
  const [bomId, setBom] = useState(''),
    [routingId, setRouting] = useState(''),
    [notes, setNotes] = useState('')
  // The server takes a BOM for every colour, or for one of the colours the round made.
  const boms = handoverBoms(lookups.boms, round.specification)
  const colours = round.specification.colours.map((c) => c.colour.trim()).filter(Boolean)
  return (
    <div className="glass-card space-y-3 p-4">
      <h2 className="font-semibold">Prepare approved bulk package</h2>
      <Field
        label="Approved production BOM"
        hint={
          boms.length
            ? `This style’s approved BOMs for every colour, or for one of this round’s colours (${colours.join(', ')}).`
            : `No approved BOM of this style for every colour or for ${colours.join(', ') || 'this round’s colours'} yet.`
        }
      >
        <SmartSelect className="form-input" value={bomId} onChange={(e) => setBom(e.target.value)}>
          <option value="">Pick approved BOM</option>
          {boms.map((x) => (
            <option key={x.id} value={x.id}>
              Version {x.version} · {x.color || 'All colours'}
            </option>
          ))}
        </SmartSelect>
      </Field>
      <Field label="Production routing">
        <SmartSelect
          className="form-input"
          value={routingId}
          onChange={(e) => setRouting(e.target.value)}
        >
          <option value="">Pick routing</option>
          {lookups.routings
            .filter((x) => !x.styleId || x.styleId === round.specification.styleId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · v{x.version}
              </option>
            ))}
        </SmartSelect>
      </Field>
      <Field label="Technical acceptance and handover notes">
        <textarea className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <button
        className="btn-primary"
        disabled={!bomId || !routingId || !notes.trim()}
        onClick={() => save({ bomId, routingId, notes })}
      >
        Prepare handover
      </button>
    </div>
  )
}
/** A line not needed after all, or needed again: with why, before making starts. */
function WaiveWindow({
  line,
  onClose,
  save,
}: {
  line: SampleMaterial
  onClose: () => void
  save: (reason: string) => Promise<void>
}) {
  const undo = !!line.waivedAt
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!undo && reason.trim().length < SAMPLE_REASON_MIN)
      return setError('Say why this line is not needed — a few words is enough.')
    setBusy(true)
    setError('')
    try {
      await save(reason.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message : apiErrorMessage(e))
      setBusy(false)
    }
  }
  return (
    <FormFrame
      icon={PackageOpen}
      title={undo ? 'Needed after all' : 'Not needed'}
      subtitle={`${line.item?.name ?? 'Material'} · ${line.component || 'No part named'} · ${lineColour(line.colour)}`}
      width="max-w-xl"
      primaryInHeader={false}
      busy={busy}
      error={error}
      onClose={onClose}
      primary={
        <button type="submit" form="sample-waive-form" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : undo ? 'Needed after all' : 'Mark not needed'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      }
      footerNote={
        undo
          ? 'The line goes back on the list to issue before making starts.'
          : 'Making can start without it. Anything already bought for it stays in the sample store for this request.'
      }
    >
      <form
        id="sample-waive-form"
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void submit()
        }}
      >
        <fieldset disabled={busy} className="space-y-4 p-2">
          {undo ? (
            <p className="text-sm">
              Marked not needed: {line.waivedReason}
              {line.waivedBy ? ` (${line.waivedBy})` : ''}.
            </p>
          ) : (
            <Field label="Why it is not needed" required hint="The buyer dropped it, another material does instead…">
              <textarea
                className="form-input"
                value={reason}
                maxLength={500}
                autoFocus
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          )}
        </fieldset>
      </form>
    </FormFrame>
  )
}
/**
 * What is left of the request's own material in a sample store, closed out:
 * used up in the sample, or moved to a general store at what it is carried at.
 */
function CloseOutWindow({
  item,
  storeName,
  available,
  generalStores,
  onClose,
  save,
}: {
  item: SampleMaterial['item']
  storeName: string
  available: number
  generalStores: Lookups['warehouses']
  onClose: () => void
  save: (d: { kind: SampleCloseOutKind; qty: number; toWarehouseId: string | null; reason: string }) => Promise<void>
}) {
  const [kind, setKind] = useState<SampleCloseOutKind>('USED')
  const [qty, setQty] = useState(String(available))
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const unit = item?.uom?.symbol ?? ''
  const submit = async () => {
    const n = Number(qty)
    const problem = !(n > 0)
      ? 'Enter the quantity.'
      : n > available + 1e-9
        ? `No more than ${available} ${unit} is left for this request here.`
        : kind === 'MOVED' && !to
          ? 'Pick the general store it goes to.'
          : reason.trim().length < SAMPLE_REASON_MIN
            ? 'Say why, in a few words.'
            : ''
    if (problem) return setError(problem)
    setBusy(true)
    setError('')
    try {
      await save({ kind, qty: n, toWarehouseId: kind === 'MOVED' ? to : null, reason: reason.trim() })
    } catch (e) {
      setError(e instanceof Error ? e.message : apiErrorMessage(e))
      setBusy(false)
    }
  }
  return (
    <FormFrame
      icon={PackageOpen}
      title="Close out leftover material"
      subtitle={`${item?.name ?? 'Material'} · ${available} ${unit} left in ${storeName}`}
      width="max-w-2xl"
      primaryInHeader={false}
      busy={busy}
      error={error}
      onClose={onClose}
      primary={
        <button type="submit" form="sample-closeout-form" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Close out'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      }
      footerNote="Used in the sample counts it as consumed by this request. Moved goes to the general store at what it is carried at, and is bulk stock from then on."
    >
      <form
        id="sample-closeout-form"
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void submit()
        }}
      >
        <fieldset disabled={busy} className="space-y-4 p-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What happens to it" required>
              <SmartSelect
                className="form-input"
                value={kind}
                autoFocus
                onChange={(e) => {
                  setKind(e.target.value as SampleCloseOutKind)
                  setError('')
                }}
              >
                {(can('inventory', 'edit') ? (['USED', 'MOVED'] as const) : (['USED'] as const)).map((k) => (
                  <option key={k} value={k}>
                    {SAMPLE_CLOSEOUT_LABEL[k]}
                  </option>
                ))}
              </SmartSelect>
            </Field>
            <Field label={`Quantity${unit ? ` (${unit})` : ''}`} required hint={`${available} ${unit} left`}>
              <StepInput className="form-input" decimals max={available} value={qty} onValueChange={setQty} />
            </Field>
            {kind === 'MOVED' && (
              <Field label="General store it goes to" required>
                <SmartSelect className="form-input" value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">Pick the store</option>
                  {generalStores.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </SmartSelect>
              </Field>
            )}
          </div>
          {!can('inventory', 'edit') && (
            <p className="text-muted-foreground text-xs">
              Moving it into general stock is for the store, with inventory rights: ask them to close it out that way.
            </p>
          )}
          <Field label="Why" required>
            <textarea
              className="form-input"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </fieldset>
      </form>
    </FormFrame>
  )
}
