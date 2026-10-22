'use client'

import { Fragment } from 'react'
import { ChevronRight, Truck } from 'lucide-react'
import { pcs, type StepFigures } from './types'

/**
 * A job card's route as a line of stages, in the route's order, each saying in
 * words where the pieces are there now: "280 here", "20 coming", "40 outside",
 * "✓ 300 done", "Left out". The same strip heads the board and every sheet,
 * so the floor always sees the whole way the pieces go and where they stand.
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
  label = 'Route',
}: {
  steps: StripStep[]
  /** The stage being looked at, ringed. */
  current?: string | null
  /** Opens a stage; without it the strip only shows. */
  onPick?: (stepId: string) => void
  /** Pieces issued to cutting contractors and not yet back, shown on the cutting stage. */
  withCutters?: number
  label?: string
}) {
  return (
    <div className="-mx-1 flex items-stretch gap-1 overflow-x-auto px-1 pb-1" role="list" aria-label={label}>
      {steps.map((s, i) => {
        const note = stripNote(s, s.kind === 'CUTTING' ? withCutters : 0)
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
