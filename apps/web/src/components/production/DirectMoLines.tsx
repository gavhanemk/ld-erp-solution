'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

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
  if (c && !c.item && directTotal(l, info) > 0) return `${code}${l.color ? ` ${l.color}` : ''} has no finished item yet: press Make it on the line.`
  return null
}

/**
 * The lines of a direct manufacturing order (stock or samples): for each,
 * the style, its colour, the finished item its pieces are booked in as, the
 * BOM it is made to, and the pieces by size. A colour with no finished item
 * yet gets one with Make it, made like the style's other colours.
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
  const [making, setMaking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const makeItem = async (l: DirectLine) => {
    setMaking(l.key)
    setError(null)
    try {
      await api.post('/production/direct/colour-item', { styleId: l.styleId, colour: l.color })
      const r = await api.get<{ data: StyleInfo }>(`/production/direct/styles/${l.styleId}`)
      onInfo(l.styleId, r.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not make the item.')
    } finally {
      setMaking(null)
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
                      <span className="warn-text">No finished item yet</span>
                      <button type="button" className="btn-secondary h-7 px-2 text-xs" disabled={disabled || making === l.key} onClick={() => void makeItem(l)}>
                        {making === l.key ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Make it
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
    </div>
  )
}
