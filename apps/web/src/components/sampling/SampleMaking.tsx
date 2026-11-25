'use client'
import { useState } from 'react'
import { Clock3, Factory, Printer, type LucideIcon } from 'lucide-react'
import {
  cellKey,
  jobOutstanding,
  SAMPLE_REASON_MIN,
  type MakingCellKey,
  type MakingFigures,
  type MakingStep,
} from '@ld-erp/shared'
import { apiErrorMessage } from '@/lib/api'
import { formatDate, formatRupees } from '@/lib/utils'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { Field } from './SampleSpecEditor'
import {
  makingBlocker,
  makingOf,
  MAKING_UNDO_LABEL,
  stepFacts,
  stepStatus,
  stepTodos,
} from './samplingFlow'
import { plural } from './specRules'
import type {
  Lookups,
  SampleJobWork,
  SampleRequest,
  SampleRound,
  SampleStage,
  SampleTransfer,
} from './types'

/*
 * The Making section: the round's route, a card for each step with where its
 * pieces stand colour by colour and size by size, what to do there now, and
 * the records made at it. Each record is made in a window of its own; every
 * figure comes from the same ledger the server checks against (makingOf).
 */

type UndoKind = keyof typeof MAKING_UNDO_LABEL
type Open =
  | { kind: 'WORK'; stageId: string }
  | { kind: 'SEND'; fromStageId: string }
  | { kind: 'RECEIVE'; transferId: string }
  | { kind: 'JOB_SEND'; stageId: string }
  | { kind: 'JOB_RETURN'; jobWorkId: string }
  | { kind: 'LABOUR'; stageId: string }
  | { kind: 'CHARGE'; jobWorkId: string; returnId: string }
  | { kind: 'UNDO'; undo: UndoKind; id: string; what: string }

/** Today as the date box shows it. */
export const today = () => new Date().toLocaleDateString('en-CA')
const pieces = (n: number) => plural(n, 'piece')

export function SampleMaking({
  request,
  round,
  lookups,
  latest,
  canEdit,
  canCost,
  record,
  say,
}: {
  request: SampleRequest
  round: SampleRound
  lookups: Lookups
  /** The request's latest round: only it is made. */
  latest: boolean
  /** Sampling edit permission on an open request. */
  canEdit: boolean
  /** Sampling edit permission, cancelled or not: labour is recorded either way. */
  canCost: boolean
  /** One making action; throws the server's sentence when refused. */
  record: (action: string, data: unknown) => Promise<SampleRequest>
  /** What the page says once a record is saved. */
  say: (message: string) => void
}) {
  const [open, setOpen] = useState<Open | null>(null)
  const steps = makingOf(round)
  const sizeName = (id: string) => lookups.sizes.find((z) => z.id === id)?.code ?? 'Size no longer in use'
  const cellName = (c: MakingCellKey) => `${c.colour} · ${sizeName(c.sizeId)}`
  // Making is recorded on the latest released round until QC is recorded.
  // Nothing that costs is recorded while the costs are finalised (COST_FINAL).
  const costFinal = !!request.costFinalisedAt
  const making =
    canEdit && latest && round.state === 'RELEASED' && !round.qc && !request.cancelledAt && !costFinal
  const blocker = makingBlocker(round)
  // Labour, once its bill is known: on any released round until handover,
  // after a cancellation too (the server allows it), never on final costs.
  const costing = canCost && !request.rounds.some((r) => r.handover) && !costFinal
  const stageOf = (id: string) => round.stages.find((s) => s.id === id)
  const saved = async (action: string, data: unknown, message: (r: SampleRequest) => string) => {
    const updated = await record(action, data)
    setOpen(null)
    say(message(updated))
  }

  if (!round.stages.length)
    return <p>Release the specification to prepare its making route.</p>

  const openWindow = (() => {
    if (!open) return null
    const close = () => setOpen(null)
    switch (open.kind) {
      case 'WORK': {
        const i = round.stages.findIndex((s) => s.id === open.stageId)
        return (
          <WorkWindow
            stage={round.stages[i]}
            step={steps[i]}
            defaultBy={lookups.contractors.find((c) => c.id === round.stages[i].contractorId)?.name ?? ''}
            cellName={cellName}
            onClose={close}
            save={(d) =>
              saved('STEP_WORK', d, () => `Work at ${round.stages[i].name} recorded. The next action is shown below.`)
            }
          />
        )
      }
      case 'SEND': {
        const i = round.stages.findIndex((s) => s.id === open.fromStageId)
        const to = round.stages[i + 1]
        return (
          <SendWindow
            from={round.stages[i]}
            to={to}
            step={steps[i]}
            cellName={cellName}
            onClose={close}
            save={(d) =>
              saved('STEP_SEND', d, () =>
                (round.stages[i].departmentId ?? null) === (to.departmentId ?? null)
                  ? `Handed on to ${to.name}, and counted in there with it.`
                  : `Handed on to ${to.name}. They count the pieces in when they arrive.`
              )
            }
          />
        )
      }
      case 'RECEIVE': {
        const t = round.transfers.find((x) => x.id === open.transferId)!
        return (
          <ReceiveWindow
            transfer={t}
            from={stageOf(t.fromStageId)!}
            to={stageOf(t.toStageId)!}
            cellName={cellName}
            onClose={close}
            save={(d) => saved('STEP_RECEIVE', d, () => `Counted in at ${stageOf(t.toStageId)!.name}.`)}
          />
        )
      }
      case 'JOB_SEND': {
        const i = round.stages.findIndex((s) => s.id === open.stageId)
        return (
          <JobSendWindow
            stage={round.stages[i]}
            before={round.stages[i - 1]}
            step={steps[i]}
            lookups={lookups}
            cellName={cellName}
            onClose={close}
            save={(d) =>
              saved('JOB_SEND', d, (r) => {
                const job = r.rounds.find((x) => x.id === round.id)?.jobWorks.at(-1)
                return `Sent to ${job?.vendor?.name ?? 'the unit'} on ${job?.number ?? 'a job-work challan'}. Print the challan from ${round.stages[i].name} to go with the pieces.`
              })
            }
          />
        )
      }
      case 'JOB_RETURN': {
        const job = round.jobWorks.find((j) => j.id === open.jobWorkId)!
        return (
          <JobReturnWindow
            job={job}
            stage={stageOf(job.stageId)!}
            cellName={cellName}
            showCharge={round.stages.some((s) => s.labourAmount !== undefined)}
            onClose={close}
            save={(d) => saved('JOB_RETURN', d, () => `Recorded what came back on ${job.number}.`)}
          />
        )
      }
      case 'CHARGE': {
        const job = round.jobWorks.find((j) => j.id === open.jobWorkId)!
        const ret = job.returns.find((r) => r.id === open.returnId)!
        return (
          <ChargeWindow
            job={job}
            receivedOn={ret.receivedOn}
            charge={Number(ret.chargeAmount ?? 0)}
            onClose={close}
            save={(reason, chargeAmount) =>
              saved('JOB_CHARGE', { returnId: ret.id, chargeAmount, reason }, () => `The charge on ${job.number} is corrected.`)
            }
          />
        )
      }
      case 'LABOUR': {
        const stage = stageOf(open.stageId)!
        return (
          <LabourWindow
            stage={stage}
            onClose={close}
            save={(d) => saved('STEP_LABOUR', d, () => `Labour for ${stage.name} saved.`)}
          />
        )
      }
      case 'UNDO':
        return (
          <UndoWindow
            what={open.what}
            cancel={open.undo === 'JOB_SEND'}
            onClose={close}
            save={(reason) =>
              saved('MAKING_UNDO', { kind: open.undo, id: open.id, reason }, () =>
                open.undo === 'JOB_SEND' ? `${open.what} cancelled.` : `${open.what}: taken back.`
              )
            }
          />
        )
    }
  })()

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Each step works on the pieces the step before handed on, colour by colour and size by size.
        Work done on our floor is recorded at the step; a step done outside sends its pieces to the
        unit on a job-work challan and records what comes back. Sample pieces are not stock.
      </p>
      {making && blocker && (
        <p className="bg-muted/40 flex items-start gap-2 rounded-lg p-3 text-sm">
          <Clock3 size={15} className="mt-0.5 shrink-0" />
          {blocker}
        </p>
      )}
      {round.qc && (
        <p className="text-muted-foreground text-sm">
          QC is recorded on this round, so its making is closed.
        </p>
      )}
      {round.stages.map((stage, i) => (
        <StepCard
          key={stage.id}
          round={round}
          stage={stage}
          index={i}
          steps={steps}
          lookups={lookups}
          cellName={cellName}
          making={making}
          blocked={!!blocker && i === 0}
          costing={costing}
          onOpen={setOpen}
        />
      ))}
      {openWindow}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-medium">{value || '—'}</dd>
    </div>
  )
}
const STATUS_BADGE: Record<string, string> = {
  Done: 'badge-success',
  'Done, to hand on': 'badge-info',
  'Recorded whole': 'badge-success',
  'In progress': 'badge-warning',
  'Not started': 'badge-neutral',
}

