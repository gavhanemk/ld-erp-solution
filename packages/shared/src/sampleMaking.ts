/**
 * Making a sample, colour by colour and size by size (phase 5).
 *
 * A round's pieces go through its route one step after another. The first
 * step starts from the grid (every colour x size cell and its pieces); each
 * later step works only on what the step before handed on to it. On our own
 * floor a step records work (done and rejected in each cell) and hands what
 * is done on to the next step, where it is counted in. A step done outside
 * is given its pieces on a job-work challan and records what the unit sends
 * back, accepted and rejected.
 *
 * Nothing is kept as a running count: every figure here is summed from those
 * records, by one function the server and the screens both use, so the
 * screen offers exactly what the server will take.
 */
import type { SampleSpecification } from './sampling'

/** A colour x size cell of a round's grid. */
export interface MakingCellKey {
  colour: string
  sizeId: string
}
export interface MakingQtyCell extends MakingCellKey {
  qty: number
}
export interface MakingWorkCell extends MakingCellKey {
  done: number
  rejected: number
}
export interface MakingReturnCell extends MakingCellKey {
  accepted: number
  rejected: number
}

/** One key per cell: the colour as the grid compares colours (case and spaces aside), and the size. */
export const cellKey = (c: MakingCellKey) => `${c.colour.trim().toLowerCase()}|${c.sizeId}`

const whole = (v: unknown) => {
  const x = Number(v)
  return Number.isFinite(x) ? Math.trunc(x) : 0
}
/** A record's cells as the database keeps them (JSON): whatever is not a cell is left out. */
function cellsOf<T extends MakingCellKey>(raw: unknown, read: (o: Record<string, unknown>) => Omit<T, keyof MakingCellKey>): T[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((c) => {
    if (!c || typeof c !== 'object') return []
    const o = c as Record<string, unknown>
    if (typeof o.colour !== 'string' || typeof o.sizeId !== 'string') return []
    return [{ colour: o.colour, sizeId: o.sizeId, ...read(o) } as T]
  })
}
export const qtyCells = (raw: unknown) => cellsOf<MakingQtyCell>(raw, (o) => ({ qty: whole(o.qty) }))
export const workCells = (raw: unknown) =>
  cellsOf<MakingWorkCell>(raw, (o) => ({ done: whole(o.done), rejected: whole(o.rejected) }))
export const returnCells = (raw: unknown) =>
  cellsOf<MakingReturnCell>(raw, (o) => ({ accepted: whole(o.accepted), rejected: whole(o.rejected) }))

/**
 * The cells of the grid with pieces in them, in the order the grid lists
 * them, each with its pieces and spelt as the grid spells its colour.
 */
export function gridCells(spec: Pick<SampleSpecification, 'colours'>): MakingQtyCell[] {
  const out = new Map<string, MakingQtyCell>()
  for (const row of spec.colours ?? [])
    for (const z of row.sizes ?? []) {
      const qty = whole(z.qty)
      if (qty <= 0 || !z.sizeId || !row.colour?.trim()) continue
      const key = cellKey({ colour: row.colour, sizeId: z.sizeId })
      const was = out.get(key)
      if (was) was.qty += qty
      else out.set(key, { colour: row.colour.trim(), sizeId: z.sizeId, qty })
    }
  return [...out.values()]
}

type When = string | Date | null | undefined
/** A step of the round's route, as the ledger reads it (sample_stages). */
export interface MakingStageInput {
  id: string
  sequence: number
  name: string
  execution: string
  departmentId: string | null
  /** Recorded in one go before work was recorded by cell: its own figures stand. */
  wholeStep?: boolean
  doneQty: number | null
  rejectedQty: number | null
  completedAt?: When
}
export interface MakingWorkInput {
  id: string
  stageId: string
  cells: unknown
  undoneAt?: When
}
export interface MakingTransferInput {
  id: string
  fromStageId: string
  toStageId: string
  cells: unknown
  receivedCells: unknown
  undoneAt?: When
}
export interface MakingReturnInput {
  id: string
  cells: unknown
  undoneAt?: When
}
export interface MakingJobInput {
  id: string
  stageId: string
  cells: unknown
  cancelledAt?: When
  returns: MakingReturnInput[]
}
export interface MakingInput {
  specification: Pick<SampleSpecification, 'colours'>
  stages: MakingStageInput[]
  works?: MakingWorkInput[]
  transfers?: MakingTransferInput[]
  jobWorks?: MakingJobInput[]
}

