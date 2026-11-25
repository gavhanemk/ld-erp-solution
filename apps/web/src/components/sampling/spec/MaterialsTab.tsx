'use client'
import { useState } from 'react'
import { Layers, Plus } from 'lucide-react'
import {
  piecesFor,
  SAMPLE_MATERIAL_SOURCE_LABEL,
  SAMPLE_MATERIAL_SOURCES,
  SAMPLE_MATERIAL_TYPES,
  type SampleItemOption,
  type SampleSpecGap,
  type SampleSpecification,
} from '@ld-erp/shared'
import { api } from '@/lib/api'
import { cn, formatRupees } from '@/lib/utils'
import { Section } from '@/components/purchase/Section'
import { NewItemDialog } from '@/components/purchase/NewItemDialog'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { ITEM_TYPE_LABEL } from '@/components/masters/itemFormFields'
import type { Lookups } from '../types'
import {
  duplicateLines,
  itemNamed,
  limitDecimals,
  lineCost,
  lineHasData,
  lineWithItem,
  lineWithSource,
  materialCost,
  MATERIAL_COST_LABEL,
  moveRow,
  newLine,
  plural,
  type EditLine,
  type SpecDraft,
} from '../specRules'
import { CELL, READOUT, RowTools, sameBoxOnLine, TabGaps, TH, useConfirm } from './parts'

type Update = (change: (d: SpecDraft) => SpecDraft) => void

/** Three places, as the store counts it: 12.5, 0.125. */
const qty3 = (n: number) => String(Math.round(n * 1000) / 1000)

/**
 * The sample BOM, laid out as the BOM master's components grid: one line per
 * part and material, with how much one piece takes and the wastage. What the
 * round needs of it is worked out from the colour × size grid (every colour,
 * or the line's own colour) by the shared arithmetic the server keeps; typing
 * it by hand needs a reason. Lines keep their own row once saved, so a
 * purchase linked to one stays with it.
 *
 * A line grid of the ERP: Enter goes down a column, Alt+A adds a line,
 * Alt+Delete removes one.
 */
