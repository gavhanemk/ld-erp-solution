'use client'

import { Fragment } from 'react'
import { ChevronRight, Truck } from 'lucide-react'
import { fabricQty, pcs, whoHas, type FabricRecord, type StepFigures } from './types'

/**
 * A job card's route as a line of stages, in the route's order, each saying in
 * words where the pieces are there now: "280 here", "20 coming", "40 outside",
 * "✓ 300 done", "Left out". The same strip heads the board and every sheet,
 * so the floor always sees the whole way the pieces go and where they stand.
 *
 * Under that, each stage's record: at cutting the fabric — given to the
 * contractors, used, wasted and left over with them — and the pieces cut;
 * at every stage after it, the pieces in, passed on and wasted. Cloth is
 * counted in metres only until it is cut; after that everything is pieces.
 */
export interface StripStep {
  id: string
  name: string
  kind: string
  execution: 'IN_HOUSE' | 'OUTSOURCED' | string
  skipped: boolean
  figures: StepFigures | null
}

type Tone = 'here' | 'coming' | 'warn' | 'done' | 'idle' | 'skipped'

/** What a stage holds now, as short lines, and how it should look. */
export function stripNote(s: StripStep, withCutters = 0): { lines: string[]; tone: Tone } {
  if (s.skipped) return { lines: ['Left out'], tone: 'skipped' }
  const f = s.figures
  if (!f) return { lines: ['—'], tone: 'idle' }
  const lines: string[] = []
  const cutting = s.kind === 'CUTTING'
  if (cutting && withCutters) lines.push(`${pcs(withCutters)} with cutters`)
  const here = f.inHand + f.waiting
  if (here) lines.push(cutting ? `${pcs(here)} cut, to send` : `${pcs(here)} here`)
  if (f.atVendor) lines.push(`${pcs(f.atVendor)} outside`)
  if (f.inTransit) lines.push(`${pcs(f.inTransit)} coming`)
  const problem = f.damagedNow + f.rejectedNow + f.inRework + f.short
  if (problem) lines.push(`${pcs(problem)} to sort out`)
  if (lines.length) return { lines, tone: problem ? 'warn' : here || f.atVendor || withCutters ? 'here' : 'coming' }
  if (f.state === 'DONE') return { lines: [`✓ ${pcs(f.completed || f.received)} done`], tone: 'done' }
  const through = f.sentOn + f.packed
  if (through) return { lines: [`${pcs(through)} through`], tone: 'done' }
  return { lines: ['—'], tone: 'idle' }
}

interface RecordLine {
  text: string
  warn?: boolean
  /** Said in full on hover: who has the left over. */
  title?: string
}

/**
 * A stage's record, to account for what came to it: the fabric at cutting,
 * and at every stage the pieces in, passed on and wasted (written off).
 * Nothing for a stage nothing has reached yet.
 */
export function stepRecord(s: StripStep, fabric: FabricRecord[] = []): RecordLine[] {
  const f = s.figures
  if (s.skipped || !f) return []
  const out: RecordLine[] = []
  const passedOn = [f.sentOn ? `${pcs(f.sentOn)} on` : null, f.packed ? `${pcs(f.packed)} packed` : null].filter(Boolean).join(' · ') || '0 on'
  if (s.kind === 'CUTTING') {
    for (const r of fabric) {
      if (r.given) out.push({ text: `${fabricQty(r.given, r.unit)} fabric given` })
      if (r.used || r.waste) out.push({ text: `${fabricQty(r.used, r.unit)} used · ${fabricQty(r.waste, r.unit)} waste` })
      if (r.withCutters) out.push({ text: `${fabricQty(r.withCutters, r.unit)} with cutters` })
      if (r.leftOver) out.push({ text: `${fabricQty(r.leftOver, r.unit)} left over`, warn: true, title: `Left over with ${whoHas(r.leftWith, r.unit)}` })
      if (r.overUsed) out.push({ text: `${fabricQty(r.overUsed, r.unit)} over given`, warn: true, title: `More used than given: ${whoHas(r.overBy, r.unit)}` })
      if (r.notRecorded) out.push({ text: `given not recorded (${r.notRecorded})`, warn: true, title: `Fabric given was not recorded on ${r.notRecorded} received ${r.notRecorded === 1 ? 'lay' : 'lays'}` })
    }
    if (f.received || f.sentOn) out.push({ text: `${pcs(f.received)} cut · ${passedOn}` })
    if (f.scrapped) out.push({ text: `${pcs(f.scrapped)} pcs waste`, warn: true })
  } else if (f.received || f.sentOn || f.packed || f.scrapped) {
    out.push({ text: `${pcs(f.received)} in · ${passedOn}` })
    out.push({ text: `${pcs(f.scrapped)} waste`, warn: f.scrapped > 0 })
  }
  if (f.bGrade) out.push({ text: `${pcs(f.bGrade)} B-grade` })
  return out
}