/** Where one cell's pieces stand at one step. */
export interface MakingFigures {
  /** The grid's pieces of the cell. */
  planned: number
  /**
   * Arrived at the step: the grid's pieces at the first step on our floor;
   * what went to the unit at a step done outside; otherwise what was counted
   * in from the step before.
   */
  received: number
  /** Sent on from the step before and not counted in here yet. */
  coming: number
  /** Fewer counted in than were sent: lost on the way. */
  short: number
  done: number
  rejected: number
  /** With the outside unit. */
  atUnit: number
  /** At the step to be worked on, on our floor. Pieces for a unit wait at the step before. */
  here: number
  /** Handed on to the next step, counted in there or not. */
  sentOn: number
  /** Done and not handed on yet: at the last step, the finished pieces. */
  ready: number
  /** A step done outside: what can still go to the unit (the step before's ready pieces, or the grid's at the first step). */
  toSend: number
}
export interface MakingCell extends MakingCellKey, MakingFigures {}
export interface MakingStep {
  stageId: string
  sequence: number
  name: string
  outside: boolean
  wholeStep: boolean
  cells: MakingCell[]
  total: MakingFigures
  /** Anything has reached the step or been recorded at it. */
  started: boolean
  /** Every piece that reached it is accounted for, and every step before it is done. */
  complete: boolean
}

const FIGURES: Array<keyof MakingFigures> = [
  'planned',
  'received',
  'coming',
  'short',
  'done',
  'rejected',
  'atUnit',
  'here',
  'sentOn',
  'ready',
  'toSend',
]
const zero = (): MakingFigures =>
  Object.fromEntries(FIGURES.map((k) => [k, 0])) as unknown as MakingFigures
const live = <T extends { undoneAt?: When }>(rows: T[] | undefined) => (rows ?? []).filter((r) => !r.undoneAt)

/**
 * Where every cell of every step stands, summed from the round's records:
 * its work, its hand-ons (undone ones left out) and its job work (cancelled
 * challans and undone returns left out).
 */
export function makingLedger(input: MakingInput): MakingStep[] {
  const grid = gridCells(input.specification)
  const stages = [...input.stages].sort((a, b) => a.sequence - b.sequence)
  const steps = stages.map(
    (s): MakingStep => ({
      stageId: s.id,
      sequence: s.sequence,
      name: s.name,
      outside: s.execution === 'OUTSOURCED',
      wholeStep: !!s.wholeStep,
      cells: grid.map((g) => ({ colour: g.colour, sizeId: g.sizeId, ...zero(), planned: g.qty })),
      total: zero(),
      started: false,
      complete: false,
    })
  )
  const at = new Map(steps.map((s) => [s.stageId, s]))
  const index = new Map(grid.map((g, i) => [cellKey(g), i]))
  // A cell the grid does not have is not counted (the server refuses one).
  const cellAt = (step: MakingStep | undefined, c: MakingCellKey) => {
    const i = index.get(cellKey(c))
    return step && i !== undefined ? step.cells[i] : undefined
  }
  for (const w of live(input.works))
    for (const c of workCells(w.cells)) {
      const cell = cellAt(at.get(w.stageId), c)
      if (!cell) continue
      cell.done += c.done
      cell.rejected += c.rejected
    }
  for (const t of live(input.transfers)) {
    const sent = qtyCells(t.cells)
    const got = t.receivedCells == null ? null : qtyCells(t.receivedCells)
    for (const c of sent) {
      const from = cellAt(at.get(t.fromStageId), c)
      if (from) from.sentOn += c.qty
      const to = cellAt(at.get(t.toStageId), c)
      if (!to) continue
      if (got === null) to.coming += c.qty
      else {
        const counted = got.find((g) => cellKey(g) === cellKey(c))?.qty ?? 0
        to.received += counted
        to.short += c.qty - counted
      }
    }
  }
  for (const j of input.jobWorks ?? []) {
    if (j.cancelledAt) continue
    const step = at.get(j.stageId)
    if (!step) continue
    const before = steps[steps.indexOf(step) - 1]
    for (const c of qtyCells(j.cells)) {
      const cell = cellAt(step, c)
      if (cell) cell.received += c.qty
      const prev = cellAt(before, c)
      if (prev) prev.sentOn += c.qty
    }
    for (const r of live(j.returns))
      for (const c of returnCells(r.cells)) {
        const cell = cellAt(step, c)
        if (!cell) continue
        cell.done += c.accepted
        cell.rejected += c.rejected
      }
  }
  steps.forEach((step, i) => {
    const stage = stages[i]
    const before = steps[i - 1]
    // The first step on our floor starts from the grid itself.
    if (i === 0 && (!step.outside || step.wholeStep)) step.cells.forEach((c) => (c.received = c.planned))
    if (step.wholeStep) {
      // Recorded whole: what the step before finished came on with it, and
      // its figures are the step's. A set recorded whole had nothing rejected
      // (the rule then), so each cell was done as it arrived.
      if (i > 0 && before?.wholeStep)
        step.cells.forEach((c, k) => (c.received += before.cells[k].done))
      const single = step.cells.length === 1
      step.cells.forEach((c) => {
        c.done = single ? whole(stage.doneQty) : c.received
        c.rejected = single ? whole(stage.rejectedQty) : 0
      })
    } else if (before?.wholeStep && !step.outside) {
      // The first step after steps recorded whole takes what they finished.
      step.cells.forEach((c, k) => (c.received += before.cells[k].done))
    }
    if (before?.wholeStep && (step.wholeStep || !step.outside))
      before.cells.forEach((c) => (c.sentOn += c.done))
  })
  steps.forEach((step, i) => {
    const before = steps[i - 1]
    step.cells.forEach((c, k) => {
      if (step.wholeStep) {
        c.here = 0
        c.atUnit = 0
      } else if (step.outside) {
        c.atUnit = c.received - c.done - c.rejected
        c.here = 0
        c.toSend = i === 0 ? c.planned - c.received : 0
      } else c.here = c.received - c.done - c.rejected
      c.ready = c.done - c.sentOn
      if (step.outside && !step.wholeStep && i > 0) c.toSend = before.cells[k].done - before.cells[k].sentOn
    })
  })
  steps.forEach((step, i) => {
    for (const k of FIGURES) step.total[k] = step.cells.reduce((t, c) => t + c[k], 0)
    const t = step.total
    step.started = t.received + t.coming + t.done + t.rejected + t.short > 0 || step.wholeStep
    const before = steps[i - 1]
    step.complete = step.wholeStep
      ? !!stages[i].completedAt
      : (i === 0 || (before.complete && before.cells.every((c) => c.ready === 0))) &&
        step.cells.every((c) => c.coming === 0 && c.here === 0 && c.atUnit === 0 && c.toSend === 0)
  })
  return steps
}