function StepCard({
  round,
  stage,
  index,
  steps,
  lookups,
  cellName,
  making,
  blocked,
  costing,
  onOpen,
}: {
  round: SampleRound
  stage: SampleStage
  index: number
  steps: MakingStep[]
  lookups: Lookups
  cellName: (c: MakingCellKey) => string
  making: boolean
  /** The first step, waiting on material. */
  blocked: boolean
  costing: boolean
  onOpen: (o: Open) => void
}) {
  const step = steps[index]
  const f = stepFacts(stage, lookups)
  const next = round.stages[index + 1]
  const status = stepStatus(step, !!next)
  const todos = stepTodos(round, steps, index)
  const t = step.total
  const incoming = round.transfers.filter((x) => x.toStageId === stage.id && !x.undoneAt && !x.receivedOn)
  const jobs = round.jobWorks.filter((j) => j.stageId === stage.id)
  const charges = jobs
    .filter((j) => !j.cancelledAt)
    .flatMap((j) => j.returns.filter((r) => !r.undoneAt))
    .reduce((s, r) => s + Number(r.chargeAmount ?? 0), 0)
  const showLabour = stage.labourAmount !== undefined
  const labour = showLabour && (
    <Fact
      label={f.outside ? 'Labour · unit’s charges' : 'Labour'}
      value={
        f.outside
          ? `${formatRupees(+(stage.labourAmount ?? 0))} · ${formatRupees(charges)}`
          : formatRupees(+(stage.labourAmount ?? 0))
      }
    />
  )
  // Only work at the first step, and sending its pieces out from the grid, wait on
  // material (STEP_WORK, JOB_SEND); pieces already made go on regardless.
  const canRecord = making && !step.wholeStep
  const canWork = canRecord && !blocked
  return (
    <div className="glass-card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          {stage.sequence}. {stage.name}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className={f.outside ? 'badge-purple' : 'badge-neutral'}>{f.doneAt}</span>
          <span className={STATUS_BADGE[status]}>{status}</span>
        </div>
      </div>
      {f.process ? (
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Process" value={f.process} />
          <Fact label="Department" value={f.department || 'Not set'} />
          <Fact label={f.outside ? 'Outside unit' : 'Contractor'} value={f.who} />
          {labour}
          {f.instructions && (
            <div className="sm:col-span-2 lg:col-span-4">
              <Fact label="Instructions" value={f.instructions} />
            </div>
          )}
        </dl>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            Released before routes named a process: the step’s name is its record.
          </p>
          {labour && <dl>{labour}</dl>}
        </>
      )}

      {step.wholeStep ? (
        <p className="text-sm">
          Recorded whole before work was recorded by colour and size: {stage.doneQty ?? 0} done ·{' '}
          {stage.rejectedQty ?? 0} rejected
          {stage.responsible ? ` · ${stage.responsible}` : ''}
          {stage.completedAt ? ` · ${formatDate(stage.completedAt)}` : ''}
          {stage.notes ? ` · ${stage.notes}` : ''}
        </p>
      ) : step.started || step.total.toSend > 0 ? (
        <CellTable step={step} cellName={cellName} />
      ) : (
        <p className="text-muted-foreground text-sm">
          {index === 0 ? 'Nothing recorded yet.' : `Waiting for pieces from ${round.stages[index - 1].name}.`}
        </p>
      )}

      {/* Said to whoever can act on it; to anyone else the table says where it stands. */}
      {making && todos.length > 0 && (
        <div className="bg-muted/40 rounded-lg p-3 text-sm">
          <span className="font-medium">What to do now: </span>
          {todos.map((x) => x.text).join(' ')}
        </div>
      )}
      {step.complete && !step.wholeStep && (
        <p className="text-muted-foreground text-sm">
          {!next
            ? `Done: ${pieces(t.done)} finished${t.rejected ? `, ${t.rejected} rejected` : ''}, ready for QC.`
            : t.ready > 0
              ? `Every piece that reached it is worked: ${t.done} done${t.rejected ? `, ${t.rejected} rejected` : ''}; ${t.ready} still to go on to ${next.name}.`
              : `Done: ${pieces(t.done)}${t.rejected ? `, ${t.rejected} rejected` : ''}, handed on to ${next.name}.`}
          {stage.completedAt && !(next && t.ready > 0) ? ` ${formatDate(stage.completedAt)}.` : ''}
        </p>
      )}
      {making && blocked && (
        <p className="text-muted-foreground text-xs">
          Issue the material in Material preparation first, or mark what is not needed.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {canWork && !step.outside && t.here > 0 && (
          <button type="button" className="btn-primary" onClick={() => onOpen({ kind: 'WORK', stageId: stage.id })}>
            Record work
          </button>
        )}
        {making &&
          incoming.map((x) => (
            <button
              key={x.id}
              type="button"
              className="btn-primary"
              onClick={() => onOpen({ kind: 'RECEIVE', transferId: x.id })}
            >
              Count in {pieces(x.cells.reduce((s, c) => s + c.qty, 0))} from{' '}
              {round.stages.find((s) => s.id === x.fromStageId)?.name}
            </button>
          ))}
        {canRecord && t.ready > 0 && next && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              onOpen(
                next.execution === 'OUTSOURCED'
                  ? { kind: 'JOB_SEND', stageId: next.id }
                  : { kind: 'SEND', fromStageId: stage.id }
              )
            }
          >
            {next.execution === 'OUTSOURCED' ? `Send out for ${next.name}` : `Hand on to ${next.name}`}
          </button>
        )}
        {(index === 0 ? canWork : canRecord) && step.outside && t.toSend > 0 && (
          <button type="button" className="btn-primary" onClick={() => onOpen({ kind: 'JOB_SEND', stageId: stage.id })}>
            Send out to the unit
          </button>
        )}
        {making &&
          jobs
            .filter((j) => !j.cancelledAt && jobOutstanding(j).some((c) => c.out > 0))
            .map((j) => (
              <button
                key={j.id}
                type="button"
                className="btn-primary"
                onClick={() => onOpen({ kind: 'JOB_RETURN', jobWorkId: j.id })}
              >
                Receive from {j.vendor?.name ?? 'the unit'} ({j.number})
              </button>
            ))}
        {costing && showLabour && (
          <button type="button" className="btn-ghost" onClick={() => onOpen({ kind: 'LABOUR', stageId: stage.id })}>
            {Number(stage.labourAmount) > 0 ? 'Change labour' : 'Enter labour'}
          </button>
        )}
      </div>

      <StepRecords
        round={round}
        stage={stage}
        jobs={jobs}
        cellName={cellName}
        making={making}
        costing={costing}
        showCharge={showLabour}
        onOpen={onOpen}
      />
    </div>
  )
}

