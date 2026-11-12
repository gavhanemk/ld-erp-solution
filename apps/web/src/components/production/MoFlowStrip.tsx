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
  /** The store has issued something for this order: enough to set up its stages. */
  materialsIssued: boolean
  /** Materials the BOM asks for, and how many of them are issued in full. */
  materialItems: number
  materialItemsIssued: number
  stagesSetUp: boolean
  cutStarted: boolean
  /** Cut the old way, from the order's own Cutting, before it had stages: those cutting numbers. */
  cutWithoutStages?: string[]
  planned: number
  packed: number
  /** Its sales order is over and nothing was made on it: all that is left is closing it. */
  orderClosed?: boolean
}

export type MoTab = 'order' | 'materials' | 'stages' | 'packed'

const isFinished = (f: MoFlowFacts) =>
  f.status === 'COMPLETED' || f.status === 'CLOSED' || (f.planned > 0 && f.packed >= f.planned)

/**
 * An order cut the old way, from its own Cutting, before it had stages: the server refuses
 * stages for it (CUT_WITHOUT_ROUTE). No more cutting is recorded that way (6 Nov 2026), so it
 * carries on as it is. Said the same on the strip, the Stages tab and the job card; `where`
 * says where its cuttings can be cancelled from.
 */
export function oldCutNote(cuts: string[], packed: number, where = 'under Cutting on the Stages tab') {
  return `Cut the old way (${cuts.join(', ')}) before stages were set up, so this order carries on without stages: book what is packed in Inventory → Finished Goods In. ${
    packed > 0 ? 'Some of it is already packed, so it stays without stages.' : `To use stages instead, first cancel ${cuts.length === 1 ? 'that cutting' : 'those cuttings'} ${where}.`
  }`
}

/** Materials ticked only when every one is issued in full. */
const allIssued = (f: MoFlowFacts) => f.materialItems > 0 && f.materialItemsIssued >= f.materialItems

/**
 * `done` ticks a step; `passed` says the order has moved on from it. Materials
 * part issued are passed (stages can be set up) but not done.
 */
function stepsOf(
  f: MoFlowFacts,
): Array<{ id: MoTab; label: string; hint: string; done: boolean; passed?: boolean; partly?: string }> {
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
      done: allIssued(f),
      passed: f.materialsIssued,
      partly: f.materialsIssued && !allIssued(f) ? `Part issued · ${f.materialItemsIssued} of ${f.materialItems} in full` : undefined,
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
  return stepsOf(f).find((s) => !(s.passed ?? s.done))?.id ?? 'packed'
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
  /** Left out when this person may not load stages: the strip then points at the Stages tab. */
  onSetUpStages?: () => void
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
  if (f.orderClosed) {
    next = { text: 'Its sales order is closed and nothing was made on this order, so nothing more is asked or made: cancel it with "Cancel this MO" below.' }
  } else if (f.status === 'DRAFT') {
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
  } else if (f.status === 'CLOSED') {
    next = { text: 'This order is closed: nothing more is issued, cut or packed on it.' }
  } else if (!f.stagesSetUp && !isFinished(f) && f.cutWithoutStages?.length) {
    // The server refuses stages for it (CUT_WITHOUT_ROUTE): its pieces have no bundles to move.
    next = { text: oldCutNote(f.cutWithoutStages, f.packed), action: go('stages', 'Cutting') }
  } else if (!f.stagesSetUp && !isFinished(f)) {
    next = onSetUpStages
      ? {
          text: allIssued(f)
            ? 'Press "Set up stages". It brings in this style’s routing — cutting, stitching, QC and the rest, with their lines and contractors.'
            : 'Press "Set up stages" to bring in this style’s routing. The rest of the materials can be asked for on the Materials tab.',
          action: (
            <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={onSetUpStages}>
              <Route size={13} /> Set up stages
            </button>
          ),
        }
      : { text: 'Its stages are not set up yet: someone in production loads them from the style’s routing on the Stages tab.', action: go('stages', 'Stages') }
  } else if (!isFinished(f)) {
    next = {
      text: f.cutStarted
        ? 'Record the work as it moves from stage to stage on Production Floor. Pieces count as packed at the last stage.'
        : 'Start with cutting: record it on Production Floor, then each next stage in turn.',
      action: (
        <Link href="/production/floor" className="btn-primary h-8 px-3 text-xs">
          Production Floor <ArrowRight size={13} />
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
      className="border-border shrink-0 border-b px-4 pb-3 pt-3"
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
                open ? 'border-primary bg-card ring-primary ring-1' : 'border-border bg-card hover:bg-secondary/60'
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
                  {here ? 'You are here' : s.done ? 'Done' : s.partly ? <span className="warn-text">{s.partly}</span> : s.hint}
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