/**
 * What the records add up to that cannot be: more worked than arrived, more
 * handed on than done, more back from a unit than it was sent. Empty when
 * they hold. The server refuses any action that would leave one.
 */
export function makingProblems(
  input: MakingInput,
  /** A size as people know it (its code); its id otherwise. */
  sizeName: (sizeId: string) => string = (id) => id,
  steps = makingLedger(input)
): string[] {
  const problems: string[] = []
  const name = (c: MakingCellKey) => `${c.colour} · ${sizeName(c.sizeId)}`
  for (const step of steps)
    for (const c of step.cells) {
      if (c.here < 0) problems.push(`${step.name}: more of ${name(c)} worked than reached it.`)
      if (c.atUnit < 0) problems.push(`${step.name}: more of ${name(c)} back from the unit than went to it.`)
      if (c.ready < 0) problems.push(`${step.name}: more of ${name(c)} handed on than was done.`)
      if (c.toSend < 0) problems.push(`${step.name}: more of ${name(c)} sent out than there are.`)
    }
  // Each challan on its own: what came back on it is no more than went on it.
  for (const j of input.jobWorks ?? []) {
    if (j.cancelledAt) continue
    const sent = new Map(qtyCells(j.cells).map((c) => [cellKey(c), c.qty]))
    const back = new Map<string, number>()
    for (const r of live(j.returns))
      for (const c of returnCells(r.cells))
        back.set(cellKey(c), (back.get(cellKey(c)) ?? 0) + c.accepted + c.rejected)
    for (const [key, n] of back)
      if (n > (sent.get(key) ?? 0)) problems.push(`More came back on a challan than went out on it.`)
  }
  for (const t of live(input.transfers)) {
    if (t.receivedCells == null) continue
    const sent = new Map(qtyCells(t.cells).map((c) => [cellKey(c), c.qty]))
    for (const c of qtyCells(t.receivedCells))
      if (c.qty > (sent.get(cellKey(c)) ?? 0)) problems.push(`More pieces counted in than were sent.`)
  }
  return problems
}

/**
 * Whether the round's making has begun: anything worked or sent out to a
 * unit, or a step recorded. From then on a material line is no longer waived.
 */
export function makingStarted(round: {
  stages: Array<{ completedAt?: When }>
  works?: MakingWorkInput[]
  jobWorks?: Array<{ cancelledAt?: When }>
}) {
  return (
    round.stages.some((s) => !!s.completedAt) ||
    live(round.works).length > 0 ||
    (round.jobWorks ?? []).some((j) => !j.cancelledAt)
  )
}

/** What is still out on one challan, cell by cell. */
export function jobOutstanding(job: Pick<MakingJobInput, 'cells' | 'returns'>): Array<MakingCellKey & { sent: number; back: number; out: number }> {
  const back = new Map<string, number>()
  for (const r of live(job.returns))
    for (const c of returnCells(r.cells))
      back.set(cellKey(c), (back.get(cellKey(c)) ?? 0) + c.accepted + c.rejected)
  return qtyCells(job.cells).map((c) => {
    const b = back.get(cellKey(c)) ?? 0
    return { colour: c.colour, sizeId: c.sizeId, sent: c.qty, back: b, out: c.qty - b }
  })
}
/** Pieces in a set of cells. */
export const piecesIn = (cells: Array<{ qty: number }>) => cells.reduce((t, c) => t + c.qty, 0)

/** The most a step's labour, or a unit's charge, can be (₹). */
export const SAMPLE_MONEY_MAX = 9999999.99