/** Where each colour and size stands at the step. */
function CellTable({ step, cellName }: { step: MakingStep; cellName: (c: MakingCellKey) => string }) {
  type Column = [string, keyof MakingFigures]
  // A column only when something is in it: short and on-the-way are rare.
  const some = (k: keyof MakingFigures) => step.cells.some((c) => c[k] > 0)
  const cols: Column[] = step.outside
    ? (
        [
          ['To go out', 'toSend'],
          ['Sent out', 'received'],
          ['With unit', 'atUnit'],
          ['Accepted', 'done'],
          ['Rejected', 'rejected'],
          ['Handed on', 'sentOn'],
        ] as Column[]
      ).filter(([, k]) => k !== 'toSend' || some(k))
    : (
        [
          ['Arrived', 'received'],
          ['On the way', 'coming'],
          ['Short', 'short'],
          ['Done', 'done'],
          ['Rejected', 'rejected'],
          ['Here', 'here'],
          ['Handed on', 'sentOn'],
        ] as Column[]
      ).filter(([, k]) => (k === 'coming' || k === 'short' ? some(k) : true))
  return (
    <div className="overflow-x-auto">
      <table className="data-table w-full">
        <thead>
          <tr>
            <th>Colour · size</th>
            {cols.map(([head]) => (
              <th key={head} className="text-right">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {step.cells.map((c) => (
            <tr key={cellKey(c)}>
              <td>{cellName(c)}</td>
              {cols.map(([head, k]) => (
                <td key={head} className="text-right tabular-nums">
                  {c[k] || '—'}
                </td>
              ))}
            </tr>
          ))}
          {step.cells.length > 1 && (
            <tr className="font-semibold">
              <td>All</td>
              {cols.map(([head, k]) => (
                <td key={head} className="text-right tabular-nums">
                  {step.total[k] || '—'}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** What was recorded at the step, oldest first, each with its undo while making is open. */
function StepRecords({
  round,
  stage,
  jobs,
  cellName,
  making,
  costing,
  showCharge,
  onOpen,
}: {
  round: SampleRound
  stage: SampleStage
  jobs: SampleJobWork[]
  cellName: (c: MakingCellKey) => string
  making: boolean
  /** A unit's charge may be put right (JOB_CHARGE). */
  costing: boolean
  showCharge: boolean
  onOpen: (o: Open) => void
}) {
  const name = (id: string) => round.stages.find((s) => s.id === id)?.name ?? 'the next step'
  const cellsText = (cells: Array<MakingCellKey & { qty: number }>) =>
    cells.filter((c) => c.qty > 0).map((c) => `${cellName(c)} ${c.qty}`).join(', ')
  type Row = { key: string; at: string; text: string; gone: string | null; undo?: Open; extra?: React.ReactNode }
  const rows: Row[] = []
  for (const w of round.works.filter((x) => x.stageId === stage.id)) {
    const done = w.cells.reduce((s, c) => s + c.done, 0)
    const rejected = w.cells.reduce((s, c) => s + c.rejected, 0)
    rows.push({
      key: w.id,
      at: w.createdAt,
      text: `${formatDate(w.workedOn)} · Work: ${done} done${rejected ? `, ${rejected} rejected` : ''} by ${w.doneBy} (${w.cells
        .map(
          (c) =>
            `${cellName(c)}: ${[c.done ? `${c.done} done` : '', c.rejected ? `${c.rejected} rejected` : '']
              .filter(Boolean)
              .join(', ')}`
        )
        .join('; ')})${w.notes ? ` · ${w.notes}` : ''}`,
      gone: w.undoneAt ? `taken back: ${w.undoneReason}` : null,
      undo: { kind: 'UNDO', undo: 'WORK', id: w.id, what: `Work at ${stage.name} by ${w.doneBy}` },
    })
  }
  for (const x of round.transfers.filter((t) => t.fromStageId === stage.id)) rows.push(transferRow(x))
  function transferRow(x: SampleTransfer): Row {
    const sent = x.cells.reduce((s, c) => s + c.qty, 0)
    const got = x.receivedCells?.reduce((s, c) => s + c.qty, 0)
    return {
      key: x.id,
      at: x.createdAt,
      text: `${formatDate(x.sentOn)} · Handed on to ${name(x.toStageId)}: ${pieces(sent)} by ${x.sentBy} (${cellsText(x.cells)}) · ${
        x.receivedOn
          ? `counted in ${formatDate(x.receivedOn)} by ${x.receivedBy}${got !== sent ? `, ${sent - (got ?? 0)} short: ${x.shortReason}` : ''}`
          : 'not counted in yet'
      }`,
      gone: x.undoneAt ? `taken back: ${x.undoneReason}` : null,
      undo: { kind: 'UNDO', undo: 'TRANSFER', id: x.id, what: `Hand-on to ${name(x.toStageId)} of ${pieces(sent)}` },
    }
  }
  for (const j of jobs) {
    const sent = j.cells.reduce((s, c) => s + c.qty, 0)
    rows.push({
      key: j.id,
      at: j.createdAt,
      text: `${j.number} · ${formatDate(j.sentOn)} · ${pieces(sent)} to ${j.vendor?.name ?? 'the unit'} by ${j.sentBy} (${cellsText(j.cells)})${
        j.expectedBack ? ` · due back ${formatDate(j.expectedBack)}` : ''
      }`,
      gone: j.cancelledAt ? `cancelled: ${j.cancelReason}` : null,
      undo: j.returns.some((r) => !r.undoneAt)
        ? undefined
        : { kind: 'UNDO', undo: 'JOB_SEND', id: j.id, what: `Challan ${j.number}` },
      extra: (
        <a
          className="btn-ghost text-xs"
          href={`/print/sample-job-work/${j.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Printer size={13} /> Challan
        </a>
      ),
    })
    for (const r of j.returns) {
      const accepted = r.cells.reduce((s, c) => s + c.accepted, 0)
      const rejected = r.cells.reduce((s, c) => s + c.rejected, 0)
      rows.push({
        key: r.id,
        at: r.createdAt,
        text: `${j.number} · ${formatDate(r.receivedOn)} · Back: ${accepted} accepted${rejected ? `, ${rejected} rejected` : ''}${
          r.theirChallanNo ? ` · their challan ${r.theirChallanNo}` : ''
        }${showCharge && r.chargeAmount !== undefined && Number(r.chargeAmount) > 0 ? ` · charged ${formatRupees(+r.chargeAmount)}` : ''}${
          r.notes ? ` · ${r.notes}` : ''
        }`,
        gone: r.undoneAt ? `taken back: ${r.undoneReason}` : null,
        undo: { kind: 'UNDO', undo: 'JOB_RETURN', id: r.id, what: `Receipt on ${j.number} from ${j.vendor?.name ?? 'the unit'}` },
        extra:
          costing && showCharge && !r.undoneAt && !j.cancelledAt ? (
            <button
              type="button"
              className="btn-ghost text-xs"
              aria-label={`Change the charge on ${j.number}, ${formatDate(r.receivedOn)}`}
              onClick={() => onOpen({ kind: 'CHARGE', jobWorkId: j.id, returnId: r.id })}
            >
              Change charge
            </button>
          ) : undefined,
      })
    }
  }
  if (!rows.length) return null
  rows.sort((a, b) => a.at.localeCompare(b.at))
  return (
    <details className="text-sm" open={!round.stages.find((s) => s.id === stage.id)?.completedAt}>
      <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
        Records at this step ({rows.filter((r) => !r.gone).length})
      </summary>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center justify-between gap-2">
            <span className={r.gone ? 'text-muted-foreground line-through' : ''}>{r.text}</span>
            <span className="flex items-center gap-1">
              {r.gone && <span className="text-muted-foreground text-xs">{r.gone}</span>}
              {r.extra}
              {making && !r.gone && r.undo && (
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  aria-label={`${undoWord(r.undo)}: ${r.undo.kind === 'UNDO' ? r.undo.what : ''}`}
                  onClick={() => onOpen(r.undo!)}
                >
                  {undoWord(r.undo)}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** A challan is cancelled; any other record is taken back. */
const undoWord = (o: Open) => (o.kind === 'UNDO' && o.undo === 'JOB_SEND' ? 'Cancel' : 'Take back')

// ── Windows ───────────────────────────────────────────────────────────────────

/** A making window: fields first, the main button in its footer, Ctrl+S to save. */
export function MakingWindow({
  id,
  title,
  subtitle,
  submit,
  note,
  busy,
  error,
  onClose,
  onSubmit,
  width = 'max-w-3xl',
  icon = Factory,
  closeLabel = 'Cancel',
  children,
}: {
  id: string
  title: string
  subtitle: string
  submit: string
  note: string
  busy: boolean
  error: string
  onClose: () => void
  onSubmit: () => void
  width?: string
  icon?: LucideIcon
  /** The footer's close button; 'Keep it' where Cancel would be the window's own action. */
  closeLabel?: string
  children: React.ReactNode
}) {
  return (
    <FormFrame
      icon={icon}
      title={title}
      subtitle={subtitle}
      width={width}
      primaryInHeader={false}
      busy={busy}
      error={error}
      onClose={onClose}
      primary={
        <button type="submit" form={id} className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : submit}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          {closeLabel}
        </button>
      }
      footerNote={note}
    >
      <form
        id={id}
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onSubmit()
        }}
      >
        <fieldset disabled={busy} className="space-y-4 p-2">
          {children}
        </fieldset>
      </form>
    </FormFrame>
  )
}

/** Saving a window: busy while it goes, the server's sentence where it was typed. */
export function useSave() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (problem: string, go: () => Promise<void>) => {
    if (problem) return setError(problem)
    setBusy(true)
    setError('')
    try {
      await go()
    } catch (e) {
      setError(e instanceof Error ? e.message : apiErrorMessage(e))
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** One row per colour and size, with a number box for each column. */
export function CellInputs({
  rows,
  columns,
  values,
  onChange,
}: {
  rows: Array<{ key: string; label: string; hint: string; max?: number }>
  columns: Array<{ key: string; head: string }>
  values: Record<string, Record<string, string>>
  onChange: (row: string, col: string, value: string) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table w-full">
        <thead>
          <tr>
            <th>Colour · size</th>
            {columns.map((c) => (
              <th key={c.key} className="text-right">
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <span className="font-medium">{r.label}</span>
                <span className="text-muted-foreground block text-xs">{r.hint}</span>
              </td>
              {columns.map((c) => (
                <td key={c.key} className="w-32">
                  <StepInput
                    className="form-input h-9 text-right"
                    aria-label={`${c.head}, ${r.label}`}
                    max={r.max}
                    value={values[r.key]?.[c.key] ?? ''}
                    onValueChange={(v) => onChange(r.key, c.key, v)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
export const num = (v: string | undefined) => (v === undefined || v === '' ? 0 : Number(v))
export const whole = (v: number) => Number.isInteger(v) && v >= 0
/**
 * The boxes of a window, cell by cell. With `split`, what is typed as rejected
 * comes off the first column (done, accepted) up to the cell's pieces, so the
 * two never add up to more than are there.
 */
export function useGrid(
  initial: Record<string, Record<string, string>>,
  split?: { from: string; rejected: string; max: (row: string) => number }
) {
  const [values, setValues] = useState(initial)
  const set = (row: string, col: string, v: string) =>
    setValues((was) => {
      const next = { ...was[row], [col]: v }
      if (split && col === split.rejected)
        next[split.from] = String(Math.max(0, split.max(row) - (v === '' ? 0 : Number(v) || 0)))
      return { ...was, [row]: next }
    })
  return { values, set }
}
export const DateField = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
  <Field label={label} required>
    <input className="form-input" type="date" max={today()} value={value} onChange={(e) => onChange(e.target.value)} />
  </Field>
)

function WorkWindow({
  stage,
  step,
  defaultBy,
  cellName,
  onClose,
  save,
}: {
  stage: SampleStage
  step: MakingStep
  defaultBy: string
  cellName: (c: MakingCellKey) => string
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  const cells = step.cells.filter((c) => c.here > 0)
  const grid = useGrid(Object.fromEntries(cells.map((c) => [cellKey(c), { done: String(c.here), rejected: '' }])), {
    from: 'done',
    rejected: 'rejected',
    max: (row) => cells.find((c) => cellKey(c) === row)?.here ?? 0,
  })
  const [doneBy, setDoneBy] = useState(defaultBy)
  const [on, setOn] = useState(today())
  const [notes, setNotes] = useState('')
  const s = useSave()
  const rows = cells.map((c) => {
    const v = grid.values[cellKey(c)] ?? {}
    return { c, done: num(v.done), rejected: num(v.rejected) }
  })
  const rejected = rows.reduce((t, r) => t + r.rejected, 0)
  const submit = () =>
    s.run(
      rows.some((r) => !whole(r.done) || !whole(r.rejected))
        ? 'Pieces are whole numbers.'
        : rows.find((r) => r.done + r.rejected > r.c.here)
          ? `Only ${rows.find((r) => r.done + r.rejected > r.c.here)!.c.here} of ${cellName(rows.find((r) => r.done + r.rejected > r.c.here)!.c)} are here.`
          : !rows.some((r) => r.done + r.rejected > 0)
            ? 'Say how many pieces were done or rejected.'
            : !doneBy.trim()
              ? 'Say who did the work.'
              : rejected > 0 && notes.trim().length < SAMPLE_REASON_MIN
                ? 'Say what was wrong with the rejected pieces.'
                : '',
      () =>
        save({
          stageId: stage.id,
          cells: rows
            .filter((r) => r.done + r.rejected > 0)
            .map((r) => ({ colour: r.c.colour, sizeId: r.c.sizeId, done: r.done, rejected: r.rejected })),
          doneBy: doneBy.trim(),
          workedOn: on || undefined,
          notes: notes.trim(),
        })
    )
  return (
    <MakingWindow
      id="sample-work-form"
      title={`Record work · ${stage.name}`}
      subtitle={`${pieces(step.total.here)} here to work on`}
      submit="Save work"
      note="Done pieces wait here until they are handed on. Rejected pieces leave the sample."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Done by" required hint="The tailor, cutter or contractor’s man.">
          <input className="form-input" maxLength={100} value={doneBy} autoFocus onChange={(e) => setDoneBy(e.target.value)} />
        </Field>
        <DateField label="Date" value={on} onChange={setOn} />
      </div>
      <CellInputs
        rows={cells.map((c) => ({ key: cellKey(c), label: cellName(c), hint: `${c.here} here`, max: c.here }))}
        columns={[
          { key: 'done', head: 'Done' },
          { key: 'rejected', head: 'Rejected' },
        ]}
        values={grid.values}
        onChange={grid.set}
      />
      <Field label={rejected > 0 ? 'What was wrong with the rejected pieces' : 'Note (optional)'} required={rejected > 0}>
        <textarea className="form-input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

function SendWindow({
  from,
  to,
  step,
  cellName,
  onClose,
  save,
}: {
  from: SampleStage
  to: SampleStage
  step: MakingStep
  cellName: (c: MakingCellKey) => string
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  const cells = step.cells.filter((c) => c.ready > 0)
  const grid = useGrid(Object.fromEntries(cells.map((c) => [cellKey(c), { qty: String(c.ready) }])))
  const [by, setBy] = useState('')
  const [on, setOn] = useState(today())
  const [notes, setNotes] = useState('')
  const s = useSave()
  const rows = cells.map((c) => ({ c, qty: num(grid.values[cellKey(c)]?.qty) }))
  const sameDepartment = (from.departmentId ?? null) === (to.departmentId ?? null)
  const submit = () =>
    s.run(
      rows.some((r) => !whole(r.qty))
        ? 'Pieces are whole numbers.'
        : rows.find((r) => r.qty > r.c.ready)
          ? `Only ${rows.find((r) => r.qty > r.c.ready)!.c.ready} of ${cellName(rows.find((r) => r.qty > r.c.ready)!.c)} are done here.`
          : !rows.some((r) => r.qty > 0)
            ? 'Say how many pieces go on.'
            : !by.trim()
              ? 'Say who is handing them on.'
              : '',
      () =>
        save({
          fromStageId: from.id,
          cells: rows.filter((r) => r.qty > 0).map((r) => ({ colour: r.c.colour, sizeId: r.c.sizeId, qty: r.qty })),
          sentBy: by.trim(),
          sentOn: on || undefined,
          notes: notes.trim(),
        })
    )
  return (
    <MakingWindow
      id="sample-send-form"
      title={`Hand on to ${to.name}`}
      subtitle={`From ${from.name} · ${pieces(step.total.ready)} done here`}
      submit="Hand on"
      note={
        !sameDepartment
          ? `${to.name} counts the pieces in when they arrive.`
          : from.departmentId
            ? `${to.name} is the same department: the pieces are counted in there at once.`
            : `Neither step names a department, so the pieces are counted in at ${to.name} at once.`
      }
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Handed on by" required>
          <input className="form-input" maxLength={100} value={by} autoFocus onChange={(e) => setBy(e.target.value)} />
        </Field>
        <DateField label="Date" value={on} onChange={setOn} />
      </div>
      <CellInputs
        rows={cells.map((c) => ({ key: cellKey(c), label: cellName(c), hint: `${c.ready} done here`, max: c.ready }))}
        columns={[{ key: 'qty', head: 'Pieces' }]}
        values={grid.values}
        onChange={grid.set}
      />
      <Field label="Note (optional)">
        <input className="form-input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

function ReceiveWindow({
  transfer,
  from,
  to,
  cellName,
  onClose,
  save,
}: {
  transfer: SampleTransfer
  from: SampleStage
  to: SampleStage
  cellName: (c: MakingCellKey) => string
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  const grid = useGrid(Object.fromEntries(transfer.cells.map((c) => [cellKey(c), { qty: String(c.qty) }])))
  const [by, setBy] = useState('')
  const [on, setOn] = useState(today())
  const [reason, setReason] = useState('')
  const s = useSave()
  const rows = transfer.cells.map((c) => ({ c, qty: num(grid.values[cellKey(c)]?.qty) }))
  const short = rows.reduce((t, r) => t + Math.max(0, r.c.qty - r.qty), 0)
  const submit = () =>
    s.run(
      rows.some((r) => !whole(r.qty))
        ? 'Pieces are whole numbers.'
        : rows.find((r) => r.qty > r.c.qty)
          ? `Only ${rows.find((r) => r.qty > r.c.qty)!.c.qty} of ${cellName(rows.find((r) => r.qty > r.c.qty)!.c)} were sent.`
          : !by.trim()
            ? 'Say who counted them in.'
            : short > 0 && reason.trim().length < SAMPLE_REASON_MIN
              ? 'Say why fewer pieces arrived than were sent.'
              : '',
      () =>
        save({
          transferId: transfer.id,
          cells: rows.map((r) => ({ colour: r.c.colour, sizeId: r.c.sizeId, qty: r.qty })),
          receivedBy: by.trim(),
          receivedOn: on || undefined,
          shortReason: short > 0 ? reason.trim() : '',
        })
    )
  return (
    <MakingWindow
      id="sample-receive-form"
      title={`Count in at ${to.name}`}
      subtitle={`From ${from.name} · sent ${formatDate(transfer.sentOn)} by ${transfer.sentBy}`}
      submit="Count in"
      note="Count what arrived. Fewer than were sent is recorded as short, with the reason."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Counted in by" required>
          <input className="form-input" maxLength={100} value={by} autoFocus onChange={(e) => setBy(e.target.value)} />
        </Field>
        <DateField label="Date" value={on} onChange={setOn} />
      </div>
      <CellInputs
        rows={transfer.cells.map((c) => ({ key: cellKey(c), label: cellName(c), hint: `${c.qty} sent`, max: c.qty }))}
        columns={[{ key: 'qty', head: 'Arrived' }]}
        values={grid.values}
        onChange={grid.set}
      />
      {short > 0 && (
        <Field label={`Why ${pieces(short)} did not arrive`} required>
          <input className="form-input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
    </MakingWindow>
  )
}

function JobSendWindow({
  stage,
  before,
  step,
  lookups,
  cellName,
  onClose,
  save,
}: {
  stage: SampleStage
  before: SampleStage | undefined
  step: MakingStep
  lookups: Lookups
  cellName: (c: MakingCellKey) => string
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  const cells = step.cells.filter((c) => c.toSend > 0)
  const grid = useGrid(Object.fromEntries(cells.map((c) => [cellKey(c), { qty: String(c.toSend) }])))
  // The route's unit, while it is still in use; otherwise one is picked.
  const [vendorId, setVendorId] = useState(
    lookups.jobWorkers.some((v) => v.id === stage.vendorId) ? (stage.vendorId ?? '') : ''
  )
  const [by, setBy] = useState('')
  const [on, setOn] = useState(today())
  const [due, setDue] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [value, setValue] = useState('')
  const [notes, setNotes] = useState('')
  const s = useSave()
  const rows = cells.map((c) => ({ c, qty: num(grid.values[cellKey(c)]?.qty) }))
  const submit = () =>
    s.run(
      !vendorId
        ? 'Pick the outside unit.'
        : rows.some((r) => !whole(r.qty))
          ? 'Pieces are whole numbers.'
          : rows.find((r) => r.qty > r.c.toSend)
            ? `Only ${rows.find((r) => r.qty > r.c.toSend)!.c.toSend} of ${cellName(rows.find((r) => r.qty > r.c.toSend)!.c)} can go out.`
            : !rows.some((r) => r.qty > 0)
              ? 'Say how many pieces go out.'
              : !by.trim()
                ? 'Say who is sending them.'
                : due && due < on
                  ? 'The day it is due back is before it goes out.'
                  : value !== '' && !(Number(value) >= 0)
                    ? 'The declared value is a sum in rupees.'
                    : '',
      () =>
        save({
          stageId: stage.id,
          vendorId,
          cells: rows.filter((r) => r.qty > 0).map((r) => ({ colour: r.c.colour, sizeId: r.c.sizeId, qty: r.qty })),
          sentBy: by.trim(),
          sentOn: on || undefined,
          expectedBack: due || null,
          vehicleNo: vehicle.trim(),
          declaredValue: value === '' ? null : Math.round(Number(value) * 100) / 100,
          notes: notes.trim(),
        })
    )
  return (
    <MakingWindow
      id="sample-job-send-form"
      title={`Send out for ${stage.name}`}
      subtitle={before ? `Done at ${before.name}: ${pieces(step.total.toSend)}` : `${pieces(step.total.toSend)} to go out`}
      submit="Send on a challan"
      note="Numbered from the job-work series. Print the challan to go with the pieces; no stock moves."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
      width="max-w-4xl"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Outside unit" required>
          <SmartSelect className="form-input" value={vendorId} autoFocus onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Pick the unit</option>
            {lookups.jobWorkers.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </SmartSelect>
        </Field>
        <Field label="Sent by" required>
          <input className="form-input" maxLength={100} value={by} onChange={(e) => setBy(e.target.value)} />
        </Field>
        <DateField label="Date sent" value={on} onChange={setOn} />
        <Field label="Due back (optional)">
          <input className="form-input" type="date" min={on} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="Vehicle no. (optional)">
          <input className="form-input" maxLength={30} value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
        </Field>
        <Field label="Declared value, ₹ (optional)" hint="Left empty, the challan says the pieces have no commercial value.">
          <StepInput className="form-input" decimals value={value} onValueChange={setValue} />
        </Field>
      </div>
      <CellInputs
        rows={cells.map((c) => ({ key: cellKey(c), label: cellName(c), hint: `${c.toSend} can go`, max: c.toSend }))}
        columns={[{ key: 'qty', head: 'Pieces' }]}
        values={grid.values}
        onChange={grid.set}
      />
      <Field label="Note (optional)">
        <input className="form-input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

function JobReturnWindow({
  job,
  stage,
  cellName,
  showCharge,
  onClose,
  save,
}: {
  job: SampleJobWork
  stage: SampleStage
  cellName: (c: MakingCellKey) => string
  /** Charges are entered by those who see them. */
  showCharge: boolean
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  const out = jobOutstanding(job).filter((c) => c.out > 0)
  const grid = useGrid(Object.fromEntries(out.map((c) => [cellKey(c), { accepted: String(c.out), rejected: '' }])), {
    from: 'accepted',
    rejected: 'rejected',
    max: (row) => out.find((c) => cellKey(c) === row)?.out ?? 0,
  })
  const [by, setBy] = useState('')
  const [on, setOn] = useState(today())
  const [theirs, setTheirs] = useState('')
  const [charge, setCharge] = useState('')
  const [notes, setNotes] = useState('')
  const s = useSave()
  const rows = out.map((c) => {
    const v = grid.values[cellKey(c)] ?? {}
    return { c, accepted: num(v.accepted), rejected: num(v.rejected) }
  })
  const rejected = rows.reduce((t, r) => t + r.rejected, 0)
  const submit = () =>
    s.run(
      rows.some((r) => !whole(r.accepted) || !whole(r.rejected))
        ? 'Pieces are whole numbers.'
        : rows.find((r) => r.accepted + r.rejected > r.c.out)
          ? `Only ${rows.find((r) => r.accepted + r.rejected > r.c.out)!.c.out} of ${cellName(rows.find((r) => r.accepted + r.rejected > r.c.out)!.c)} are still out.`
          : !rows.some((r) => r.accepted + r.rejected > 0)
            ? 'Say how many pieces came back.'
            : !by.trim()
              ? 'Say who received them.'
              : charge !== '' && !(Number(charge) >= 0)
                ? 'The charge is a sum in rupees.'
                : rejected > 0 && notes.trim().length < SAMPLE_REASON_MIN
                  ? 'Say what was wrong with the rejected pieces, or that they did not come back.'
                  : '',
      () =>
        save({
          jobWorkId: job.id,
          cells: rows
            .filter((r) => r.accepted + r.rejected > 0)
            .map((r) => ({ colour: r.c.colour, sizeId: r.c.sizeId, accepted: r.accepted, rejected: r.rejected })),
          receivedBy: by.trim(),
          receivedOn: on || undefined,
          theirChallanNo: theirs.trim(),
          chargeAmount: charge === '' ? 0 : Math.round(Number(charge) * 100) / 100,
          notes: notes.trim(),
        })
    )
  return (
    <MakingWindow
      id="sample-job-return-form"
      title={`Receive from ${job.vendor?.name ?? 'the unit'}`}
      subtitle={`${job.number} · ${stage.name} · sent ${formatDate(job.sentOn)}`}
      submit="Save receipt"
      note="Accepted pieces wait at this step to be handed on. Rejected covers pieces spoilt or not returned."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Received by" required>
          <input className="form-input" maxLength={100} value={by} autoFocus onChange={(e) => setBy(e.target.value)} />
        </Field>
        <DateField label="Date" value={on} onChange={setOn} />
        <Field label="Their challan no. (optional)">
          <input className="form-input" maxLength={50} value={theirs} onChange={(e) => setTheirs(e.target.value)} />
        </Field>
        {showCharge && (
          <Field label="Their charge, ₹ (optional)" hint="For the pieces back on this receipt.">
            <StepInput className="form-input" decimals value={charge} onValueChange={setCharge} />
          </Field>
        )}
      </div>
      <CellInputs
        rows={out.map((c) => ({ key: cellKey(c), label: cellName(c), hint: `${c.out} still out`, max: c.out }))}
        columns={[
          { key: 'accepted', head: 'Accepted' },
          { key: 'rejected', head: 'Rejected' },
        ]}
        values={grid.values}
        onChange={grid.set}
      />
      <Field label={rejected > 0 ? 'What was wrong with the rejected pieces' : 'Note (optional)'} required={rejected > 0}>
        <textarea className="form-input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

function ChargeWindow({
  job,
  receivedOn,
  charge,
  onClose,
  save,
}: {
  job: SampleJobWork
  receivedOn: string
  charge: number
  onClose: () => void
  save: (reason: string, chargeAmount: number) => Promise<void>
}) {
  const [amount, setAmount] = useState(charge > 0 ? String(charge) : '')
  const [reason, setReason] = useState('')
  const s = useSave()
  const submit = () =>
    s.run(amount !== '' && !(Number(amount) >= 0) ? 'The charge is a sum in rupees.' : '', () =>
      save(reason.trim(), amount === '' ? 0 : Math.round(Number(amount) * 100) / 100)
    )
  return (
    <MakingWindow
      id="sample-charge-form"
      title={`Charge · ${job.number}`}
      subtitle={`${job.vendor?.name ?? 'The unit'} · back ${formatDate(receivedOn)}`}
      submit="Save charge"
      note="Only the charge changes; the pieces on the receipt stay as they are."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
      width="max-w-xl"
    >
      <Field label="Their charge, ₹" required>
        <StepInput className="form-input" decimals autoFocus value={amount} onValueChange={setAmount} />
      </Field>
      <Field label="Why it changed (optional)" hint="Their bill came, a rate was agreed…">
        <input className="form-input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

function LabourWindow({
  stage,
  onClose,
  save,
}: {
  stage: SampleStage
  onClose: () => void
  save: (d: unknown) => Promise<void>
}) {
  const [amount, setAmount] = useState(Number(stage.labourAmount) > 0 ? String(Number(stage.labourAmount)) : '')
  const [note, setNote] = useState(stage.labourNote ?? '')
  const s = useSave()
  const submit = () =>
    s.run(amount !== '' && !(Number(amount) >= 0) ? 'The labour is a sum in rupees.' : '', () =>
      save({
        stageId: stage.id,
        amount: amount === '' ? 0 : Math.round(Number(amount) * 100) / 100,
        note: note.trim(),
      })
    )
  return (
    <MakingWindow
      id="sample-labour-form"
      title={`Labour · ${stage.name}`}
      subtitle="What this step’s labour cost the sample"
      submit="Save labour"
      note="Goes into the sample’s cost. An outside unit’s charge is entered when its pieces come back."
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
      width="max-w-xl"
    >
      <Field label="Labour, ₹" required>
        <StepInput className="form-input" decimals autoFocus value={amount} onValueChange={setAmount} />
      </Field>
      <Field label="Note (optional)" hint="Who was paid.">
        <input className="form-input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}

function UndoWindow({
  what,
  cancel,
  onClose,
  save,
}: {
  what: string
  /** A challan: it is cancelled, and its number stays used. */
  cancel: boolean
  onClose: () => void
  save: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const s = useSave()
  const submit = () =>
    s.run(reason.trim().length < SAMPLE_REASON_MIN ? 'Say why, in a few words.' : '', () => save(reason.trim()))
  return (
    <MakingWindow
      id="sample-undo-form"
      title={cancel ? 'Cancel the challan' : 'Take back a making record'}
      subtitle={what}
      submit={cancel ? 'Cancel challan' : 'Take back'}
      note={
        cancel
          ? 'The challan stays on record, marked cancelled, and its number is not used again. Its pieces count as not sent.'
          : 'The record stays in the history, marked taken back; its pieces go back where they were.'
      }
      busy={s.busy}
      error={s.error}
      onClose={onClose}
      onSubmit={() => void submit()}
      width="max-w-xl"
    >
      <Field label="Why" required hint="Entered by mistake, wrong count…">
        <textarea className="form-input" maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </MakingWindow>
  )
}
