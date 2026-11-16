'use client'
import { ArrowRight, FileText, Grid3x3, Shirt, Trash2 } from 'lucide-react'
import { STYLE_STAGE_LABEL, type SampleRequestStyle, type SampleSpecGap } from '@ld-erp/shared'
import { cn } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import type { Lookups } from '../types'
import {
  addColour,
  addSize,
  colourRemoval,
  colourRemovalText,
  coloursToAdd,
  gridColumns,
  gridTotals,
  nameColour,
  removeColour,
  removeSize,
  setPieces,
  sizeRemoval,
  sizeRemovalText,
  type SpecDetail,
  type SpecDraft,
} from '../specRules'
import { CELL, Field, sameBoxOnLine, TabGaps, TH, useConfirm } from './parts'

type Update = (change: (d: SpecDraft) => SpecDraft) => void

/**
 * Style & colours: the request's style as it stands, the round's documents,
 * and the colour × size grid of pieces to make. Rows are this round's colours,
 * picked from the style's; columns are the style's size run, each switched on
 * for the sizes this round makes. Enter goes on to the next box across the row,
 * then down to the next colour.
 */
export function StyleColoursTab({
  draft,
  update,
  lookups,
  requestStyle,
  runSizeIds,
  gaps,
  itemName,
  onChooseStyle,
}: {
  draft: SpecDraft
  update: Update
  lookups: Lookups
  requestStyle: SampleRequestStyle | null
  runSizeIds: string[]
  gaps: SampleSpecGap[]
  itemName: (id: string) => string
  onChooseStyle: () => void
}) {
  const { ask, dialog } = useConfirm()
  const sizeCode = (id: string) =>
    id ? (lookups.sizes.find((z) => z.id === id)?.code ?? 'Unknown size') : 'No size'
  const runName = requestStyle?.sizeGroupId
    ? lookups.sizeGroups.find((g) => g.id === requestStyle.sizeGroupId)?.name
    : undefined
  const columns = gridColumns(runSizeIds, draft.sizeIds)
  const totals = gridTotals(draft)
  const toAdd = requestStyle ? coloursToAdd(requestStyle.colors, draft) : []
  const styleColour = (c: string) =>
    !c.trim() || !!requestStyle?.colors.some((x) => x.toLowerCase() === c.trim().toLowerCase())
  const text = (k: SpecDetail, v: string) => update((d) => ({ ...d, [k]: v }))

  const focusRow = (row: number) =>
    // After the list has closed and moved on: the new colour's first box.
    setTimeout(() => {
      document
        .querySelector<HTMLInputElement>(`[data-colour-row="${row}"] input:not([disabled])`)
        ?.focus()
    }, 80)

  const toggleSize = (sizeId: string, on: boolean) => {
    if (on) return update((d) => addSize(d, sizeId, runSizeIds))
    const said = sizeRemovalText(sizeCode(sizeId), sizeRemoval(draft, sizeId))
    if (!said) return update((d) => removeSize(d, sizeId))
    ask({
      title: `Take size ${sizeCode(sizeId)} off this round?`,
      description: said,
      confirmLabel: `Take ${sizeCode(sizeId)} off`,
      run: () => update((d) => removeSize(d, sizeId)),
    })
  }
  const dropColour = (row: number) => {
    const said = colourRemovalText(colourRemoval(draft, row), itemName)
    const name = draft.colours[row]?.colour.trim() || 'this row'
    if (!said) return update((d) => removeColour(d, row))
    ask({
      title: `Take ${name} off this round?`,
      description: said,
      confirmLabel: `Take ${name} off`,
      run: () => update((d) => removeColour(d, row)),
    })
  }

  return (
    <div className="space-y-4">
      <Section icon={FileText} title="Round details">
        <div className="space-y-3">
          {/* The style is the request's own, set in Request & tech pack. */}
          <div className="border-border bg-secondary/40 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 text-sm">
            <Shirt size={15} className="text-primary shrink-0" />
            {requestStyle ? (
              <>
                <span className="min-w-0 truncate">
                  <span className="font-mono">{requestStyle.code}</span> · {requestStyle.name}
                </span>
                <span
                  className={
                    requestStyle.stage === 'DEVELOPMENT' ? 'badge-warning' : 'badge-success'
                  }
                >
                  {STYLE_STAGE_LABEL[requestStyle.stage]}
                </span>
                <span className="text-muted-foreground text-xs">
                  Size run:{' '}
                  {runName ? `${runName} · ${runSizeIds.map(sizeCode).join(', ')}` : 'none yet'}
                </span>
                <span className="text-muted-foreground text-xs">
                  Colours:{' '}
                  {requestStyle.colors.length ? requestStyle.colors.join(', ') : 'none yet'}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">No style yet</span>
            )}
          </div>
          {!requestStyle && (
            <div className="border-primary/25 bg-primary/5 rounded-lg border p-3">
              <p className="text-sm font-medium">
                Create or choose the style in Request & tech pack first
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                Every round samples the request’s own style; its colours and size run fill the grid
                below. If you have typed anything here, save the draft first.
              </p>
              <button type="button" className="btn-secondary mt-2" onClick={onChooseStyle}>
                Go to Request & tech pack <ArrowRight size={15} />
              </button>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Sample milestone" required>
              <input
                className="form-input"
                maxLength={80}
                placeholder="e.g. Fit sample, size set, pre-production"
                value={draft.milestone}
                onChange={(e) => text('milestone', e.target.value)}
              />
            </Field>
            <Field label="Tech pack reference" required>
              <input
                className="form-input"
                maxLength={1000}
                placeholder="Document name, version or reference"
                value={draft.techPackRef}
                onChange={(e) => text('techPackRef', e.target.value)}
              />
            </Field>
            <Field label="Pattern reference" required>
              <input
                className="form-input"
                maxLength={1000}
                placeholder="Pattern version or file name"
                value={draft.patternRef}
                onChange={(e) => text('patternRef', e.target.value)}
              />
            </Field>
          </div>
          <Field label="Construction instructions" required>
            <textarea
              rows={3}
              className="form-input"
              maxLength={4000}
              placeholder="Seams, stitches per inch, finishes: how the tech pack says it is made"
              value={draft.construction}
              onChange={(e) => text('construction', e.target.value)}
            />
          </Field>
          <Field label="Technical review notes (optional)">
            <textarea
              rows={2}
              className="form-input"
              maxLength={4000}
              placeholder="Anything else the sampling room should know"
              value={draft.notes}
              onChange={(e) => text('notes', e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        icon={Grid3x3}
        title={draft.colours.length ? `Colours and pieces (${totals.total})` : 'Colours and pieces'}
        actions={
          <div className="w-52">
            <SmartSelect
              className={CELL}
              value=""
              aria-label="Add a colour to this round"
              disabled={!requestStyle || !toAdd.length || draft.colours.length >= 30}
              title={
                !requestStyle
                  ? 'Set the request’s style first'
                  : !requestStyle.colors.length
                    ? 'The style has no colours yet. Add them in Request & tech pack.'
                    : !toAdd.length
                      ? 'Every colour of the style is in the grid'
                      : undefined
              }
              onChange={(e) => {
                if (!e.target.value) return
                update((d) => addColour(d, e.target.value))
                focusRow(draft.colours.length)
              }}
            >
              <option value="">
                {!requestStyle
                  ? 'No style yet'
                  : !toAdd.length
                    ? 'All colours added'
                    : 'Add a colour…'}
              </option>
              {toAdd.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </SmartSelect>
          </div>
        }
      >
        <p className="text-muted-foreground mb-3 text-xs">
          Tick the sizes this round makes, then type the pieces of each colour in each size. Enter
          goes to the next box. Measurements are taken for every size with pieces.
        </p>
        {!requestStyle || !columns.length ? (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
            {!requestStyle
              ? 'Set the request’s style in Request & tech pack: its size run makes the columns here.'
              : 'The style has no size run yet. Give it one in Request & tech pack to fill the columns here.'}
          </p>
        ) : (
          <div className="border-border bg-card overflow-x-auto rounded-lg border">
            <table className="w-full min-w-max text-sm" onKeyDownCapture={sameBoxOnLine}>
              <thead className="bg-secondary/60">
                <tr className="border-border border-b">
                  <th className={cn(TH, 'w-44 pl-3')}>Colour</th>
                  {columns.map((c) => (
                    <th key={c.sizeId || 'none'} className={cn(TH, 'w-20 text-center')}>
                      <label
                        className="flex cursor-pointer flex-col items-center gap-1"
                        title={
                          c.inRun
                            ? c.on
                              ? `This round makes size ${sizeCode(c.sizeId)}. Untick to take it off.`
                              : `Tick to make size ${sizeCode(c.sizeId)} in this round`
                            : 'Not in the style’s size run. Untick to take it off.'
                        }
                      >
                        <span className={c.inRun ? '' : 'warn-text'}>{sizeCode(c.sizeId)}</span>
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={c.on}
                          onChange={(e) => toggleSize(c.sizeId, e.target.checked)}
                          aria-label={`Size ${sizeCode(c.sizeId)} is made in this round`}
                        />
                      </label>
                    </th>
                  ))}
                  <th className={cn(TH, 'w-20 text-right')}>Total</th>
                  <th className={cn(TH, 'w-12 pr-3')}>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.colours.map((r, i) => (
                  <tr key={i} data-colour-row={i} className="border-border/50 border-b">
                    <td className="py-1.5 pl-3 pr-2 align-middle">
                      {r.colour.trim() ? (
                        <span
                          className={cn('font-medium', !styleColour(r.colour) && 'warn-text')}
                          title={
                            styleColour(r.colour)
                              ? undefined
                              : 'Not one of the style’s colours. Take it off, or add it to the style.'
                          }
                        >
                          {r.colour}
                        </span>
                      ) : (
                        <SmartSelect
                          className={cn(CELL, 'border-accent')}
                          value=""
                          aria-label={`Row ${i + 1} colour`}
                          onChange={(e) =>
                            e.target.value && update((d) => nameColour(d, i, e.target.value))
                          }
                        >
                          <option value="">Pick the colour</option>
                          {toAdd.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </SmartSelect>
                      )}
                    </td>
                    {columns.map((c) => (
                      <td key={c.sizeId || 'none'} className="px-1.5 py-1.5 align-middle">
                        {c.on ? (
                          <StepInput
                            className={cn(CELL, 'w-full text-right tabular-nums')}
                            value={r.qty[c.sizeId] ? String(r.qty[c.sizeId]) : ''}
                            placeholder="0"
                            max={1000}
                            onValueChange={(v) => update((d) => setPieces(d, i, c.sizeId, v))}
                            aria-label={`${r.colour || `Row ${i + 1}`}, size ${sizeCode(c.sizeId)}: pieces`}
                          />
                        ) : (
                          <span className="text-muted-foreground block text-center">—</span>
                        )}
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-right align-middle font-semibold tabular-nums">
                      {totals.rows[i]}
                    </td>
                    <td className="py-1.5 pl-1 pr-3 text-right align-middle">
                      <button
                        type="button"
                        className="btn-ghost text-muted-foreground hover:text-destructive p-1"
                        onClick={() => dropColour(i)}
                        aria-label={`Take ${r.colour || `row ${i + 1}`} off this round`}
                        title="Take this colour off the round"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!draft.colours.length && (
                  <tr>
                    <td
                      colSpan={columns.length + 3}
                      className="text-muted-foreground px-3 py-4 text-center text-sm"
                    >
                      {requestStyle.colors.length
                        ? 'No colours yet. Add the colours this round makes with “Add a colour”.'
                        : 'The style has no colours yet. Add them in Request & tech pack, then add them here.'}
                    </td>
                  </tr>
                )}
              </tbody>
              {draft.colours.length > 0 && (
                <tfoot>
                  <tr className="bg-primary/5">
                    <td className="text-primary py-2.5 pl-3 pr-2 text-sm font-medium">Total</td>
                    {columns.map((c) => (
                      <td
                        key={c.sizeId || 'none'}
                        className="text-primary px-2 py-2.5 text-center font-semibold tabular-nums"
                      >
                        {c.on ? totals.cols[c.sizeId] : ''}
                      </td>
                    ))}
                    <td className="text-primary px-2 py-2.5 text-right font-mono text-base font-bold">
                      {totals.total}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </Section>
      <TabGaps gaps={gaps} />
      {dialog}
    </div>
  )
}