export function MaterialsTab({
  draft,
  update,
  spec,
  lookups,
  items,
  onItemsFound,
  hasBuyer,
  gaps,
}: {
  draft: SpecDraft
  update: Update
  /** The specification as it would be saved: what the quantities are worked out from. */
  spec: SampleSpecification
  lookups: Lookups
  items: SampleItemOption[]
  /** Materials found or added from a line, for the page to keep offering. */
  onItemsFound: (items: SampleItemOption[]) => void
  hasBuyer: boolean
  gaps: SampleSpecGap[]
}) {
  const { ask, dialog } = useConfirm()
  // A material the masters do not have yet, being added from a line's list.
  const [adding, setAdding] = useState<{ key: string; typed: string } | null>(null)
  const itemById = new Map(items.map((i) => [i.id, i]))
  const deptName = (id: string | null) => lookups.departments.find((d) => d.id === id)?.name
  const deptLive = (id: string | null) => !id || lookups.departments.some((d) => d.id === id)
  const roundColours = draft.colours.map((r) => r.colour.trim()).filter(Boolean)
  // The lines as saved, in screen order; a blank new line has none.
  const saved = new Map(
    draft.lines.filter((l) => lineHasData(l)).map((l, i) => [l.key, spec.materials[i]] as const)
  )
  // Each repeated line, by its place in the saved list, with why.
  const twice = duplicateLines(spec.materials)
  const cost = materialCost(spec)

  const setLine = (key: string, patch: Partial<EditLine>) =>
    update((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
  const pickItem = (l: EditLine, item: SampleItemOption | undefined) =>
    update((d) => ({
      ...d,
      lines: d.lines.map((x) =>
        x.key === l.key ? lineWithItem(x, item, itemById.get(x.itemId)) : x
      ),
    }))
  /*
   * A name the list does not have: someone may have added it in the masters
   * since this page read its list, so the server is asked first. One of that
   * name is picked; otherwise anything near it joins the list, and the window
   * to add it opens (which refuses a name already in use).
   */
  const createFor = async (l: EditLine, typed: string) => {
    let found: SampleItemOption[] = []
    try {
      const q = encodeURIComponent(typed.trim().slice(0, 100))
      found = (await api.get<{ data: SampleItemOption[] }>(`/sampling/items/search?q=${q}&limit=20`))
        .data
    } catch {
      // Not found is not a stop: the window below adds it.
    }
    if (found.length) onItemsFound(found)
    const same = itemNamed(found, typed)
    if (same) pickItem(l, same)
    else setAdding({ key: l.key, typed })
  }
  const addLine = () => update((d) => ({ ...d, lines: [...d.lines, newLine()] }))
  const removeLine = (l: EditLine, i: number) => {
    const go = () => update((d) => ({ ...d, lines: d.lines.filter((x) => x.key !== l.key) }))
    if (!lineHasData(l)) return go()
    const item = itemById.get(l.itemId)
    const what = [l.component.trim(), item?.name].filter(Boolean).join(': ') || `Line ${i + 1}`
    ask({
      title: `Remove ${what}?`,
      description: `${what} comes off this round’s materials, and its row goes when the draft is saved.`,
      confirmLabel: 'Remove the line',
      run: go,
    })
  }

  return (
    <div className="space-y-4">
      <Section
        icon={Layers}
        title={spec.materials.length ? `Sample BOM (${spec.materials.length})` : 'Sample BOM'}
        actions={
          <button
            type="button"
            className="btn-secondary h-8 px-3 text-xs"
            data-grid-add
            aria-keyshortcuts="Alt+A"
            disabled={draft.lines.length >= 100}
            onClick={addLine}
          >
            <Plus size={14} /> Add a material
          </button>
        }
      >
        <p className="text-muted-foreground mb-3 text-xs">
          Everything one piece uses, from the tech pack. The quantity needed is worked out from the
          pieces in Style & colours, for every colour or for the line’s own; an amber edge marks
          what a line still needs.
          {!hasBuyer &&
            ' This request has no buyer, so every material is one we buy; set the buyer in Request & tech pack for material the buyer sends.'}
        </p>
        <div data-grid className="border-border bg-card overflow-x-auto rounded-lg border">
          <table
            className="w-full min-w-[1660px] table-fixed text-sm"
            onKeyDownCapture={sameBoxOnLine}
          >
            <colgroup>
              <col className="w-10" />
              <col className="w-36" />
              <col className="w-72" />
              <col className="w-36" />
              <col className="w-40" />
              <col className="w-28" />
              <col className="w-14" />
              <col className="w-24" />
              <col className="w-44" />
              <col className="w-36" />
              <col className="w-28" />
              <col className="w-48" />
              <col className="w-24" />
            </colgroup>
            <thead className="bg-secondary/60">
              <tr className="border-border border-b">
                <th className={cn(TH, 'pl-3')}>#</th>
                <th className={TH} title="Which part of the garment it goes into">
                  Part
                </th>
                <th className={TH}>Material</th>
                <th className={TH}>Colour</th>
                <th className={TH} title="Who draws it from the store; blank is the item’s own">
                  Department
                </th>
                <th className={cn(TH, 'text-right')}>Qty / pc</th>
                <th className={TH}>Unit</th>
                <th className={cn(TH, 'text-right')}>Wastage %</th>
                <th className={cn(TH, 'text-right')}>Required</th>
                <th className={TH}>Source</th>
                <th className={cn(TH, 'text-right')}>
                  Est. rate <span className="font-medium normal-case tracking-normal">(₹)</span>
                </th>
                <th className={TH}>Remarks</th>
                <th className={cn(TH, 'pr-3')}>
                  <span className="sr-only">Move or remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => {
                const item = itemById.get(l.itemId)
                const line = saved.get(l.key)
                const at = line ? spec.materials.indexOf(line) : -1
                const unit = item?.uom?.symbol ?? ''
                const filled = lineHasData(l)
                const pieces = piecesFor(spec, l.colour)
                const stale =
                  l.colour && !roundColours.some((c) => c.toLowerCase() === l.colour!.toLowerCase())
                const dup = at >= 0 ? twice.get(at) : undefined
                const deptGone = !deptLive(l.departmentId)
                const buyerSends = l.source === 'BUYER_SUPPLIED'
                return (
                  <tr key={l.key} data-grid-row className="border-border/50 border-b align-top">
                    <td className="text-primary py-2 pl-3 pr-1 font-mono text-xs font-semibold leading-9">
                      {i + 1}
                    </td>
                    <td className="px-1.5 py-1.5">
                      <input
                        className={cn(
                          CELL,
                          'w-full',
                          filled && !l.component.trim() && 'border-accent'
                        )}
                        maxLength={60}
                        placeholder="e.g. Body"
                        value={l.component}
                        onChange={(e) => setLine(l.key, { component: e.target.value })}
                        aria-label={`Line ${i + 1} part`}
                      />
                    </td>
                    <td className="px-1.5 py-1.5">
                      <SmartSelect
                        className={cn(
                          CELL,
                          'w-full',
                          ((filled && !l.itemId) || dup) && 'border-accent'
                        )}
                        value={l.itemId}
                        title={dup ?? (item ? `${item.code} — ${item.name}` : undefined)}
                        aria-label={`Line ${i + 1} material`}
                        createNoun="material"
                        onCreate={(typed) => void createFor(l, typed)}
                        onChange={(e) => pickItem(l, itemById.get(e.target.value))}
                      >
                        <option value="">Pick a material…</option>
                        {l.itemId && !item && (
                          <option value={l.itemId}>Not in use any more: pick another</option>
                        )}
                        {items.map((it) => (
                          <option
                            key={it.id}
                            value={it.id}
                            data-sub={[
                              it.uom ? `${it.uom.name} (${it.uom.symbol})` : 'No unit',
                              ITEM_TYPE_LABEL[it.type]?.label ?? it.type,
                            ].join(' · ')}
                          >
                            {it.code} — {it.name}
                          </option>
                        ))}
                      </SmartSelect>
                      {dup && <span className="warn-text mt-1 block text-xs">{dup}</span>}
                    </td>
                    <td className="px-1.5 py-1.5">
                      <SmartSelect
                        className={cn(CELL, 'w-full', stale && 'border-accent')}
                        value={l.colour ?? ''}
                        aria-label={`Line ${i + 1} colour`}
                        onChange={(e) => setLine(l.key, { colour: e.target.value || null })}
                      >
                        <option value="">All colours</option>
                        {stale && <option value={l.colour!}>{l.colour} (not in this round)</option>}
                        {roundColours.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </SmartSelect>
                    </td>
                    <td className="px-1.5 py-1.5">
                      <SmartSelect
                        className={cn(CELL, 'w-full', deptGone && 'border-accent')}
                        value={l.departmentId ?? ''}
                        aria-label={`Line ${i + 1} department`}
                        title={
                          deptGone
                            ? 'That department is no longer in use: pick another, or the item’s own'
                            : 'Who draws it from the store'
                        }
                        onChange={(e) => setLine(l.key, { departmentId: e.target.value || null })}
                      >
                        <option value="">
                          {item?.departmentId
                            ? `Item’s own (${deptName(item.departmentId) ?? 'department'})`
                            : 'Item’s own'}
                        </option>
                        {/* Switched off since it was picked: shown, so the line says what to change. */}
                        {deptGone && (
                          <option value={l.departmentId!}>No longer in use: pick another</option>
                        )}
                        {lookups.departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </SmartSelect>
                    </td>
                    <td className="px-1.5 py-1.5">
                      <StepInput
                        decimals
                        step={0.1}
                        max={99999}
                        className={cn(
                          CELL,
                          'w-full text-right tabular-nums',
                          !!l.itemId && !(Number(l.qtyPerPiece) > 0) && 'border-accent'
                        )}
                        placeholder="0"
                        value={l.qtyPerPiece}
                        onValueChange={(v) => setLine(l.key, { qtyPerPiece: limitDecimals(v, 4) })}
                        aria-label={`Line ${i + 1} quantity per piece${unit ? `, in ${unit}` : ''}`}
                      />
                    </td>
                    <td className="text-muted-foreground px-1.5 py-2 text-xs leading-5">
                      {unit || '—'}
                    </td>
                    <td className="px-1.5 py-1.5">
                      <StepInput
                        decimals
                        max={100}
                        className={cn(CELL, 'w-full text-right tabular-nums')}
                        placeholder="0"
                        value={l.wastagePct}
                        onValueChange={(v) => setLine(l.key, { wastagePct: limitDecimals(v, 2) })}
                        aria-label={`Line ${i + 1} wastage percent`}
                      />
                    </td>
                    <td className="px-1.5 py-1.5">
                      <div className="space-y-1">
                        {l.requiredOverride ? (
                          <StepInput
                            decimals
                            max={999999}
                            className={cn(
                              CELL,
                              'w-full text-right tabular-nums',
                              !(Number(l.requiredQty) > 0) && 'border-accent'
                            )}
                            placeholder="0"
                            value={l.requiredQty}
                            onValueChange={(v) =>
                              setLine(l.key, { requiredQty: limitDecimals(v, 3) })
                            }
                            aria-label={`Line ${i + 1} quantity needed, typed by hand`}
                          />
                        ) : (
                          <div
                            className={READOUT}
                            title={
                              line
                                ? `${plural(pieces, 'piece')}${l.colour ? ` of ${l.colour}` : ''} × ${l.qtyPerPiece || 0}${unit ? ` ${unit}` : ''}${Number(l.wastagePct) > 0 ? ` and ${l.wastagePct}% wastage` : ''}`
                                : undefined
                            }
                          >
                            <span className="font-mono font-semibold">
                              {line ? qty3(line.requiredQty) : '—'}
                            </span>
                            {unit && <span className="text-muted-foreground text-xs">{unit}</span>}
                          </div>
                        )}
                        <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={l.requiredOverride}
                            onChange={(e) =>
                              setLine(l.key, {
                                requiredOverride: e.target.checked,
                                // Starts from the worked-out figure, to change.
                                requiredQty:
                                  e.target.checked && !l.requiredQty && line
                                    ? qty3(line.requiredQty)
                                    : l.requiredQty,
                              })
                            }
                            aria-label={`Line ${i + 1}: type the quantity needed by hand`}
                          />
                          Override
                        </label>
                        {l.requiredOverride && (
                          <input
                            className={cn(
                              CELL,
                              'w-full text-xs',
                              l.overrideReason.trim().length < 5 && 'border-accent'
                            )}
                            maxLength={500}
                            placeholder="Why, e.g. minimum roll length"
                            value={l.overrideReason}
                            onChange={(e) => setLine(l.key, { overrideReason: e.target.value })}
                            aria-label={`Line ${i + 1}: why the quantity is typed by hand`}
                          />
                        )}
                      </div>
                    </td>
                    <td className="px-1.5 py-1.5">
                      <SmartSelect
                        className={cn(
                          CELL,
                          'w-full',
                          l.source === 'BUYER_SUPPLIED' && !hasBuyer && 'border-accent'
                        )}
                        value={l.source}
                        aria-label={`Line ${i + 1} source`}
                        title={
                          hasBuyer
                            ? undefined
                            : 'No buyer on this request, so the buyer cannot send material'
                        }
                        onChange={(e) =>
                          update((d) => ({
                            ...d,
                            lines: d.lines.map((x) =>
                              x.key === l.key
                                ? lineWithSource(
                                    x,
                                    e.target.value as EditLine['source'],
                                    itemById.get(x.itemId)
                                  )
                                : x
                            ),
                          }))
                        }
                      >
                        {SAMPLE_MATERIAL_SOURCES.map((s) => (
                          <option
                            key={s}
                            value={s}
                            disabled={s === 'BUYER_SUPPLIED' && !hasBuyer && l.source !== s}
                          >
                            {SAMPLE_MATERIAL_SOURCE_LABEL[s]}
                          </option>
                        ))}
                      </SmartSelect>
                    </td>
                    <td className="px-1.5 py-1.5">
                      <StepInput
                        decimals
                        max={999999}
                        className={cn(CELL, 'w-full text-right tabular-nums')}
                        placeholder={
                          !buyerSends && item?.standardRate != null ? `std ${item.standardRate}` : '—'
                        }
                        value={l.estRate}
                        title={
                          buyerSends
                            ? 'The buyer sends it, so it is not in the estimated cost'
                            : line && lineCost(line, spec) !== null
                              ? `${formatRupees(lineCost(line, spec))} for this line`
                              : 'What we expect to pay for one unit, before anything is bought'
                        }
                        onValueChange={(v) => setLine(l.key, { estRate: limitDecimals(v, 4) })}
                        aria-label={`Line ${i + 1} expected rate${unit ? ` per ${unit}` : ''}`}
                      />
                    </td>
                    <td className="px-1.5 py-1.5">
                      <input
                        className={cn(CELL, 'w-full')}
                        maxLength={500}
                        placeholder="Shade, size, supplier note"
                        value={l.remarks}
                        onChange={(e) => setLine(l.key, { remarks: e.target.value })}
                        aria-label={`Line ${i + 1} remarks`}
                      />
                    </td>
                    <td className="py-1.5 pl-1 pr-3">
                      <RowTools
                        index={i}
                        count={draft.lines.length}
                        noun="material line"
                        onMove={(dir) => update((d) => ({ ...d, lines: moveRow(d.lines, i, dir) }))}
                        onRemove={() => removeLine(l, i)}
                      />
                    </td>
                  </tr>
                )
              })}
              {!draft.lines.length && (
                <tr>
                  <td colSpan={13} className="text-muted-foreground px-3 py-4 text-center text-sm">
                    No materials yet. Add the fabric, trims and packing the tech pack lists, one
                    line for each part and material.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-primary/5">
                <td colSpan={8} className="text-primary py-2.5 pl-3 pr-2 text-sm font-medium">
                  {plural(spec.materials.length, 'line')}
                  {cost.unrated > 0 && (
                    <span className="text-muted-foreground font-normal">
                      {' '}
                      · {plural(cost.unrated, 'line')} we buy with no expected rate
                    </span>
                  )}
                </td>
                <td colSpan={3} className="text-primary px-2 py-2.5 text-right text-sm font-medium">
                  {MATERIAL_COST_LABEL}
                </td>
                <td colSpan={2} className="text-primary px-3 py-2.5 font-mono text-base font-bold">
                  {formatRupees(cost.total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>
      <TabGaps gaps={gaps} />
      {adding && (
        <NewItemDialog<SampleItemOption>
          endpoint="/sampling/items"
          allowedTypes={SAMPLE_MATERIAL_TYPES}
          categories={lookups.itemCategories}
          uoms={lookups.uoms}
          initialName={adding.typed}
          onClose={() => setAdding(null)}
          onCreated={(created) => {
            const key = adding.key
            setAdding(null)
            onItemsFound([created])
            update((d) => ({
              ...d,
              lines: d.lines.map((x) =>
                x.key === key ? lineWithItem(x, created, itemById.get(x.itemId)) : x
              ),
            }))
          }}
        />
      )}
      {dialog}
    </div>
  )
}
