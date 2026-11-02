'use client'

import Link from 'next/link'
import type { KeyboardEvent, ReactNode } from 'react'
import { ArrowRight, Check, Route } from 'lucide-react'

/**
 * A manufacturing order's window as steps, one tab each, in the order the
 * work goes: the order, its materials, its stages, and packing. Each tab is
 * ticked once its step is done, and the line under the tabs says the one
 * thing to do next. The routing comes in on the Stages tab: "Set up stages"
 * copies the style's routing onto this order.
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

export type MoTab = 'order' | 'materials' | 'stages' | 'packed'

const isFinished = (f: MoFlowFacts) =>
  f.status === 'COMPLETED' || f.status === 'CLOSED' || (f.planned > 0 && f.packed >= f.planned)

function stepsOf(f: MoFlowFacts): Array<{ id: MoTab; label: string; hint: string; done: boolean }> {
  const finished = isFinished(f)
  return [
    {
      id: 'order',
      label: 'Order',
      hint: f.hasSalesOrder ? 'Sales order, styles, sizes · release' : 'Styles, sizes · release',
      done: f.status !== 'DRAFT',
    },
    {
      id: 'materials',
      label: 'Materials',
      hint: 'Ask the store · issued',
      done: f.materialsIssued,
    },
    {
      id: 'stages',
      label: 'Stages & production',
      hint: 'Routing → cutting → stitching → QC',
      done: finished,
    },
    { id: 'packed', label: 'Packed & dispatch', hint: 'Finished goods · challan', done: finished },
  ]
}

/** The step the order has reached: the tab to open on. */
export function currentMoTab(f: MoFlowFacts): MoTab {
  return stepsOf(f).find((s) => !s.done)?.id ?? 'packed'
}

export function MoFlowStrip({
  facts,
  tab,
  onTab,
  onSetUpStages,
}: {
  facts: MoFlowFacts
  tab: MoTab
  onTab: (t: MoTab) => void
  onSetUpStages: () => void
}) {
  const f = facts
  const steps = stepsOf(f)
  const nowAt = currentMoTab(f)
  const go = (t: MoTab, label: ReactNode) =>
    tab === t ? undefined : (
      <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => onTab(t)}>
        {label} <ArrowRight size={13} />
      </button>
    )

  let next: { text: string; action?: ReactNode }
  if (f.status === 'DRAFT') {
    next = {
      text: 'Check the colours and quantities, then press Release at the top.',
      action: go('order', 'Order'),
    }
  } else if (!f.materialsIssued) {
    next = {
      text: f.requisitionsRaised
        ? 'The store has to issue the materials asked for. Once issued, set up the stages.'
        : 'Ask the store for the fabric and trims: tick them on Materials and press "Raise requisitions".',
      action: go('materials', 'Materials'),
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
  } else if (!isFinished(f)) {
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

  // Left / right arrows move between the steps, as on any tab bar.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const i = steps.findIndex((s) => s.id === tab)
    const to = steps[(i + (e.key === 'ArrowRight' ? 1 : steps.length - 1)) % steps.length]
    onTab(to.id)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${to.id}"]`)?.focus()
  }

  return (
    <div
      className="bg-card border-border sticky top-0 z-10 -mx-4 -mt-3 border-b px-4 pb-2.5 pt-3"
      data-mo-flow
    >
      <div
        className="grid grid-cols-2 gap-1.5 lg:grid-cols-4"
        role="tablist"
        aria-label="Steps of this order"
        onKeyDown={onKey}
      >
        {steps.map((s, i) => {
          const open = tab === s.id
          const here = s.id === nowAt && !s.done
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              data-tab={s.id}
              aria-selected={open}
              tabIndex={open ? 0 : -1}
              onClick={() => onTab(s.id)}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                open ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary/60'
              }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  s.done
                    ? 'bg-primary text-primary-foreground'
                    : here
                      ? 'border-primary text-primary border-2'
                      : 'bg-secondary text-muted-foreground'
                }`}
              >
                {s.done ? <Check size={14} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span
                  className={`block truncate text-sm font-semibold ${open ? 'text-primary' : 'text-foreground'}`}
                >
                  {s.label}
                </span>
                <span className="text-muted-foreground block truncate text-[11px]">
                  {here ? 'You are here' : s.done ? 'Done' : s.hint}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-foreground text-sm">
          <b>Next:</b> {next.text}
        </p>
        {next.action}
      </div>
    </div>
  )
}
