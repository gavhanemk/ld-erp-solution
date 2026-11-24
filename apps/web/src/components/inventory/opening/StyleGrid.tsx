'use client'

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ChevronDown, ExternalLink, Loader2, PackagePlus, RefreshCw, SlidersHorizontal, X } from 'lucide-react'
import { useEscape } from '@/lib/useEscape'
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
  // The item a colour would get, shown before it is made.
  const [preview, setPreview] = useState<ItemPreview | null>(null)
  const [choose, setChoose] = useState<{ colour: string; categories: Array<{ id: string; name: string }>; categoryId: string } | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [allRate, setAllRate] = useState('')
  const [run, setRun] = useState('')
  const [busy, setBusy] = useState(false)
  const gridRef = useRef<HTMLTableElement>(null)
  // The item filters open by themselves when an item is picked (found by its code, say).
  const [filtersOpen, setFiltersOpen] = useState(Boolean(only))
  useEffect(() => {
    if (only) setFiltersOpen(true)
  }, [only])

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

  // First what the item would get, shown in a window; it is made only from there.
  const makeItem = async (colour: string, categoryId?: string) => {
    setMaking(colour)
    setNote(null)
    try {
      const res = await api.post<{ message?: string; data: { item?: { id: string; code: string; name?: string }; needCategory?: boolean; categories?: Array<{ id: string; name: string }>; preview?: Omit<ItemPreview, 'colourKey'> } }>(
        '/inventory/opening-stock/colour-item',
        { styleId: style.id, colour, categoryId: categoryId ?? null, preview: true },
      )
      if (res.data.needCategory) {
        setChoose({ colour, categories: res.data.categories ?? [], categoryId: '' })
        return
      }
      // Made meanwhile, by someone else: it is used.
      if (res.data.item) {
        onColourMade(colour, res.data.item)
        setChoose(null)
        return
      }
      if (res.data.preview) setPreview({ ...res.data.preview, colourKey: colour })
    } catch (err) {
      setNote({ ok: false, text: err instanceof ApiError ? err.message : 'Could not look up the item.' })
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

  // The boxes that take pieces, row by row: ← → at a box's edge moves along,
  // and a block copied from a sheet is spread over the boxes from where it is pasted.
  const entryRows = shown.filter((r) => r.item)
  const cellAt = (r: number, c: number) => gridRef.current?.querySelector<HTMLInputElement>(`input[data-cell="${r}:${c}"]`) ?? null
  const step = (r: number, c: number, dir: 1 | -1) => {
    for (let rr = r, cc = c + dir; rr >= 0 && rr < entryRows.length; ) {
      if (cc >= 0 && cc < style.sizes.length) return cellAt(rr, cc)
      rr += dir
      cc = dir > 0 ? 0 : style.sizes.length - 1
    }
    return null
  }
  const onCellKey = (r: number, c: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
    // Alt+↑ ↓: the same size of the colour above or below.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const next = cellAt(r + (e.key === 'ArrowDown' ? 1 : -1), c)
      if (next) {
        e.preventDefault()
        next.focus()
        next.select()
      }
      return
    }
    if ((e.key === 'ArrowRight' && atEnd) || (e.key === 'ArrowLeft' && atStart)) {
      const next = step(r, c, e.key === 'ArrowRight' ? 1 : -1)
      if (next) {
        e.preventDefault()
        next.focus()
        next.select()
      }
    }
  }
  const onCellPaste = (r: number, c: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\r/g, '').replace(/\n+$/, '')
    if (!/[\t\n]/.test(text)) return
    e.preventDefault()
    const next = { ...qty }
    let filled = 0
    text.split('\n').forEach((line, dr) => {
      const row = entryRows[r + dr]
      if (!row) return
      line.split('\t').forEach((v, dc) => {
        const size = style.sizes[c + dc]
        const n = Number(v.replace(/[,\s]/g, ''))
        if (!size || v.trim() === '' || !Number.isFinite(n) || n < 0) return
        next[cellKey(row.key, size.id)] = String(Math.round(n))
        filled++
      })
    })
    onQty(next)
    setNote({ ok: true, text: `${filled} ${filled === 1 ? 'box' : 'boxes'} filled from what was pasted.` })
  }
  const pickedItem = items.find((i) => i.id === picked)

  return (
    <div className="space-y-3">
      {/* The style's items, by code, name or description — folded away until wanted. */}
      {items.length > 0 && onOnly && (
        <div className="border-border rounded-lg border">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <button
              type="button"
              className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <SlidersHorizontal size={14} className="text-muted-foreground" />
              Filter by item
              <ChevronDown size={14} className={cn('text-muted-foreground transition-transform', filtersOpen && 'rotate-180')} />
            </button>
            {pickedItem ? (
              <span className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
                Showing {pickedItem.code}
                {hidden ? ` · ${hidden} more ${hidden === 1 ? 'row' : 'rows'} hidden` : ''}
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">
                All {items.length} {items.length === 1 ? 'item' : 'items'} shown
              </span>
            )}
            {picked && (
              <button type="button" className="text-primary ml-auto text-xs font-medium hover:underline" onClick={() => onOnly('')}>
                Show all of {style.code}
                {hidden ? ` (${hidden} more ${hidden === 1 ? 'row' : 'rows'})` : ''}
              </button>
            )}
          </div>
          {filtersOpen && (
            <div className="border-border grid gap-3 border-t px-3 py-3 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)]" aria-label={`Items of ${style.code}`}>
              <ItemField label="Item Code" value={picked} onChange={onOnly} style={style.code} all={items.length}>
                {items.map((i) => (
                  <option key={i.id} value={i.id} data-sub={[i.name, i.colour].filter(Boolean).join(' · ')}>
                    {i.code}
                  </option>
                ))}
              </ItemField>
              <ItemField label="Item Name" value={picked} onChange={onOnly} style={style.code} all={items.length}>
                {items.map((i) => (
                  <option key={i.id} value={i.id} data-sub={[i.code, i.colour].filter(Boolean).join(' · ')}>
                    {i.name}
                  </option>
                ))}
              </ItemField>
              <ItemField label="Item Description" value={picked} onChange={onOnly} style={style.code} all={items.length}>
                {items.map((i) => (
                  <option key={i.id} value={i.id} data-sub={`${i.code} · ${i.name}`}>
                    {i.description || `No description (${i.code})`}
                  </option>
                ))}
              </ItemField>
            </div>
          )}
        </div>
      )}

      {/* Colours down, sizes across: one box a colour and size, totals each way. */}
      <div className="border-border overflow-x-auto rounded-lg border">
        <table ref={gridRef} className="subtable w-full border-separate border-spacing-0 text-sm" data-grid>
          <thead>
            <tr className="bg-secondary text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
              <th className="bg-secondary sticky left-0 z-10 min-w-[15rem] px-3 py-2 text-left">Colour / Item</th>
              {style.sizes.map((s) => (
                <th key={s.id} className="min-w-[4.75rem] px-1 py-2 text-center">
                  {s.code}
                </th>
              ))}
              <th className="min-w-[5rem] px-3 py-2 text-right">Pieces</th>
              <th className="min-w-[7rem] px-3 py-2 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {/* One rate for every size, then any size changed on its own. */}
            <tr className="bg-primary/5" data-grid-row>
              <td className="bg-card border-border sticky left-0 z-10 border-b px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-xs font-semibold">Rate / pc ₹</span>
                  <StepInput
                    className="form-input h-8 w-24 px-2 text-right text-xs"
                    value={allRate}
                    decimals
                    onValueChange={(v) => {
                      setAllRate(v)
                      onRates(Object.fromEntries(style.sizes.map((s) => [s.id, v])))
                    }}
                    placeholder="All sizes"
                    aria-label={`Rate for every size of ${style.code}`}
                    title="One rate for every size; change any size after"
                  />
                </div>
              </td>
              {style.sizes.map((s) => (
                <td key={s.id} className="border-border border-b px-1 py-2">
                  <StepInput
                    className="form-input h-8 px-2 text-right text-xs tabular-nums"
                    value={rates[s.id] ?? ''}
                    decimals
                    onValueChange={(v) => onRates({ ...rates, [s.id]: v })}
                    aria-label={`Rate for size ${s.code}`}
                  />
                </td>
              ))}
              <td className="border-border text-muted-foreground border-b px-3 py-2 text-right text-[11px]" colSpan={2}>
                size-wise rates
              </td>
            </tr>
            {shown.map((r) => {
              const er = entryRows.indexOf(r)
              const tint = swatchOf(r.colour)
              return (
                <tr key={r.key} className="group" data-grid-row>
                  <td className="bg-card group-hover:bg-secondary border-border sticky left-0 z-10 border-b px-3 py-2">
                    <div className="flex items-start gap-2.5">
                      <span
                        className="border-border mt-0.5 h-4 w-4 shrink-0 rounded-full border"
                        style={tint ? { background: tint } : { background: 'repeating-linear-gradient(45deg, hsl(var(--muted)), hsl(var(--muted)) 2px, transparent 2px, transparent 4px)' }}
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <div className="text-foreground font-medium leading-tight">{r.colour || r.item?.code}</div>
                        {r.item ? (
                          <>
                            <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px]">
                              <span className="shrink-0 whitespace-nowrap font-mono text-teal-400">{r.item.code}</span>
                              {r.item.name && (
                                <span className="min-w-0 max-w-52 truncate" title={r.item.name}>
                                  · {r.item.name}
                                </span>
                              )}
                            </div>
                            {r.item.description && (
                              <div className="text-muted-foreground max-w-60 truncate text-[11px] italic" title={r.item.description}>
                                {r.item.description}
                              </div>
                            )}
                          </>
                        ) : choose?.colour === r.colour ? (
                          <div className="mt-1 flex items-center gap-1">
                            <SmartSelect
                              className="form-input h-8 text-xs"
                              value={choose.categoryId}
                              onChange={(e) => setChoose({ ...choose, categoryId: e.target.value })}
                              aria-label={`Category for ${style.code} ${r.colour}`}
                            >
                              <option value="">File under…</option>
                              {choose.categories.map((k) => (
                                <option key={k.id} value={k.id}>
                                  {k.name}
                                </option>
                              ))}
                            </SmartSelect>
                            <button type="button" className="btn-primary h-8 px-2 text-xs" disabled={!choose.categoryId || making === r.colour} onClick={() => void makeItem(r.colour, choose.categoryId)}>
                              Next
                            </button>
                          </div>
                        ) : (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="warn-text text-[11px]">No item yet</span>
                            {mayMakeItems ? (
                              <button
                                type="button"
                                className="border-primary/40 text-primary hover:bg-primary/10 inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-semibold"
                                disabled={making === r.colour}
                                onClick={() => void makeItem(r.colour)}
                                aria-label={`Create item for ${r.colour}`}
                              >
                                {making === r.colour ? <Loader2 size={11} className="animate-spin" /> : <PackagePlus size={11} />} Create item
                              </button>
                            ) : (
                              <span className="text-muted-foreground text-[11px]">add it in Items &amp; Products</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  {style.sizes.map((s, c) => {
                    const q = Number(qty[cellKey(r.key, s.id)] || 0)
                    const noRate = q > 0 && !Number(rates[s.id] || 0)
                    return (
                      <td key={s.id} className="group-hover:bg-secondary border-border border-b px-1 py-2">
                        <StepInput
                          className={cn('form-input h-9 px-2 text-right tabular-nums', !r.item && 'opacity-40', q > 0 && 'border-primary/50 font-semibold', noRate && 'border-amber-500')}
                          value={qty[cellKey(r.key, s.id)] ?? ''}
                          disabled={!r.item}
                          onValueChange={(v) => onQty({ ...qty, [cellKey(r.key, s.id)]: v })}
                          onKeyDown={er >= 0 ? onCellKey(er, c) : undefined}
                          onPaste={er >= 0 ? onCellPaste(er, c) : undefined}
                          data-cell={er >= 0 ? `${er}:${c}` : undefined}
                          aria-label={`Pieces of ${r.colour || r.item?.code} size ${s.code}`}
                          title={noRate ? `No rate for size ${s.code} yet` : undefined}
                        />
                      </td>
                    )
                  })}
                  <td className="group-hover:bg-secondary border-border text-foreground border-b px-3 py-2 text-right font-semibold tabular-nums">{pieces(r.key) ? num(pieces(r.key)) : '—'}</td>
                  <td className="group-hover:bg-secondary border-border text-foreground border-b px-3 py-2 text-right tabular-nums">{valueOf(r.key) ? money(valueOf(r.key)) : '—'}</td>
                </tr>
              )
            })}
            <tr className="bg-secondary font-semibold">
              <td className="bg-secondary text-foreground sticky left-0 z-10 px-3 py-2 text-xs uppercase tracking-wide">Total</td>
              {style.sizes.map((s) => (
                <td key={s.id} className="text-foreground px-1 py-2 text-center text-sm tabular-nums">
                  {sizeTotal(s.id) || '—'}
                </td>
              ))}
              <td className="text-foreground px-3 py-2 text-right tabular-nums">{total ? num(total) : '—'}</td>
              <td className="text-foreground px-3 py-2 text-right tabular-nums">{totalValue ? money(totalValue) : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground text-[11px]">
        Enter or ← → to move along · Alt+↑ ↓ up and down a size · paste a block copied from a sheet into any box to fill from there.
      </p>
      {note && <p className={cn('text-xs', note.ok ? 'text-emerald-500' : 'text-red-400')}>{note.text}</p>}
      {preview && (
        <AddItemDialog
          preview={preview}
          styleId={style.id}
          onClose={() => setPreview(null)}
          onMade={(item, message) => {
            onColourMade(preview.colourKey, item)
            setPreview(null)
            setChoose(null)
            setNote({ ok: true, text: message })
          }}
        />
      )}
    </div>
  )
}

/** A colour's swatch, when its name is one a browser knows: "Sky Blue" → skyblue. */
function swatchOf(colour: string): string | null {
  const c = colour.trim().toLowerCase().replace(/\s+/g, '')
  if (!c || typeof CSS === 'undefined') return null
  return CSS.supports('color', c) ? c : null
}

interface ItemPreview {
  colourKey: string
  name: string
  type: string
  style: string
  colour: string
  category: string | null
  subCategory: string | null
  unit: string | null
  hsnCode: string | null
  gst: string | null
  standardRate: number | null
  copiedFrom: string | null
  categoryId: string
}

/**
 * A colour's item, before it is made: every detail it gets and the item they
 * are copied from, its name to change, then Create — or the full item form
 * instead, for anything more.
 */
function AddItemDialog({
  preview,
  styleId,
  onClose,
  onMade,
}: {
  preview: ItemPreview
  styleId: string
  onClose: () => void
  onMade: (item: { id: string; code: string; name?: string }, message: string) => void
}) {
  const [name, setName] = useState(preview.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEscape(() => {
    if (!busy) onClose()
  })
  const create = async () => {
    if (!name.trim()) return setError('Give the item a name.')
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { item: { id: string; code: string; name?: string } } }>('/inventory/opening-stock/colour-item', {
        styleId,
        colour: preview.colourKey,
        categoryId: preview.categoryId,
        name: name.trim(),
      })
      onMade(res.data.item, res.message ?? `${name.trim()} added as ${res.data.item.code}.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the item.')
      setBusy(false)
    }
  }
  const rows: Array<[string, ReactNode]> = [
    ['Item Type', preview.type],
    ['Style / Colour', `${preview.style} · ${preview.colour}`],
    ['Category', preview.category ?? '—'],
    ['Sub Category', preview.subCategory ?? '—'],
    ['Unit of Measure', preview.unit ?? '—'],
    ['HSN Code', preview.hsnCode ?? <span className="warn-text">None — add it in Items &amp; Products before selling</span>],
    ['GST', preview.gst ?? 'From the HSN code'],
    ['Standard Rate', preview.standardRate != null ? money(preview.standardRate) : '—'],
    ['Item Code', 'Given the next number when created'],
  ]
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className="glass-card flex max-h-full w-full max-w-lg flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="add-item-title">
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <PackagePlus size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="add-item-title" className="text-foreground text-lg font-semibold">
              Add the item for {preview.colour}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {preview.style} has no item in {preview.colour} yet, so its pieces cannot be entered.{' '}
              {preview.copiedFrom ? `Its details are copied from ${preview.copiedFrom}, the same style's item.` : 'Its details are copied from an item in the same sub-category.'} Check them,
              then create it.
            </p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5">
          <label className="block space-y-1 text-sm">
            <span className="text-foreground font-medium">Item Name</span>
            <input className="form-input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} aria-label="Item Name" autoFocus />
          </label>
          <dl className="border-border divide-border divide-y rounded-lg border text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex gap-3 px-3 py-1.5">
                <dt className="text-muted-foreground w-36 shrink-0">{label}</dt>
                <dd className="text-foreground min-w-0">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-xs">
            Description, stock levels and sticker settings stay empty; fill them any time in Masters → Items & Products.
          </p>
          {error && (
            <p className="text-sm text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 p-5">
          <a className="text-primary mr-auto inline-flex items-center gap-1 text-sm font-medium hover:underline" href="/masters/items" target="_blank" rel="noreferrer">
            Use the full item form instead <ExternalLink size={12} />
          </a>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void create()} disabled={busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <PackagePlus size={15} />} Create item
          </button>
        </div>
      </div>
    </div>,
    document.body,
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
      <SmartSelect className={cn('form-input h-9 w-full text-sm', wide && 'min-w-72')} value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} of ${style}`}>
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
