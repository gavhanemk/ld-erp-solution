'use client'
import { ArrowRight, CheckCircle2, Circle, ClipboardCheck, ListChecks } from 'lucide-react'
import type { SampleSpecGap, SampleSpecification } from '@ld-erp/shared'
import { formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import type { Lookups } from '../types'
import {
  gapsByTab,
  MATERIAL_COST_LABEL,
  plural,
  routeRules,
  ROUTE_TEXT,
  SPEC_TABS,
  specSummary,
  type SpecTab,
} from '../specRules'
import { Warn } from './parts'

/**
 * Review & release: what still stops the release, tab by tab, each line a
 * way to the tab that fixes it; the round in figures; and what release does.
 * The gaps are the shared list the server refuses a release with, and the
 * route's cutting rules, which it refuses with too.
 */
export function ReviewTab({
  spec,
  gaps,
  lookups,
  canRelease,
  onGo,
}: {
  spec: SampleSpecification
  gaps: SampleSpecGap[]
  lookups: Lookups
  canRelease: boolean
  onGo: (tab: SpecTab) => void
}) {
  const byTab = gapsByTab(gaps)
  const sum = specSummary(spec)
  const sizeCode = (id: string) => lookups.sizes.find((z) => z.id === id)?.code ?? 'Unknown size'
  const noCheck = routeRules(spec.route).noCheck
  const figures: Array<[string, string]> = [
    ['Colours', sum.colours.length ? sum.colours.join(', ') : 'None yet'],
    ['Pieces', String(sum.pieces)],
    ['Sizes', sum.sizeIds.length ? sum.sizeIds.map(sizeCode).join(', ') : 'None yet'],
    [
      'Measurement points',
      String(
        new Set(
          spec.measurements.filter((m) => m.name.trim()).map((m) => m.name.trim().toLowerCase())
        ).size
      ),
    ],
    ['Material lines', String(sum.lines)],
    [
      MATERIAL_COST_LABEL,
      `${formatRupees(sum.cost)}${sum.unrated ? ` · ${plural(sum.unrated, 'line')} with no rate` : ''}`,
    ],
  ]

  return (
    <div className="space-y-4">
      <Section
        icon={ListChecks}
        title={gaps.length ? `Still to finish (${gaps.length})` : 'Ready to release'}
      >
        <ul className="space-y-2">
          {SPEC_TABS.filter((t) => t.key !== 'review').map((t) => {
            const items = byTab[t.key]
            return (
              <li key={t.key} className="border-border rounded-lg border px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {items.length ? (
                      <Circle size={15} className="text-muted-foreground" />
                    ) : (
                      <CheckCircle2 size={15} className="text-primary" />
                    )}
                    {t.title}
                  </span>
                  <button
                    type="button"
                    className="text-primary flex items-center gap-1 text-xs font-medium hover:underline"
                    onClick={() => onGo(t.key)}
                  >
                    {items.length ? `Finish ${t.title}` : `Open ${t.title}`}{' '}
                    <ArrowRight size={13} />
                  </button>
                </div>
                {items.length > 0 && (
                  <ul className="mt-1.5 space-y-1 pl-6">
                    {items.map((g, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          className="warn-text text-left text-xs hover:underline"
                          onClick={() => onGo(t.key)}
                        >
                          {g.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </Section>

      <Section icon={ClipboardCheck} title="This round">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {figures.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-muted-foreground text-xs">{label}</dt>
              <dd className="mt-0.5 break-words text-sm font-medium">{value}</dd>
            </div>
          ))}
          <div className="min-w-0 sm:col-span-2 lg:col-span-3">
            <dt className="text-muted-foreground text-xs">Making route</dt>
            <dd className="mt-0.5 break-words text-sm font-medium">
              {sum.steps.length ? sum.steps.join(' → ') : 'No steps yet'}
            </dd>
          </div>
        </dl>
        {noCheck && <Warn className="mt-3">{ROUTE_TEXT.noCheck}</Warn>}
      </Section>

      <p className="bg-muted/40 rounded-lg p-4 text-sm leading-relaxed">
        {gaps.length
          ? 'You can save this draft as it is and come back to it. Finish the items above before releasing it for sampling.'
          : canRelease
            ? 'Everything needed is filled in. Release freezes this round’s colours, measurements, materials and route and sets up the making steps; a change after that needs a new round.'
            : 'Everything needed is filled in. Releasing needs sampling approval: save the draft, and someone who can approve releases it.'}
      </p>
    </div>
  )
}
