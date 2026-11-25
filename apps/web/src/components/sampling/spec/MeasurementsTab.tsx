'use client'
import { Plus, Ruler } from 'lucide-react'
import { SAMPLE_MEASURE_MAX_POINTS, type SampleSpecGap } from '@ld-erp/shared'
import { cn } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { Lookups } from '../types'
import {
  clearTargets,
  limitDecimals,
  measureColumns,
  moveRow,
  newPoint,
  plural,
  pointHasData,
  type MeasurePoint,
  type SpecDraft,
} from '../specRules'
import { CELL, RowTools, sameBoxOnLine, TabGaps, TH, useConfirm } from './parts'

type Update = (change: (d: SpecDraft) => SpecDraft) => void

/**
 * Measurements as the tech pack lays them out: one row per point, with its
 * tolerance and unit, and the target for each size the round makes. Every
 * colour is measured alike. Saved as the flat list QC reads, one entry per
 * point and size.
 *
 * A line grid of the ERP: Enter goes down a column (all of one size's
 * targets, point after point), Alt+A adds a point, Alt+Delete removes one.
 */
export function MeasurementsTab({
  draft,
  update,
  lookups,
  gaps,
}: {
  draft: SpecDraft
  update: Update
  lookups: Lookups
  gaps: SampleSpecGap[]
}) {
  const { ask, dialog } = useConfirm()
  const columns = measureColumns(draft)
  const sizeCode = (id: string) => lookups.sizes.find((z) => z.id === id)?.code ?? 'Unknown size'
  const setPoint = (key: string, patch: Partial<MeasurePoint>) =>
    update((d) => ({ ...d, points: d.points.map((p) => (p.key === key ? { ...p, ...patch } : p)) }))
  const setTarget = (p: MeasurePoint, sizeId: string, v: string) =>
    setPoint(p.key, { targets: { ...p.targets, [sizeId]: limitDecimals(v, 2) } })
  const addPoint = () =>
    update((d) => ({ ...d, points: [...d.points, newPoint(d.points.at(-1)?.unit ?? 'cm')] }))
  const removePoint = (p: MeasurePoint, i: number) => {
    const go = () => update((d) => ({ ...d, points: d.points.filter((x) => x.key !== p.key) }))
    if (!pointHasData(p)) return go()
    const targets = Object.values(p.targets).filter((v) => v.trim() !== '').length
    ask({
      title: `Remove ${p.name.trim() || `point ${i + 1}`}?`,
      description: `${p.name.trim() || 'This point'} and its ${plural(targets, 'target')} come off the measurements. QC will not measure it.`,
      confirmLabel: 'Remove the point',
      run: go,
    })
  }
  const clearSize = (sizeId: string) => {
    const n = draft.points.filter((p) => (p.targets[sizeId] ?? '').trim() !== '').length
    ask({
      title: `Clear the targets for size ${sizeCode(sizeId)}?`,
      description: `This round makes no pieces of size ${sizeCode(sizeId)}, so its ${plural(n, 'target')} cannot be measured. Clearing takes them off; add pieces of the size in Style & colours instead to keep them.`,
      confirmLabel: 'Clear the targets',
      run: () => update((d) => clearTargets(d, sizeId)),
    })
  }
  const filledTargets = draft.points.reduce(
    (t, p) => t + Object.values(p.targets).filter((v) => v.trim() !== '').length,
    0
  )

  return (
    <div className="space-y-4">
      <Section
        icon={Ruler}
        title={
          draft.points.length ? `Measurement points (${draft.points.length})` : 'Measurement points'
        }
        actions={
          <button
            type="button"
            className="btn-secondary h-8 px-3 text-xs"
            data-grid-add
            aria-keyshortcuts="Alt+A"
            disabled={draft.points.length >= SAMPLE_MEASURE_MAX_POINTS}
            title={
              draft.points.length >= SAMPLE_MEASURE_MAX_POINTS
                ? `A round measures up to ${SAMPLE_MEASURE_MAX_POINTS} points`
                : undefined
            }
            onClick={addPoint}
          >
            <Plus size={14} /> Add a point
          </button>
        }
      >
        <p className="text-muted-foreground mb-3 text-xs">
          One row per point, with a target for each size made. Enter goes down a size’s column;
          Alt+A adds a point.
        </p>
        {!columns.length && (
          <p className="border-border text-muted-foreground mb-3 rounded-lg border border-dashed p-3 text-xs">
            No sizes yet. Each size with pieces in Style & colours gets a column of targets here.
          </p>
        )}
        <div data-grid className="border-border bg-card overflow-x-auto rounded-lg border">
          <table className="w-full min-w-max text-sm" onKeyDownCapture={sameBoxOnLine}>
            <thead className="bg-secondary/60">
              <tr className="border-border border-b">
                <th className={cn(TH, 'w-10 pl-3')}>#</th>
                <th className={cn(TH, 'w-56')}>Point</th>
                <th className={cn(TH, 'w-28 text-right')}>Tolerance ±</th>
                <th className={cn(TH, 'w-24')}>Unit</th>
                {columns.map((c) => (
                  <th key={c.sizeId} className={cn(TH, 'w-28 text-right')}>
                    {c.made ? (
                      sizeCode(c.sizeId)
                    ) : (
                      <span className="flex flex-col items-end gap-1">
                        <span className="warn-text">{sizeCode(c.sizeId)} · not made</span>
                        <button
                          type="button"
                          className="text-primary font-medium normal-case tracking-normal hover:underline"
                          onClick={() => clearSize(c.sizeId)}
                        >
                          Clear
                        </button>
                      </span>
                    )}
                  </th>
                ))}
                <th className={cn(TH, 'w-24 pr-3')}>
                  <span className="sr-only">Move or remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.points.map((p, i) => {
                const some = Object.values(p.targets).some((v) => v.trim() !== '')
                return (
                  <tr key={p.key} data-grid-row className="border-border/50 border-b">
                    <td className="text-primary py-1.5 pl-3 pr-2 align-middle font-mono text-xs font-semibold">
                      {i + 1}
                    </td>
                    <td className="px-1.5 py-1.5 align-middle">
                      <input
                        className={cn(CELL, 'w-full', some && !p.name.trim() && 'border-accent')}
                        maxLength={100}
                        placeholder="e.g. Chest ½"
                        value={p.name}
                        onChange={(e) => setPoint(p.key, { name: e.target.value })}
                        aria-label={`Point ${i + 1} name`}
                      />
                    </td>
                    <td className="px-1.5 py-1.5 align-middle">
                      <StepInput
                        decimals
                        step={0.5}
                        max={100}
                        className={cn(CELL, 'w-full text-right tabular-nums')}
                        placeholder="0"
                        value={p.tolerance}
                        onValueChange={(v) => setPoint(p.key, { tolerance: limitDecimals(v, 2) })}
                        aria-label={`Point ${i + 1} tolerance, plus or minus`}
                      />
                    </td>
                    <td className="px-1.5 py-1.5 align-middle">
                      <SmartSelect
                        className={cn(CELL, 'w-full')}
                        value={p.unit}
                        onChange={(e) => setPoint(p.key, { unit: e.target.value as 'cm' | 'in' })}
                        aria-label={`Point ${i + 1} unit`}
                      >
                        <option value="cm">cm</option>
                        <option value="in">inch</option>
                      </SmartSelect>
                    </td>
                    {columns.map((c) => {
                      const v = p.targets[c.sizeId] ?? ''
                      return (
                        <td key={c.sizeId} className="px-1.5 py-1.5 align-middle">
                          <StepInput
                            decimals
                            step={0.5}
                            max={10000}
                            className={cn(
                              CELL,
                              'w-full text-right tabular-nums',
                              c.made && some && !v.trim() && 'border-accent',
                              !c.made && v.trim() && 'warn-text'
                            )}
                            placeholder="—"
                            value={v}
                            title={
                              c.made && some && !v.trim()
                                ? `No target for size ${sizeCode(c.sizeId)} yet`
                                : undefined
                            }
                            onValueChange={(next) => setTarget(p, c.sizeId, next)}
                            aria-label={`${p.name.trim() || `Point ${i + 1}`}, size ${sizeCode(c.sizeId)}: target in ${p.unit === 'in' ? 'inches' : 'cm'}`}
                          />
                        </td>
                      )
                    })}
                    <td className="py-1.5 pl-1 pr-3 align-middle">
                      <RowTools
                        index={i}
                        count={draft.points.length}
                        noun="point"
                        onMove={(dir) =>
                          update((d) => ({ ...d, points: moveRow(d.points, i, dir) }))
                        }
                        onRemove={() => removePoint(p, i)}
                      />
                    </td>
                  </tr>
                )
              })}
              {!draft.points.length && (
                <tr>
                  <td
                    colSpan={columns.length + 5}
                    className="text-muted-foreground px-3 py-4 text-center text-sm"
                  >
                    No measurement points yet. Add the points the tech pack gives, such as chest,
                    length and sleeve.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          {plural(draft.points.length, 'point')} · {plural(filledTargets, 'target')}
          {columns.length ? ` · sizes ${columns.map((c) => sizeCode(c.sizeId)).join(', ')}` : ''}
        </p>
      </Section>
      <TabGaps gaps={gaps} />
      {dialog}
    </div>
  )
}
