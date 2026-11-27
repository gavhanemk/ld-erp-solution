'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Loader2, PackagePlus, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { MasterFormDialog } from '@/components/masters/MasterFormDialog'
import { itemFormFields } from '@/components/masters/itemFormFields'
import { formatDate } from '@/lib/utils'

/** Where the item form's rate came from: the approved BOM's cost per piece. */
interface RateFrom {
  style: string
  version: string
  color: string | null
  costPerPiece: number
  approvedAt: string | null
}

/** The note under Standard Rate: which BOM it is, or why there is none. */
function rateNote(code: string, rateFrom: RateFrom | null, bom: { version: string; color: string | null } | null) {
  const which = (v: string, c: string | null) => `${code} BOM v${v} (${c || 'all colours'})`
  if (rateFrom) {
    return `From ${which(rateFrom.version, rateFrom.color)}${rateFrom.approvedAt ? `, approved ${formatDate(rateFrom.approvedAt)}` : ''}: its cost per piece, ₹${rateFrom.costPerPiece.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  if (bom) return `${which(bom.version, bom.color)} has no cost per piece yet: cost it on the BOM, or type the rate`
  return `${code} has no approved BOM yet: type the rate, or leave it for later`
}

/** A style a direct order can make: switched on, out of sampling. */
export interface DirectStyle {
  id: string
  code: string
  name: string
  brandType: string
  colors: string[]
}

/** One style as a line needs it: its size run, and by colour the finished item and BOM. */
export interface StyleInfo {
  style: { id: string; code: string; name: string; brandType: string }
  sizes: Array<{ id: string; code: string }>
  colours: Array<{ color: string; item: { id: string; code: string; name: string } | null; bom: { id: string; version: string; color: string | null } | null }>
}

/** A direct order's line as the form holds it. */
export interface DirectLine {
  key: string
  styleId: string
  color: string
  sizes: Record<string, string>
  qty: string
}

let seq = 0
export const newDirectLine = (styleId = '', color = ''): DirectLine => ({ key: `d${++seq}`, styleId, color, sizes: {}, qty: '' })

const pcs = (n: number) => n.toLocaleString('en-IN')

/** The pieces a line makes: by size where the style has a size run, else its total. */
export function directTotal(l: DirectLine, info: StyleInfo | undefined) {
  if (info?.sizes.length) return info.sizes.reduce((t, s) => t + (Number(l.sizes[s.id]) || 0), 0)
  return Number(l.qty) || 0
}

/** Why a line cannot be saved as it is, or null. */
export function directProblem(l: DirectLine, info: StyleInfo | undefined, code: string) {
  if (!l.styleId) return 'Pick the style of each line.'
  if (!info) return null
  const colours = info.colours.filter((c) => c.color)
  if (colours.length && !l.color) return `${code}: pick the colour.`
  const c = info.colours.find((x) => x.color.toLowerCase() === l.color.toLowerCase())
  if (c && !c.item && directTotal(l, info) > 0) return `${code}${l.color ? ` ${l.color}` : ''} has no finished item yet: add it with Add item on the line.`
  return null
}

/**
 * The lines of a direct manufacturing order: for each, the style, its colour,
 * the finished item its pieces are booked in as, the BOM it is made to, and
 * the pieces by size. A colour with no finished item yet is added with Add
 * item: the Items & Products form itself, over this one, started like the
 * style's other colours — every field there to check, saved under the Items
 * permission like any item.
 */
export function DirectMoLines({
  styles,
  lines,
  infos,
  onChange,
  onInfo,
  disabled,
}: {
  styles: DirectStyle[]
  lines: DirectLine[]
  /** Each style's detail, by id, as fetched. */
  infos: Record<string, StyleInfo>
  onChange: (lines: DirectLine[]) => void
  onInfo: (styleId: string, info: StyleInfo) => void
  disabled?: boolean
}) {
  // A colour's finished item being added on the Items & Products form, and what it starts at.
  const [adding, setAdding] = useState<{ styleId: string; values: Record<string, unknown>; note: string } | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mayAddItem = can('masters.items', 'create')

  // Each style picked: its sizes, colours, items and BOMs, once.
  useEffect(() => {
    const missing = [...new Set(lines.map((l) => l.styleId).filter((id) => id && !infos[id]))]
    for (const id of missing) {
      api
        .get<{ data: StyleInfo }>(`/production/direct/styles/${id}`)
        .then((r) => onInfo(id, r.data))
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the style.'))
    }
  }, [lines, infos, onInfo])

  const set = (key: string, patch: Partial<DirectLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  // The item form, started like the style's other colours.
  const addItem = async (l: DirectLine) => {
    setOpening(l.key)
    setError(null)
    try {
      const qs = new URLSearchParams({ styleId: l.styleId, colour: l.color })
      const r = await api.get<{ data: { values: Record<string, unknown>; rateFrom: RateFrom | null; bom: { version: string; color: string | null } | null } }>(
        `/production/direct/item-template?${qs}`
      )
      const code = styles.find((x) => x.id === l.styleId)?.code ?? 'The style'
      setAdding({ styleId: l.styleId, values: r.data.values, note: rateNote(code, r.data.rateFrom, r.data.bom) })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the item form.')
    } finally {
      setOpening(null)
    }
  }
  // Saved: the style's colours read again, so the line shows its new item.
  const added = async () => {
    const styleId = adding?.styleId
    setAdding(null)
    if (!styleId) return
    try {
      const r = await api.get<{ data: StyleInfo }>(`/production/direct/styles/${styleId}`)
      onInfo(styleId, r.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the style again.')
    }
  }

  return (
    <div className="space-y-3" data-grid>
      {error && (
        <p className="text-destructive flex items-start gap-1.5 text-xs">
          <AlertCircle size={13} className="mt-px shrink-0" />
          {error}
        </p>
      )}
      {lines.map((l, i) => {
        const st = styles.find((x) => x.id === l.styleId)
        const info = l.styleId ? infos[l.styleId] : undefined
        const colour = info?.colours.find((c) => c.color.toLowerCase() === l.color.toLowerCase())
        const total = directTotal(l, info)
        const code = st?.code ?? info?.style.code ?? 'This style'
        return (
          <div key={l.key} data-grid-row className="border-border bg-card rounded-lg border p-3">
            <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.4fr)_auto]">
              <div className="min-w-0">
                <label className="form-label" htmlFor={`dm-style-${l.key}`}>
                  Style
                </label>
                <SmartSelect
                  id={`dm-style-${l.key}`}
                  className="form-input"
                  value={l.styleId}
                  disabled={disabled}
                  aria-label={`Line ${i + 1} style`}
                  onChange={(e) => {
                    const next = styles.find((x) => x.id === e.target.value)
                    // A new style: its own colour (the only one, when it has one), sizes afresh.
                    set(l.key, { styleId: e.target.value, color: next?.colors.length === 1 ? next.colors[0] : '', sizes: {}, qty: '' })
                  }}
                >
                  <option value="">Pick the style…</option>
                  {styles.map((x) => (
                    <option key={x.id} value={x.id} data-sub={x.name}>
                      {x.code}
                    </option>
                  ))}
                </SmartSelect>
              </div>
              <div className="min-w-0">
                <label className="form-label" htmlFor={`dm-colour-${l.key}`}>
                  Colour
                </label>
                <SmartSelect
                  id={`dm-colour-${l.key}`}
                  className="form-input"
                  value={l.color}
                  disabled={disabled || !l.styleId || !st?.colors.length}
                  aria-label={`Line ${i + 1} colour`}
                  onChange={(e) => set(l.key, { color: e.target.value })}
                >
                  <option value="">{st && !st.colors.length ? 'No colours' : 'Pick the colour…'}</option>
                  {(st?.colors ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </SmartSelect>
              </div>
              <div className="min-w-0">
                <span className="form-label">Finished item · BOM</span>
                <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  {!l.styleId || (st?.colors.length && !l.color) ? (
                    <span className="text-muted-foreground">Pick the style and colour</span>
                  ) : !info ? (
                    <Loader2 size={13} className="text-muted-foreground animate-spin" />
                  ) : colour?.item ? (
                    <span className="text-foreground">
                      <span className="font-mono text-teal-400">{colour.item.code}</span> {colour.item.name}
                    </span>
                  ) : (
                    <>
                      <span className="warn-text">No finished item for this colour yet</span>
                      <button
                        type="button"
                        className="btn-secondary h-7 px-2 text-xs"
                        disabled={disabled || opening === l.key || !mayAddItem}
                        title={mayAddItem ? 'Add it on the Items & Products form, started like the style’s other colours' : 'Adding items needs the Items “Add” permission: ask for it to be added in Masters → Items & Products'}
                        onClick={() => void addItem(l)}
                      >
                        {opening === l.key ? <Loader2 size={12} className="animate-spin" /> : <PackagePlus size={12} />} Add item
                      </button>
                    </>
                  )}
                  {info && colour && (
                    <span className={colour.bom ? 'text-primary' : 'warn-text'}>
                      {colour.bom ? `BOM v${colour.bom.version}${colour.bom.color ? ` ${colour.bom.color}` : ' (all colours)'}` : 'no approved BOM'}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-end justify-end">
                <button
                  type="button"
                  className="btn-ghost text-muted-foreground hover:text-destructive h-9 px-2"
                  onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
                  disabled={disabled || lines.length === 1}
                  aria-label={`Remove line ${i + 1}`}
                  title="Remove this line"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            {info && (!st?.colors.length || l.color) && (
              <div className="mt-2 overflow-x-auto">
                <table className="subtable w-auto">
                  <thead>
                    <tr>
                      <th className="text-left" />
                      {info.sizes.length ? (
                        info.sizes.map((s) => (
                          <th key={s.id} className="w-16 text-center">
                            {s.code}
                          </th>
                        ))
                      ) : (
                        <th className="w-24 text-center">Pieces</th>
                      )}
                      <th className="w-16 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="text-foreground pr-4 text-xs font-medium">Make</td>
                      {info.sizes.length ? (
                        info.sizes.map((s) => (
                          <td key={s.id} className="px-1 py-1">
                            <StepInput
                              className="form-input h-8 w-14 px-1 text-center text-xs tabular-nums"
                              value={l.sizes[s.id] ?? ''}
                              placeholder="0"
                              disabled={disabled}
                              aria-label={`${code} ${l.color} size ${s.code}, make`}
                              onValueChange={(v) => set(l.key, { sizes: { ...l.sizes, [s.id]: v } })}
                            />
                          </td>
                        ))
                      ) : (
                        <td className="px-1 py-1">
                          <StepInput
                            className="form-input h-8 w-20 px-1 text-center text-xs tabular-nums"
                            value={l.qty}
                            placeholder="0"
                            disabled={disabled}
                            aria-label={`${code} ${l.color}, make`}
                            onValueChange={(v) => set(l.key, { qty: v })}
                          />
                        </td>
                      )}
                      <td className="text-foreground text-right text-xs font-semibold tabular-nums">{pcs(total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
      <button type="button" className="btn-secondary h-8 text-xs" onClick={() => onChange([...lines, newDirectLine()])} disabled={disabled}>
        <Plus size={13} /> Add a style
      </button>
      {adding && (
        <MasterFormDialog
          open
          stacked
          wide
          columns={4}
          title="Item"
          resource="items"
          // Standard Rate says which BOM its figure is from.
          fields={itemFormFields.map((f) => (f.name === 'standardRate' ? { ...f, help: adding.note } : f))}
          initialValues={adding.values}
          onClose={() => setAdding(null)}
          onSaved={() => void added()}
        />
      )}
    </div>
  )
}
