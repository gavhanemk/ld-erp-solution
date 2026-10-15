'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Circle, ClipboardList, Factory, Pause, Play, Route } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { StagesDialog } from '../StagesDialog'
import { JobCardView } from './JobCardView'
import { SheetView } from './SheetView'
import { isCheck, pcs, PROGRESS, type Flow, type StepFigures } from './types'

/**
 * An order's production, in the order it happens: its materials issued, its
 * stages loaded from the routing (and changed for this order if need be), and
 * then each colour's job card with its process forms — cutting first, then
 * every stage to the last check. A form opens its sheet.
 */

interface CardRow {
  id: string
  jobCardNumber: string
  designNo: string | null
  moLine: { id: string; color: string; totalQty: number; style: { code: string } }
  cut: number
  withCutters: number
  packed: number
  steps: Array<{ id: string; sequence: number; name: string; kind: string; isQcStep: boolean; execution: string; skippedAt: string | null; figures: StepFigures }>
}

export function MoProductionPanel({
  mo,
  flow,
  materialsIssued,
  onLoadStages,
  onChanged,
}: {
  mo: { id: string; moNumber: string; status: string; heldAt: string | null; progress: string | null; steps: unknown[] }
  /** The whole order's route and figures, for changing its stages. */
  flow: Flow | null
  materialsIssued: boolean
  onLoadStages: () => void
  onChanged: (message: string) => void
}) {
  const [cards, setCards] = useState<CardRow[]>([])
  const [open, setOpen] = useState<{ kind: 'card'; id: string } | { kind: 'sheet'; id: string; stepId: string } | { kind: 'route' } | { kind: 'hold' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = !['DRAFT', 'CLOSED'].includes(mo.status)
  const staged = mo.steps.length > 0

  const loadCards = useCallback(async () => {
    try {
      setCards((await api.get<Paginated<CardRow>>(`/production/job-cards?moId=${mo.id}&show=all&limit=100`)).data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the job cards.')
    }
  }, [mo.id])
  useEffect(() => {
    if (mo.status !== 'DRAFT') void loadCards()
  }, [loadCards, mo.status, mo.steps.length])

  const post = async (path: string, body: unknown, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(path, body)
      setOpen(null)
      onChanged(res.message ?? fallback)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.')
      setOpen(null)
    } finally {
      setBusy(false)
    }
  }

  const progress = PROGRESS[mo.progress ?? 'NOT_STARTED'] ?? PROGRESS.NOT_STARTED
  const step = (n: number, doneIt: boolean, title: string, body: React.ReactNode) => (
    <li className="flex items-start gap-3">
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${doneIt ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
        {doneIt ? <CheckCircle2 size={14} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-medium">{title}</p>
        <div className="text-muted-foreground mt-0.5 text-xs">{body}</div>
      </div>
    </li>
  )

  return (
    <>
      <Section
        icon={Factory}
        title="Production"
        actions={
          staged && live ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className={progress.cls}>{progress.label}</span>
              {can('production', 'edit') &&
                (mo.heldAt ? (
                  <button type="button" className="btn-secondary h-7 px-2.5 text-xs" disabled={busy} onClick={() => void post(`/production/orders/${mo.id}/resume`, {}, 'Resumed.')}>
                    <Play size={13} /> Resume
                  </button>
                ) : (
                  <button type="button" className="btn-ghost h-7 px-2.5 text-xs" onClick={() => setOpen({ kind: 'hold' })}>
                    <Pause size={13} /> Hold
                  </button>
                ))}
            </div>
          ) : undefined
        }
      >
        {error && (
          <p className="text-destructive mb-2 flex items-start gap-1.5 text-xs">
            <AlertTriangle size={13} className="mt-px shrink-0" /> {error}
          </p>
        )}
        <ol className="space-y-3">
          {step(
            1,
            materialsIssued,
            'Materials issued',
            materialsIssued ? 'The store has issued materials to this order.' : mo.status === 'DRAFT' ? 'Release the order, then raise its requisition below.' : 'Raise the requisition in the materials list below and have the store issue it. Production starts after that.',
          )}
          {step(
            2,
            staged,
            'Stages loaded',
            staged ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-1">
                  {(flow?.steps ?? []).map((s, i) => (
                    <span key={s.id} className="flex items-center gap-1">
                      {i > 0 && <span className="text-muted-foreground">→</span>}
                      <span className={`rounded-md border px-1.5 py-0.5 text-[11px] ${s.skippedAt ? 'border-border line-through opacity-60' : isCheck(s) ? 'border-primary/40 text-primary' : 'border-border text-foreground'}`}>
                        {s.name}
                        {s.execution === 'OUTSOURCED' ? ' (outside)' : ''}
                      </span>
                    </span>
                  ))}
                </div>
                {flow?.mo.routing && (
                  <p>
                    From routing {flow.mo.routing.code} v{flow.mo.routing.version}
                    {flow.mo.routing.latest !== flow.mo.routing.version ? ` (routing now v${flow.mo.routing.latest})` : ''}. Changes here are for this order only.
                  </p>
                )}
                {live && flow && can('production', mo.status === 'DRAFT' ? 'edit' : 'approve') && (
                  <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={() => setOpen({ kind: 'route' })}>
                    <Route size={13} /> Change stages
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <p>The stages come from the routing for the style; they can be changed for this order.</p>
                {live && can('production', 'edit') && (
                  <button type="button" className="btn-primary h-7 px-2.5 text-xs" disabled={!materialsIssued} title={materialsIssued ? undefined : 'Issue the materials first'} onClick={onLoadStages}>
                    <Route size={13} /> Set up stages
                  </button>
                )}
              </div>
            ),
          )}
          {step(
            3,
            false,
            'Process forms, by job card',
            !staged ? (
              'Once the stages are loaded, each colour gets its forms: cutting sheet first, then one for each stage to the last check.'
            ) : !cards.length ? (
              'No job cards yet.'
            ) : (
              <div className="mt-1 space-y-2">
                {cards.map((c) => (
                  <div key={c.id} className="border-border bg-card rounded-lg border p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-foreground text-sm">
                        <button type="button" className="text-primary font-mono text-xs hover:underline" onClick={() => setOpen({ kind: 'card', id: c.id })}>
                          {c.jobCardNumber}
                        </button>{' '}
                        <span className="font-medium">
                          {c.moLine.style.code} · {c.moLine.color}
                        </span>
                        {c.designNo ? <span className="text-muted-foreground"> · design {c.designNo}</span> : null}
                      </p>
                      <p className="text-muted-foreground text-xs tabular-nums">
                        {pcs(c.moLine.totalQty)} pcs · cut {pcs(c.cut)}
                        {c.withCutters ? ` (+${pcs(c.withCutters)} with cutters)` : ''} · packed {pcs(c.packed)}
                      </p>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {c.steps.map((s) => {
                        const f = s.figures
                        const here = f.inTransit + f.inHand + f.waiting + f.atVendor + f.inRework + f.damagedNow + f.rejectedNow
                        const doneIt = f.state === 'DONE'
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setOpen({ kind: 'sheet', id: c.id, stepId: s.id })}
                            className={`rounded-lg border px-2 py-1 text-left text-[11px] ${s.skippedAt ? 'opacity-50' : ''} ${
                              doneIt ? 'border-primary/50 bg-primary/5' : here ? 'border-primary' : 'border-border'
                            } hover:bg-secondary`}
                            title={`Open the ${s.name} sheet`}
                          >
                            <span className="text-foreground font-medium">
                              {s.sequence}. {s.name}
                            </span>
                            <span className="text-muted-foreground block tabular-nums">
                              {s.kind === 'CUTTING' ? `cut ${pcs(f.completed)}` : `in ${pcs(f.received)} · out ${pcs(s.kind === 'PACKING' ? f.packed + f.sentOn : f.sentOn)}`}
                              {here ? ` · ${pcs(here)} here` : ''}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ),
          )}
        </ol>
        {staged && (
          <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
            <ClipboardList size={13} /> The same sheets are on Production → Cutting Sheets, Stitching Sheets, Other Process Sheets and Quality Control; the handovers on Process Transfers.
          </p>
        )}
        {mo.heldAt && (
          <p className="warn-text mt-2 flex items-center gap-1.5 text-xs">
            <Circle size={10} /> On hold since {formatDate(mo.heldAt)}: nothing can be recorded on its sheets until it is resumed.
          </p>
        )}
      </Section>

      {open?.kind === 'card' && (
        <JobCardView
          jobCardId={open.id}
          onClose={() => {
            setOpen(null)
            void loadCards()
          }}
        />
      )}
      {open?.kind === 'sheet' && (
        <SheetView
          jobCardId={open.id}
          stepId={open.stepId}
          onClose={() => {
            setOpen(null)
            void loadCards()
            onChanged('')
          }}
        />
      )}
      {open?.kind === 'route' && flow && (
        <StagesDialog
          moId={flow.mo.id}
          moNumber={flow.mo.moNumber}
          styleIds={[]}
          flow={flow}
          onClose={() => setOpen(null)}
          onSaved={(m) => {
            setOpen(null)
            onChanged(m)
          }}
        />
      )}
      {open?.kind === 'hold' && (
        <ReasonDialog
          title={`Hold ${mo.moNumber}?`}
          description="Nothing can be recorded on its sheets until it is resumed. Its pieces stay where they are."
          confirmLabel="Hold it"
          placeholder="Buyer query on the collar"
          busy={busy}
          onCancel={() => setOpen(null)}
          onConfirm={(reason) => void post(`/production/orders/${mo.id}/hold`, { reason }, 'On hold.')}
        />
      )}
    </>
  )
}
