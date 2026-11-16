'use client'
import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Clock3, History, Printer, LockKeyhole } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { SAMPLE_STATE_LABEL } from '@ld-erp/shared'
import { Field, SampleSpecEditor } from './SampleSpecEditor'
import type { SampleRequest, Lookups, SampleRound } from './types'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { makingBlocker, materialHeld, sampleFlow, type SampleSection } from './samplingFlow'
import { SampleRequestEditor } from './SampleRequestEditor'

export function SampleWorkspace({
  initial,
  lookups,
  back,
}: {
  initial: SampleRequest
  lookups: Lookups
  back: () => void
}) {
  const [request, setRequest] = useState(initial),
    [selected, setSelected] = useState(initial.rounds[0].id),
    [tab, setTab] = useState<SampleSection>(() => sampleFlow(initial).section)
  const [dirty, setDirty] = useState(false)
  const [editingRequest, setEditingRequest] = useState(false)
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
    [message, setMessage] = useState('')
  const round = request.rounds.find((x) => x.id === selected) ?? request.rounds[0],
    latest = request.rounds[0].id === round.id
  const edit = can('sampling', 'edit') && !request.cancelledAt,
    approve = can('sampling', 'approve') && !request.cancelledAt
  const flow = sampleFlow(request, round)
  const changeRound = (id: string) => {
    if (dirty && !window.confirm('Discard the unsaved specification changes?')) return
    setDirty(false)
    setSelected(id)
    setTab(
      sampleFlow(
        request,
        request.rounds.find((r) => r.id === id)!
      ).section
    )
    setError('')
    setMessage('')
  }
  const act = async (action: string, data: unknown, roundId = round.id) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const res = await api.post<{ data: SampleRequest }>(`/sampling/${request.id}/actions`, {
        version: request.version,
        roundId,
        action,
        data,
      })
      setRequest(res.data)
      if (['SAVE_DRAFT', 'SAVE_SPEC', 'RELEASE'].includes(action)) setDirty(false)
      if (action === 'NEW_ROUND') {
        setSelected(res.data.rounds[0].id)
        setTab('Technical')
      }
      if (
        ['RELEASE', 'STAGE', 'QC', 'SUBMIT', 'DECIDE', 'HANDOVER', 'ACCEPT_HANDOVER'].includes(
          action
        )
      )
        setTab(sampleFlow(res.data).section)
      setMessage(
        action === 'SAVE_DRAFT'
          ? 'Draft saved. You can leave this request and finish the specification later.'
          : action === 'UPDATE_REQUEST'
            ? 'Request details updated. The changes are recorded in activity history.'
            : 'Saved. The next action is shown below.'
      )
      return res.data
    } catch (e) {
      setError(apiErrorMessage(e))
      if (e instanceof Error && e.message.includes('another window')) {
        setError(
          'This request changed in another window. Your entries are still here, but have not been saved. Copy any details you need, then reopen the request to review the latest version.'
        )
      }
      return null
    } finally {
      setBusy(false)
    }
  }
  const held = materialHeld
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button
            className="btn-ghost"
            disabled={busy}
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
            disabled={busy}
            onChange={(e) => changeRound(e.target.value)}
            aria-label="Sample round"
          >
            {request.rounds.map((r) => (
              <option key={r.id} value={r.id}>
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
      <div className="grid items-start gap-5 xl:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="glass-card p-3 xl:sticky xl:top-4">
          <p className="text-muted-foreground px-3 pt-2 text-xs font-semibold uppercase tracking-wider">
            Round {round.revision} workflow
          </p>
          <p className="px-3 py-2 text-sm font-medium">{round.specification.milestone}</p>
          <nav aria-label="Sampling stages" className="grid gap-1 sm:grid-cols-2 xl:grid-cols-1">
            {flow.steps.map((step, i) => (
              <button
                key={step.key}
                disabled={busy}
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
                      ? ` · ${round.stages.filter((s) => s.completedAt).length}/${round.stages.length || round.specification.stages.length} steps`
                      : ''}
                  </span>
                  {step.key === 'Making' && (
                    <span className="border-border mt-2 block space-y-1 border-l pl-2">
                      {(round.stages.length
                        ? round.stages
                        : round.specification.stages.map((name) => ({ name, completedAt: null }))
                      ).map((stage, j) => (
                        <span
                          key={j}
                          className="text-muted-foreground flex items-center gap-1.5 text-xs"
                        >
                          {stage.completedAt ? (
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
            disabled={busy}
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
                    disabled={busy}
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
          <fieldset disabled={busy} className="min-w-0">
            {tab === 'Brief' && (
              <div className="glass-card space-y-4 p-5">
                {edit && !request.rounds.some((r) => r.handover) && (
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
            <div hidden={tab !== 'Technical'}>
              {round.state === 'DRAFT' && edit && latest ? (
                <div className="space-y-4">
                  <SampleSpecEditor
                    key={round.id}
                    initial={round.specification}
                    lookups={lookups}
                    brandId={request.brandId}
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
                <div className="glass-card space-y-3 p-4">
                  <h2 className="flex items-center gap-2 font-semibold">
                    <LockKeyhole size={16} />{' '}
                    {round.state === 'DRAFT' ? 'Specification' : 'Released specification'} · Round{' '}
                    {round.revision}
                  </h2>
                  <p>
                    {lookups.styles.find((x) => x.id === round.specification.styleId)?.name} ·{' '}
                    {round.specification.color} · {round.specification.milestone}
                  </p>
                  <p>{round.specification.construction}</p>
                  <p>Tech pack: {round.specification.techPackRef}</p>
                  <p>Pattern: {round.specification.patternRef}</p>
                  <p>
                    Sizes:{' '}
                    {round.specification.sizes
                      .map(
                        (x) =>
                          `${lookups.sizes.find((z) => z.id === x.sizeId)?.code ?? x.sizeId} × ${x.qty}`
                      )
                      .join(', ')}
                  </p>
                  <p>Making route: {round.specification.stages.join(' → ')}</p>
                  <div className="overflow-x-auto">
                    <table className="data-table w-full">
                      <caption className="py-2 text-left text-sm font-semibold">
                        Measurement targets
                      </caption>
                      <thead>
                        <tr>
                          <th>Size</th>
                          <th>Measurement</th>
                          <th>Target</th>
                          <th>Tolerance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {round.specification.measurements.map((m, i) => (
                          <tr key={i}>
                            <td>{lookups.sizes.find((x) => x.id === m.sizeId)?.code}</td>
                            <td>{m.name}</td>
                            <td>
                              {m.target} {m.unit}
                            </td>
                            <td>
                              ± {m.tolerance} {m.unit}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p>{round.specification.notes}</p>
                </div>
              )}
            </div>
            {tab === 'Materials' && (
              <div className="space-y-3">
                <p className="text-muted-foreground text-sm">
                  Issue removes material from store stock. Record use or waste against that issue;
                  it does not deduct stock again. Return unused material to its original store.
                </p>
                {round.materials.length === 0 && (
                  <p>Save and release a specification to prepare its material plan.</p>
                )}
                {round.materials.map((m) => (
                  <div key={m.id} className="glass-card space-y-3 p-4">
                    <h2 className="font-semibold">
                      {m.item.name} · {m.warehouse.name} ·{' '}
                      {m.ownership === 'OWNED' ? 'Our material' : 'Buyer’s material'}
                    </h2>
                    <div className="bg-muted/40 grid grid-cols-3 gap-3 rounded-lg p-3 sm:grid-cols-6">
                      {[
                        ['Planned', m.plannedQty],
                        ['Issued', m.issuedQty],
                        ['Used', m.usedQty],
                        ['Waste', m.wasteQty],
                        ['Returned', m.returnedQty],
                        ['Still held', held(m)],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <p className="text-muted-foreground text-xs">{label}</p>
                          <p className="mt-1 font-semibold tabular-nums">
                            {+value}{' '}
                            <span className="text-muted-foreground text-xs font-normal">
                              {m.item.uom?.symbol}
                            </span>
                          </p>
                        </div>
                      ))}
                    </div>
                    {m.issuedValue !== undefined && (
                      <p className="text-muted-foreground text-sm">
                        Net material value: ₹{(+m.issuedValue - +(m.returnedValue ?? 0)).toFixed(2)}{' '}
                        · excludes labour, services and courier
                      </p>
                    )}
                    {edit && can('inventory', 'edit') && !round.handover && (
                      <MaterialAction
                        key={`${m.id}-${request.version}`}
                        issue={
                          round.state === 'RELEASED' && !round.stages.some((x) => x.completedAt)
                        }
                        remaining={Math.max(0, +m.plannedQty - +m.issuedQty)}
                        held={held(m)}
                        unit={m.item.uom?.symbol ?? ''}
                        save={(d) => void act('MATERIAL', { ...d, materialId: m.id })}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            {tab === 'Making' && (
              <div className="space-y-4">
                {round.stages.length === 0 && (
                  <p>Release the specification to prepare its making route.</p>
                )}
                {round.stages.map((s, i) => (
                  <div key={s.id} className="glass-card space-y-3 p-4">
                    <h2 className="font-semibold">
                      {s.sequence}. {s.name}
                    </h2>
                    {s.completedAt ? (
                      <p>
                        Done {s.doneQty} · Rejected {s.rejectedQty} · {s.responsible} ·{' '}
                        {formatDate(s.completedAt)}
                        <br />
                        {s.notes}
                      </p>
                    ) : edit && latest && round.state === 'RELEASED' && !makingBlocker(round, i) ? (
                      <StageAction
                        key={`${s.id}-${request.version}`}
                        name={s.name}
                        input={
                          i === 0
                            ? round.specification.sizes.reduce((t, z) => t + z.qty, 0)
                            : (round.stages[i - 1].doneQty ?? 0)
                        }
                        save={(d) =>
                          void act('STAGE', { ...(d as Record<string, unknown>), stageId: s.id })
                        }
                      />
                    ) : (
                      <p className="text-muted-foreground flex items-center gap-2 text-sm">
                        <Clock3 size={15} />{' '}
                        {makingBlocker(round, i) || 'Awaiting completion by the sampling operator.'}
                      </p>
                    )}
                  </div>
                ))}
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
                  Buyer approval covers this round’s style, colour, sizes and specification.
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
                  request.rounds.every((r) => r.materials.every((m) => held(m) === 0)) && (
                    <HandoverAction
                      round={round}
                      lookups={lookups}
                      save={(d) => void act('HANDOVER', d)}
                    />
                  )}
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
                      {e.action === 'SAVE_DRAFT'
                        ? 'Draft saved'
                        : e.action === 'UPDATE_REQUEST'
                          ? 'Request details updated'
                          : e.action.replaceAll('_', ' ')}{' '}
                      · {e.detail.by ?? 'User'} · {formatDate(e.createdAt)}
                    </p>
                    {e.action === 'UPDATE_REQUEST' && (
                      <div className="mt-2 space-y-2 text-sm">
                        <p>{e.detail.data?.reason}</p>
                        {Object.entries(e.detail.data?.after ?? {})
                          .filter(([key, value]) => value !== e.detail.data?.before?.[key])
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
    </div>
  )
}
function requestChangeValue(key: string, value: string | null | undefined, lookups: Lookups) {
  if (key === 'customerId')
    return lookups.customers.find((c) => c.id === value)?.name ?? value ?? 'Internal development'
  if (key === 'brandId') return lookups.brands.find((b) => b.id === value)?.name ?? value ?? '—'
  return value || '—'
}
function MaterialAction({
  issue,
  remaining,
  held,
  unit,
  save,
}: {
  issue: boolean
  remaining: number
  held: number
  unit: string
  save: (d: { kind: string; qty: number; reason: string }) => void
}) {
  const [kind, setKind] = useState(issue && remaining > 0 ? 'ISSUE' : 'USE'),
    [qty, setQty] = useState(''),
    [reason, setReason] = useState('')
  const max = kind === 'ISSUE' ? remaining : held
  return (
    <div className="grid items-end gap-4 md:grid-cols-2">
      <Field label="Action">
        <select className="form-input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {issue && remaining > 0 && <option value="ISSUE">Issue from store</option>}
          <option value="USE">Record material used</option>
          <option value="WASTE">Record waste</option>
          <option value="RETURN">Return to store</option>
        </select>
      </Field>
      <Field label={`Quantity (${unit})`} hint={`${max} available for this action`}>
        <input
          className="form-input"
          type="number"
          min="0.001"
          step="0.001"
          max={max}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
      </Field>
      <Field label="Reason / reference">
        <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <button
        className="btn-primary"
        disabled={!reason.trim() || +qty <= 0 || +qty > max}
        onClick={() => save({ kind, qty: Number(qty), reason })}
      >
        Record material
      </button>
    </div>
  )
}
function StageAction({
  input,
  name,
  save,
}: {
  input: number
  name: string
  save: (d: unknown) => void
}) {
  const [done, setDone] = useState(String(input)),
    [rejected, setRejected] = useState('0'),
    [responsible, setResponsible] = useState(''),
    [reference, setReference] = useState(''),
    [notes, setNotes] = useState('')
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        {input} pieces received. Done plus rejected must account for every piece. Record
        outside-work references in the notes; this pilot does not issue a statutory challan.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Done pieces">
          <input
            type="number"
            min={0}
            className="form-input"
            value={done}
            onChange={(e) => setDone(e.target.value)}
          />
        </Field>
        <Field label="Rejected pieces">
          <input
            type="number"
            min={0}
            className="form-input"
            value={rejected}
            onChange={(e) => setRejected(e.target.value)}
          />
        </Field>
        <Field label="Responsible person / unit">
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
      <Field label="Work performed / defects / rejected-piece disposition">
        <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <button
        className="btn-primary"
        disabled={
          !responsible.trim() ||
          !notes.trim() ||
          +done < 0 ||
          +rejected < 0 ||
          +done + +rejected !== input ||
          !Number.isInteger(+done) ||
          !Number.isInteger(+rejected)
        }
        onClick={() =>
          save({
            doneQty: Number(done),
            rejectedQty: Number(rejected),
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
  const [actuals, setActuals] = useState<string[]>(round.specification.measurements.map(() => '')),
    [passed, setPassed] = useState(''),
    [notes, setNotes] = useState('')
  return (
    <div className="glass-card space-y-3 p-4">
      <h2 className="font-semibold">Measurement inspection</h2>
      {round.specification.measurements.map((m, i) => (
        <Field
          key={i}
          label={`${lookups.sizes.find((s) => s.id === m.sizeId)?.code} · ${m.name}`}
          hint={`Target ${m.target} ± ${m.tolerance} ${m.unit}${actuals[i] === '' ? '' : Math.abs(+actuals[i] - m.target) <= m.tolerance + 1e-8 ? ' · Within tolerance' : ' · Outside tolerance'}`}
        >
          <input
            type="number"
            step="0.01"
            className="form-input"
            value={actuals[i]}
            onChange={(e) => setActuals((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
          />
        </Field>
      ))}
      <Field label="Pieces passing workmanship inspection">
        <input
          className="form-input"
          type="number"
          min={1}
          value={passed}
          onChange={(e) => setPassed(e.target.value)}
        />
      </Field>
      <Field label="QC findings and disposition of failed pieces">
        <textarea className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <button
        className="btn-primary"
        disabled={
          actuals.some((x) => x === '' || +x < 0) ||
          +passed < 1 ||
          +passed > (round.stages.at(-1)?.doneQty ?? 0) ||
          !notes.trim()
        }
        onClick={() =>
          save({
            actuals: actuals.some((x) => x === '') ? [] : actuals.map(Number),
            passedQty: Number(passed),
            notes,
          })
        }
      >
        Record QC
      </button>
    </div>
  )
}
function SubmissionAction({ available, save }: { available: number; save: (d: unknown) => void }) {
  const [qty, setQty] = useState(''),
    [recipient, setRecipient] = useState(''),
    [reference, setReference] = useState(''),
    [notes, setNotes] = useState('')
  return (
    <div className="glass-card space-y-3 p-4">
      <h2 className="font-semibold">Submit to buyer</h2>
      <Field
        label="Pieces sent"
        hint={`${available} pieces passed QC and are available to submit.`}
      >
        <input
          type="number"
          className="form-input"
          min={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
      </Field>
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
  return (
    <div className="glass-card space-y-3 p-4">
      <h2 className="font-semibold">Prepare approved bulk package</h2>
      <Field label="Approved production BOM">
        <SmartSelect className="form-input" value={bomId} onChange={(e) => setBom(e.target.value)}>
          <option value="">Pick approved BOM</option>
          {lookups.boms
            .filter(
              (x) =>
                x.styleId === round.specification.styleId &&
                (!x.color || x.color.toLowerCase() === round.specification.color.toLowerCase())
            )
            .map((x) => (
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
