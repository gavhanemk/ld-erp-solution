'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowRight, Check, ChevronRight, Route } from 'lucide-react'

/**
 * Where a manufacturing order stands in the whole flow, quotation to
 * dispatch, with the one thing to do next. The routing comes in at "Stages
 * set up": that is when the style's routing is copied onto this order.
 */
export interface MoFlowFacts {
  hasSalesOrder: boolean
  status: string
  requisitionsRaised: boolean
  materialsIssued: boolean
  stagesSetUp: boolean
  cutStarted: boolean
  planned: number
  packed: number
}

type State = 'done' | 'now' | 'todo'

export function MoFlowStrip({ facts, onSetUpStages, onShowMaterials }: { facts: MoFlowFacts; onSetUpStages: () => void; onShowMaterials: () => void }) {
  const f = facts
  const released = f.status !== 'DRAFT'
  const finished = f.status === 'COMPLETED' || f.status === 'CLOSED' || (f.planned > 0 && f.packed >= f.planned)

  const steps: Array<{ label: string; done: boolean }> = [
    { label: f.hasSalesOrder ? 'Quotation & sales order' : 'Made without a sales order', done: true },
    { label: 'Order released', done: released },
    { label: 'Materials issued', done: f.materialsIssued },
    { label: 'Stages set up (routing)', done: f.stagesSetUp },
    { label: 'Cutting → stitching → QC', done: finished },
    { label: 'Packed', done: finished },
    { label: 'Dispatch & invoice', done: false },
  ]
  // The first step not done is where the order is now.
  const nowAt = steps.findIndex((s) => !s.done)
  const stateOf = (i: number): State => (steps[i].done ? 'done' : i === nowAt ? 'now' : 'todo')

  let next: { text: string; action?: ReactNode }
  if (!released) {
    next = { text: 'Check the colours and quantities below, then press Release at the top.' }
  } else if (!f.materialsIssued) {
    next = {
      text: f.requisitionsRaised
        ? 'The store has to issue the materials asked for. Once issued, you can set up the stages.'
        : 'Ask the store for the fabric and trims: raise the requisition under "Materials from the BOM".',
      action: (
        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onShowMaterials}>
          Go to materials <ArrowRight size={13} />
        </button>
      ),
    }
  } else if (!f.stagesSetUp) {
    next = {
      text: 'Press "Set up stages". It brings in this style’s routing — cutting, stitching, QC and the rest, with their lines and contractors.',
      action: (
        <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={onSetUpStages}>
          <Route size={13} /> Set up stages
        </button>
      ),
    }
  } else if (!finished) {
    next = {
      text: f.cutStarted
        ? 'Record the work as it moves from stage to stage on Production Stages. Pieces count as packed at the last stage.'
        : 'Start with cutting: record it on Production Stages, then each next stage in turn.',
      action: (
        <Link href="/production/stages" className="btn-primary h-8 px-3 text-xs">
          Production Stages <ArrowRight size={13} />
        </Link>
      ),
    }
  } else {
    next = {
      text: 'All pieces are packed. Send them from Sales → Delivery challan, then bill them.',
      action: (
        <Link href="/sales/challan" className="btn-secondary h-8 px-3 text-xs">
          Delivery challan <ArrowRight size={13} />
        </Link>
      ),
    }
  }

  return (
    <div className="glass-card space-y-2.5 p-3" data-mo-flow>
      <ol className="flex flex-wrap items-center gap-y-1.5 text-xs" aria-label="Where this order is">
        {steps.map((s, i) => {
          const st = stateOf(i)
          return (
            <li key={s.label} className="flex items-center" aria-current={st === 'now' ? 'step' : undefined}>
              <span
                className={
                  st === 'done'
                    ? 'text-primary flex items-center gap-1 font-medium'
                    : st === 'now'
                      ? 'bg-primary text-primary-foreground flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold'
                      : 'text-muted-foreground flex items-center gap-1'
                }
              >
                {st === 'done' ? <Check size={13} /> : <span className="tabular-nums">{i + 1}.</span>}
                {s.label}
              </span>
              {i < steps.length - 1 && <ChevronRight size={14} className="text-muted-foreground mx-1" aria-hidden />}
            </li>
          )
        })}
      </ol>
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
        <p className="text-foreground text-sm">
          <b>Next:</b> {next.text}
        </p>
        {next.action}
      </div>
    </div>
  )
}