const BOX: Record<Tone, string> = {
  here: 'border-primary/50 bg-primary/10',
  coming: 'border-border bg-card',
  warn: 'border-amber-500/60 bg-amber-500/10',
  done: 'border-border bg-card',
  idle: 'border-border border-dashed bg-transparent',
  skipped: 'border-border border-dashed bg-transparent opacity-60',
}
const NOTE: Record<Tone, string> = {
  here: 'text-primary font-semibold',
  coming: 'text-foreground',
  warn: 'text-amber-700 font-semibold',
  done: 'text-primary',
  idle: 'text-muted-foreground',
  skipped: 'text-muted-foreground line-through',
}

export function RouteStrip({
  steps,
  current,
  onPick,
  withCutters = 0,
  fabric = [],
  label = 'Route',
}: {
  steps: StripStep[]
  /** The stage being looked at, ringed. */
  current?: string | null
  /** Opens a stage; without it the strip only shows. */
  onPick?: (stepId: string) => void
  /** Pieces issued to cutting contractors and not yet back, shown on the cutting stage. */
  withCutters?: number
  /** The job card's fabric record, shown on the cutting stage. */
  fabric?: FabricRecord[]
  label?: string
}) {
  return (
    <div className="-mx-1 flex items-stretch gap-1 overflow-x-auto px-1 pb-1" role="list" aria-label={label}>
      {steps.map((s, i) => {
        const note = stripNote(s, s.kind === 'CUTTING' ? withCutters : 0)
        const record = stepRecord(s, s.kind === 'CUTTING' ? fabric : [])
        const on = s.id === current
        const outside = s.execution === 'OUTSOURCED'
        const body = (
          <>
            <span className="text-foreground flex items-center gap-1 whitespace-nowrap text-xs font-semibold">
              {s.name}
              {outside && <Truck size={11} className="text-muted-foreground" aria-label="done at an outside unit" />}
            </span>
            {note.lines.map((l) => (
              <span key={l} className={`block whitespace-nowrap text-[11px] leading-tight ${NOTE[note.tone]}`}>
                {l}
              </span>
            ))}
            {record.length > 0 && (
              <span className="border-border/70 mt-1 block w-full border-t pt-1" aria-label={`${s.name} record`}>
                {record.map((r) => (
                  <span key={r.text} title={r.title} className={`block whitespace-nowrap text-[11px] leading-tight ${r.warn ? 'warn-text font-semibold' : 'text-muted-foreground'}`}>
                    {r.text}
                  </span>
                ))}
              </span>
            )}
          </>
        )
        const cls = `flex min-w-[92px] shrink-0 flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left ${BOX[note.tone]} ${on ? 'ring-primary ring-2' : ''}`
        return (
          <Fragment key={s.id}>
            {i > 0 && <ChevronRight size={14} className="text-muted-foreground shrink-0 self-center" aria-hidden />}
            <div role="listitem" className="flex shrink-0">
              {onPick ? (
                <button
                  type="button"
                  className={`${cls} hover:border-primary/60 transition-colors`}
                  onClick={() => onPick(s.id)}
                  aria-current={on ? 'step' : undefined}
                  title={`Open the ${s.name} sheet${outside ? ' (done at an outside unit)' : ''}`}
                >
                  {body}
                </button>
              ) : (
                <div className={cls}>{body}</div>
              )}
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
