'use client'

import { useState, type ReactNode } from 'react'
import { AlertCircle, ExternalLink, RefreshCw, Wand2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { cellKey, money, num, styleRows, type FormOptions, type StyleOption } from './kinds'

/**
 * One style's pieces: its own sizes across, its own colours down, a rate for
 * each size (one figure fills them all), and the totals — per colour, per
 * size, for the style. Only what the style is set up with can take pieces;
 * what is missing is put right here: a colour's item made, a size run given,
 * or the style's master opened in a new tab and the list reloaded, so the
 * entry is never lost.
 */
export function StyleGrid({
  style,
  rates,
  qty,
  onRates,
  onQty,
  sizeRuns,
  mayMakeItems,
  maySetSizeRun,
  onColourMade,
  onReload,
  only = '',
  onOnly,
}: {
  style: StyleOption
  rates: Record<string, string>
  qty: Record<string, string>
  onRates: (rates: Record<string, string>) => void
  onQty: (qty: Record<string, string>) => void
  sizeRuns: FormOptions['sizeRuns']
  mayMakeItems: boolean
  maySetSizeRun: boolean
  onColourMade: (colour: string, item: { id: string; code: string }) => void
  /** Masters were changed: fetch the styles again (the entry stays as it is). */
  onReload: () => Promise<void> | void
  /** The item picked by its code, name or description; empty shows all the style's items. */
  only?: string
  onOnly?: (itemId: string) => void
}) {
  const [making, setMaking] = useState<string | null>(null)
  const [choose, setChoose] = useState<{ colour: string; categories: Array<{ id: string; name: string }>; categoryId: string } | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [allRate, setAllRate] = useState('')
  const [run, setRun] = useState('')
  const [busy, setBusy] = useState(false)

  // A row a colour (with its item) or another item of the style; cells keyed by the row.
  const rows = styleRows(style)
  const items = style.items ?? []
  const pieces = (key: string) => style.sizes.reduce((n, s) => n + Number(qty[cellKey(key, s.id)] || 0), 0)
  const valueOf = (key: string) => style.sizes.reduce((n, s) => n + Number(qty[cellKey(key, s.id)] || 0) * Number(rates[s.id] || 0), 0)
  const sizeTotal = (sizeId: string) => rows.reduce((n, r) => n + Number(qty[cellKey(r.key, sizeId)] || 0), 0)
  const total = rows.reduce((n, r) => n + pieces(r.key), 0)
  const totalValue = rows.reduce((n, r) => n + valueOf(r.key), 0)
  // The item picked shows; a row with pieces typed in stays in view, so nothing entered is hidden.
  const picked = items.some((i) => i.id === only) ? only : ''
  const shown = picked ? rows.filter((r) => r.item?.id === picked || pieces(r.key) > 0) : rows
  const hidden = rows.length - shown.length

  const makeItem = async (colour: string, categoryId?: string) => {
    setMaking(colour)
    setNote(null)
    try {
      const res = await api.post<{ message?: string; data: { item?: { id: string; code: string }; needCategory?: boolean; categories?: Array<{ id: string; name: string }> } }>(
        '/inventory/opening-stock/colour-item',
        { styleId: style.id, colour, categoryId: categoryId ?? null },
      )
      if (res.data.needCategory) {
        setChoose({ colour, categories: res.data.categories ?? [], categoryId: '' })
        return
      }
      if (res.data.item) {
        onColourMade(colour, res.data.item)
        setChoose(null)
        setNote({ ok: true, text: res.message ?? `${colour}: item made.` })
      }
    } catch (err) {
      setNote({ ok: false, text: err instanceof ApiError ? err.message : 'Could not make the item.' })
    } finally {
      setMaking(null)
    }
  }

  const giveSizeRun = async () => {
    if (!run) return
    setBusy(true)
    setNote(null)
    try {
      const res = await api.post<{ message: string }>('/inventory/opening-stock/style-size-run', { styleId: style.id, sizeGroupId: run })
      await onReload()
      setNote({ ok: true, text: res.message })
    } catch (err) {
      setNote({ ok: false, text: err instanceof ApiError ? err.message : 'Could not give the style its size run.' })
    } finally {
      setBusy(false)
    }
  }

  const reload = async () => {
    setBusy(true)
    try {
      await onReload()
    } finally {
      setBusy(false)
    }
  }

  if (style.colours.length === 0 && items.length === 0) {
    return (
      <Missing>
        {style.code} has no colours yet. Add them to the style, then reload.
        <a className="text-primary inline-flex items-center gap-1 font-medium hover:underline" href="/masters/styles" target="_blank" rel="noreferrer">
          Open Styles <ExternalLink size={12} />
        </a>
        <ReloadButton busy={busy} onClick={() => void reload()} />
      </Missing>
    )
  }
  if (style.sizes.length === 0) {
    return (
      <div className="space-y-2">
        <Missing>
          {style.code} has no size run yet, so its sizes are not known.
          {maySetSizeRun ? ' Give it one:' : ' Ask someone who can edit Styles to give it one, then reload.'}
          {!maySetSizeRun && <ReloadButton busy={busy} onClick={() => void reload()} />}
        </Missing>
        {maySetSizeRun && (
          <div className="flex flex-wrap items-center gap-2">
            <SmartSelect className="form-input h-9 w-72" value={run} onChange={(e) => setRun(e.target.value)} aria-label={`Size run for ${style.code}`}>
              <option value="">Pick a size run…</option>
              {sizeRuns.map((r) => (
                <option key={r.id} value={r.id} data-sub={r.sizes.join(' · ')}>
                  {r.name}
                </option>
              ))}
            </SmartSelect>
            <button type="button" className="btn-primary h-9 text-sm" disabled={!run || busy} onClick={() => void giveSizeRun()}>
              Give {style.code} this size run
            </button>
          </div>
        )}
        {note && <p className={cn('text-xs', note.ok ? 'text-emerald-500' : 'text-red-400')}>{note.text}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* The style's items, picked by code, name or description: the three move together. */}
      {items.length > 0 && onOnly && (
        <div className="flex flex-wrap items-end gap-2" aria-label={`Items of ${style.code}`}>
          <ItemField label="Item Code" value={picked} onChange={onOnly} style={style.code} all={items.length}>
            {items.map((i) => (
              <option key={i.id} value={i.id} data-sub={[i.name, i.colour].filter(Boolean).join(' · ')}>
                {i.code}
              </option>
            ))}
          </ItemField>
          <ItemField label="Item Name" value={picked} onChange={onOnly} style={style.code} all={items.length} wide>
            {items.map((i) => (
              <option key={i.id} value={i.id} data-sub={[i.code, i.colour].filter(Boolean).join(' · ')}>
                {i.name}
              </option>
            ))}
          </ItemField>
          <ItemField label="Item Description" value={picked} onChange={onOnly} style={style.code} all={items.length} wide>
            {items.map((i) => (
              <option key={i.id} value={i.id} data-sub={`${i.code} · ${i.name}`}>
                {i.description || `No description (${i.code})`}
              </option>
            ))}
          </ItemField>
          {picked && (
            <button type="button" className="text-primary h-9 text-xs font-medium hover:underline" onClick={() => onOnly('')}>
              Show all of {style.code}{hidden ? ` (${hidden} more ${hidden === 1 ? 'row' : 'rows'})` : ''}
            </button>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="subtable text-sm">
          <thead>
            <tr className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
              <th className="min-w-44 py-1.5 pr-3 text-left">Colour</th>
              {style.sizes.map((s) => (
                <th key={s.id} className="w-20 px-1 py-1.5 text-center">
                  {s.code}
                </th>
              ))}
              <th className="px-3 py-1.5 text-right">Pieces</th>
              <th className="px-3 py-1.5 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-secondary/40">
              <td className="py-1.5 pr-3">
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-xs font-semibold">Rate per piece ₹</span>
                  <StepInput
                    className="form-input h-8 w-20 text-right text-xs"
                    value={allRate}
                    decimals
                    onValueChange={(v) => {
                      setAllRate(v)
                      onRates(Object.fromEntries(style.sizes.map((s) => [s.id, v])))
                    }}
                    placeholder="All"
                    aria-label={`Rate for every size of ${style.code}`}
                    title="One rate for every size; change any size after"
                  />
                </div>
              </td>
              {style.sizes.map((s) => (
                <td key={s.id} className="px-1 py-1.5">
                  <StepInput
                    className="form-input h-8 text-right text-xs"
                    value={rates[s.id] ?? ''}
                    decimals
                    onValueChange={(v) => onRates({ ...rates, [s.id]: v })}
                    aria-label={`Rate for size ${s.code}`}
                  />
                </td>
              ))}
              <td colSpan={2} />
            </tr>
            {shown.map((r) => {
              const c = r
              return (
              <tr key={r.key} className="border-border border-t">
                <td className="py-1.5 pr-3">
                  <div className="text-foreground font-medium">{c.colour || r.item?.code}</div>
                  {r.item ? (
                    <>
                      <div className="text-muted-foreground font-mono text-[11px]">{r.item.code}</div>
                      {r.item.name && <div className="text-muted-foreground max-w-56 truncate text-[11px]" title={r.item.name}>{r.item.name}</div>}
                      {r.item.description && (
                        <div className="text-muted-foreground max-w-56 truncate text-[11px] italic" title={r.item.description}>
                          {r.item.description}
                        </div>
                      )}
                    </>
                  ) : choose?.colour === c.colour ? (
                    <div className="mt-1 flex items-center gap-1">
                      <SmartSelect
                        className="form-input h-8 text-xs"
                        value={choose.categoryId}
                        onChange={(e) => setChoose({ ...choose, categoryId: e.target.value })}
                        aria-label={`Category for ${style.code} ${c.colour}`}
                      >
                        <option value="">File under…</option>
                        {choose.categories.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.name}
                          </option>
                        ))}
                      </SmartSelect>
                      <button type="button" className="btn-primary h-8 px-2 text-xs" disabled={!choose.categoryId || making === c.colour} onClick={() => void makeItem(c.colour, choose.categoryId)}>
                        Make
                      </button>
                    </div>
                  ) : mayMakeItems ? (
                    <button
                      type="button"
                      className="text-primary mt-0.5 flex items-center gap-1 text-[11px] hover:underline"
                      disabled={making === c.colour}
                      onClick={() => void makeItem(c.colour)}
                    >
                      <Wand2 size={11} /> {making === c.colour ? 'Making…' : 'No item yet — make it'}
                    </button>
                  ) : (
                    <div className="text-[11px] text-amber-500">No item yet: add it in Items &amp; Products</div>
                  )}
                </td>
                {style.sizes.map((s) => {
                  const q = Number(qty[cellKey(r.key, s.id)] || 0)
                  const noRate = q > 0 && !Number(rates[s.id] || 0)
                  return (
                    <td key={s.id} className="px-1 py-1.5">
                      <StepInput
                        className={cn('form-input h-8 text-right', !r.item && 'opacity-40', noRate && 'border-amber-500')}
                        value={qty[cellKey(r.key, s.id)] ?? ''}
                        disabled={!r.item}
                        onValueChange={(v) => onQty({ ...qty, [cellKey(r.key, s.id)]: v })}
                        aria-label={`Pieces of ${c.colour || r.item?.code} size ${s.code}`}
                        title={noRate ? `No rate for size ${s.code} yet` : undefined}
                      />
                    </td>
                  )
                })}
                <td className="text-foreground px-3 py-1.5 text-right font-semibold tabular-nums">{pieces(r.key) ? num(pieces(r.key)) : ''}</td>
                <td className="text-foreground px-3 py-1.5 text-right tabular-nums">{valueOf(r.key) ? money(valueOf(r.key)) : ''}</td>
              </tr>
              )
            })}
            <tr className="border-border bg-secondary/30 border-t font-semibold">
              <td className="text-foreground py-1.5 pr-3 text-xs">Total</td>
              {style.sizes.map((s) => (
                <td key={s.id} className="text-foreground px-1 py-1.5 text-center text-xs tabular-nums">
                  {sizeTotal(s.id) || ''}
                </td>
              ))}
              <td className="text-foreground px-3 py-1.5 text-right tabular-nums">{total ? num(total) : ''}</td>
              <td className="text-foreground px-3 py-1.5 text-right tabular-nums">{totalValue ? money(totalValue) : ''}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {note && <p className={cn('text-xs', note.ok ? 'text-emerald-500' : 'text-red-400')}>{note.text}</p>}
    </div>
  )
}

/** One of the three item fields: every item of the style by its code, name or description. */
function ItemField({
  label,
  value,
  onChange,
  style,
  all,
  wide = false,
  children,
}: {
  label: string
  value: string
  onChange: (itemId: string) => void
  style: string
  all: number
  wide?: boolean
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground font-semibold uppercase tracking-wide">{label}</span>
      <SmartSelect className={cn('form-input h-9 text-sm', wide ? 'w-72' : 'w-44')} value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} of ${style}`}>
        <option value="">All items ({all})</option>
        {children}
      </SmartSelect>
    </label>
  )
}

function Missing({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
      <AlertCircle size={14} className="shrink-0" />
      {children}
    </p>
  )
}

export function ReloadButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button type="button" className="text-primary inline-flex items-center gap-1 font-medium hover:underline" disabled={busy} onClick={onClick}>
      <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Reload
    </button>
  )
}
