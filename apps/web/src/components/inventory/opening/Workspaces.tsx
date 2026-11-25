'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ExternalLink, Factory, Package, Plus, Search, Shirt, Tag, Trash2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { StyleGrid, ReloadButton } from './StyleGrid'
import { cellKey, money, num, styleRows, type FormOptions, type MaterialOption, type StyleOption } from './kinds'
import { newPack, packText, PackagingDialog, planOf, type PackValue } from '@/components/packages/PackagingEditor'

/*
 * The three entry screens. Each shows only its own kind's fields, and every
 * choice leads only to what belongs to it: a style to its colours, sizes and
 * route; a material category to its items and their unit.
 */

/** A style being entered: at a process for semi-finished goods, a rate per size, pieces per colour and size. */
export interface Garment {
  key: string
  styleId: string
  /** Semi-finished goods: the process on the style's route the pieces are at. */
  processId: string
  /** Semi-finished goods: empty for the process's own floor, or a store or outside unit. */
  locationId: string
  orderNo: string
  bundle: string
  rates: Record<string, string>
  qty: Record<string, string>
  /** The item picked by its code, name or description; empty for all the style's items. */
  item?: string
}
/** A material: one item, with a row for each lot or roll. */
export interface Material {
  key: string
  itemId: string
  lots: Lot[]
}
export interface Lot {
  key: string
  lot: string
  bundle: string
  qty: string
  rate: string
  /** How it goes on stickers; none said, the item's usual. */
  pack?: PackValue | null
}

let seq = 0
export const newKey = () => `k${Date.now().toString(36)}${++seq}`
export const newLot = (): Lot => ({ key: newKey(), lot: '', bundle: '', qty: '', rate: '' })

interface Shared {
  options: FormOptions
  problems: Map<string, string[]>
  mayMakeItems: boolean
  maySetSizeRun: boolean
  onReload: () => Promise<void>
  onColourMade: (styleId: string, colour: string, item: { id: string; code: string; name?: string }) => void
}

const piecesOf = (g: Garment) => Object.values(g.qty).reduce((n, v) => n + Number(v || 0), 0)
const valueOf = (g: Garment, st: StyleOption | undefined) =>
  (st ? styleRows(st) : []).reduce((n, r) => n + (st?.sizes ?? []).reduce((m, s) => m + Number(g.qty[cellKey(r.key, s.id)] || 0) * Number(g.rates[s.id] || 0), 0), 0)

/**
 * One search for what to enter: a style (its colours and sizes come with it),
 * or one of its items by code or name (its style comes, showing that item).
 */
function StyleSearch({ options, taken, onPick }: { options: FormOptions; taken: Set<string>; onPick: (styleId: string, itemId: string) => void }) {
  return (
    <SmartSelect
      className="form-input h-10 min-w-0 flex-1"
      value=""
      onChange={(e) => {
        const [kind, id] = e.target.value.split(':')
        if (kind === 'style') onPick(id, '')
        if (kind === 'item') {
          const st = options.styles.find((x) => (x.items ?? []).some((i) => i.id === id))
          if (st) onPick(st.id, id)
        }
      }}
      aria-label="Add a style"
    >
      <option value="">Search a style, item code or item name…</option>
      {options.styles
        .filter((st) => !taken.has(st.id))
        .map((st) => (
          <option key={st.id} value={`style:${st.id}`} data-sub={`Style · ${st.colours.length} ${st.colours.length === 1 ? 'colour' : 'colours'} · ${st.sizes.length} sizes`}>
            {`${st.code} — ${st.name}`}
          </option>
        ))}
      {options.styles.flatMap((st) =>
        (st.items ?? []).map((i) => (
          <option key={i.id} value={`item:${i.id}`} data-sub={['Item of ' + st.code, i.colour, i.description].filter(Boolean).join(' · ')}>
            {`${i.code} — ${i.name}`}
          </option>
        )),
      )}
    </SmartSelect>
  )
}

/** A style's card heading: its name first, its code, and what it is made in. */
function StyleTitle({ st, extra }: { st: StyleOption; extra?: ReactNode }) {
  const items = (st.items ?? []).length
  const run = st.sizes.length ? `${st.sizes[0].code}–${st.sizes[st.sizes.length - 1].code}` : ''
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-foreground text-base font-semibold leading-tight">{st.name}</span>
        <span className="bg-primary/10 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold text-teal-400">{st.code}</span>
        {extra}
      </div>
      <div className="text-muted-foreground mt-0.5 text-xs">
        {st.colours.length} {st.colours.length === 1 ? 'colour' : 'colours'} · {st.sizes.length} {st.sizes.length === 1 ? 'size' : 'sizes'}
        {run ? ` (${run})` : ''} · {items} {items === 1 ? 'item' : 'items'}
      </div>
    </div>
  )
}

// ── Finished Goods: style → its colours → its sizes ─────────────────────

export function FinishedGoods({ garments, onChange, ...shared }: Shared & { garments: Garment[]; onChange: (g: Garment[]) => void }) {
  const { options } = shared
  const taken = new Set(garments.map((g) => g.styleId))
  const add = (styleId: string, item = '') => {
    if (!styleId) return
    // Found by its item: the style's block, already there or added, shows that item.
    if (taken.has(styleId)) {
      if (item) onChange(garments.map((g) => (g.styleId === styleId ? { ...g, item } : g)))
      return
    }
    onChange([...garments, { key: newKey(), styleId, processId: '', locationId: '', orderNo: '', bundle: '', rates: {}, qty: {}, item }])
  }
  return (
    <section className="space-y-3" aria-label="Finished goods by style">
      <Toolbar icon={Search} title="Add a style" hint="By style, item code or item name">
        <StyleSearch options={options} taken={taken} onPick={add} />
        {garments.length > 0 && (
          <span className="badge-neutral">
            {garments.length} {garments.length === 1 ? 'style' : 'styles'} added
          </span>
        )}
      </Toolbar>
      {garments.length === 0 && <Empty icon={Shirt} title="No styles yet" text="Pick a style above to enter its finished pieces: a box for each of its colours and sizes." />}
      {garments.map((g) => {
        const st = options.styles.find((x) => x.id === g.styleId)
        if (!st) return null
        return (
          <Block
            key={g.key}
            label={`Style ${st.code}`}
            title={<StyleTitle st={st} />}
            totals={<BlockTotals pieces={piecesOf(g)} value={valueOf(g, st)} />}
            problems={shared.problems.get(g.key)}
            onRemove={() => onChange(garments.filter((x) => x.key !== g.key))}
          >
            <StyleGrid
              style={st}
              rates={g.rates}
              qty={g.qty}
              onRates={(rates) => onChange(garments.map((x) => (x.key === g.key ? { ...x, rates } : x)))}
              onQty={(qty) => onChange(garments.map((x) => (x.key === g.key ? { ...x, qty } : x)))}
              only={g.item ?? ''}
              onOnly={(item) => onChange(garments.map((x) => (x.key === g.key ? { ...x, item } : x)))}
              sizeRuns={options.sizeRuns}
              mayMakeItems={shared.mayMakeItems}
              maySetSizeRun={shared.maySetSizeRun}
              onColourMade={(colour, item) => shared.onColourMade(st.id, colour, item)}
              onReload={shared.onReload}
            />
          </Block>
        )
      })}
    </section>
  )
}

// ── Semi Finished Goods: style → a process on its route → colours × sizes ──

export function SemiFinished({ garments, onChange, ...shared }: Shared & { garments: Garment[]; onChange: (g: Garment[]) => void }) {
  const { options } = shared
  const [styleId, setStyleId] = useState('')
  const [itemId, setItemId] = useState('')
  const [processId, setProcessId] = useState('')
  const [busy, setBusy] = useState(false)
  const style = options.styles.find((x) => x.id === styleId)
  // A process already entered for this style is not offered twice.
  const route = (style?.route ?? []).filter((p) => !garments.some((g) => g.styleId === styleId && g.processId === p.id))
  const add = () => {
    if (!style || !processId) return
    onChange([...garments, { key: newKey(), styleId: style.id, processId, locationId: '', orderNo: '', bundle: '', rates: {}, qty: {}, item: itemId }])
    setProcessId('')
  }
  const reload = async () => {
    setBusy(true)
    try {
      await shared.onReload()
    } finally {
      setBusy(false)
    }
  }
  const floorOf = (pid: string) => {
    const p = options.processes.find((x) => x.id === pid)
    return p?.floor ?? `${p?.name ?? 'Process'} Floor`
  }
  return (
    <section className="space-y-3" aria-label="Semi-finished goods by style and process">
      <Toolbar
        icon={Factory}
        title="Add a style at a process"
        hint="Style, then where its pieces are"
        footer={
          <>
            {style && !style.route && (
              <p className="flex flex-wrap items-center gap-x-2 text-sm text-amber-600">
                {style.code} has no route yet, so where its pieces can be is not known. Set one up, then reload.
                <a className="text-primary inline-flex items-center gap-1 font-medium hover:underline" href="/masters/routings" target="_blank" rel="noreferrer">
                  Open Routings <ExternalLink size={12} />
                </a>
                <ReloadButton busy={busy} onClick={() => void reload()} />
              </p>
            )}
            {style?.route && (
              <p className="text-muted-foreground text-xs">
                {style.code}&apos;s route{style.routeFrom?.applies === 'CATEGORY' ? ' (its category’s)' : style.routeFrom?.applies === 'ANY' ? ' (the one for any style)' : ''}:{' '}
                {style.route.map((p) => p.name).join(' → ')}. Only these processes can hold its pieces.
              </p>
            )}
          </>
        }
      >
          <SmartSelect
            className="form-input h-10 w-64"
            value={styleId}
            onChange={(e) => {
              // A new style: its route and its items, so the process and item chosen for the last one go.
              setStyleId(e.target.value)
              setItemId('')
              setProcessId('')
            }}
            aria-label="Style"
          >
            <option value="">1. Pick the style…</option>
            {options.styles.map((st) => (
              <option key={st.id} value={st.id} data-sub={st.route ? `${st.name} · ${st.route.map((p) => p.name).join(' → ')}` : `${st.name} · no route yet`}>
                {st.code}
              </option>
            ))}
          </SmartSelect>
          <SmartSelect className="form-input h-10 w-60" value={itemId} onChange={(e) => setItemId(e.target.value)} disabled={!style || !(style.items ?? []).length} aria-label="Item (optional)">
            <option value="">{style ? `All its items (${(style.items ?? []).length})` : 'Item: pick a style first'}</option>
            {(style?.items ?? []).map((i) => (
              <option key={i.id} value={i.id} data-sub={[i.name, i.colour, i.description].filter(Boolean).join(' · ')}>
                {i.code}
              </option>
            ))}
          </SmartSelect>
          <SmartSelect className="form-input h-10 w-60" value={processId} onChange={(e) => setProcessId(e.target.value)} disabled={!style || !style.route} aria-label="Process">
            <option value="">{style ? '2. Where are the pieces?' : '2. Pick a style first'}</option>
            {route.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SmartSelect>
          <button type="button" className="btn-primary h-10 text-sm" disabled={!style || !processId} onClick={add}>
            <Plus size={14} /> Add
          </button>
      </Toolbar>
      {garments.length === 0 && <Empty icon={Factory} title="No styles yet" text="Pick a style and the process its pieces are at: a box for each of its colours and sizes." />}
      {garments.map((g) => {
        const st = options.styles.find((x) => x.id === g.styleId)
        const p = options.processes.find((x) => x.id === g.processId) ?? st?.route?.find((x) => x.id === g.processId)
        if (!st || !p) return null
        const set = (change: Partial<Garment>) => onChange(garments.map((x) => (x.key === g.key ? { ...x, ...change } : x)))
        return (
          <Block
            key={g.key}
            label={`Style ${st.code} at ${p.name}`}
            title={<StyleTitle st={st} extra={<span className="badge-info">at {p.name}</span>} />}
            totals={<BlockTotals pieces={piecesOf(g)} value={valueOf(g, st)} />}
            problems={shared.problems.get(g.key)}
            onRemove={() => onChange(garments.filter((x) => x.key !== g.key))}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="text-foreground font-medium">Location</span>
                <SmartSelect className="form-input" value={g.locationId} onChange={(e) => set({ locationId: e.target.value })} aria-label={`Location for ${st.code} at ${p.name}`}>
                  <option value="">{floorOf(g.processId)} (the process&apos;s own)</option>
                  {options.stores.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </SmartSelect>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-foreground font-medium">Order Reference</span>
                <input className="form-input" value={g.orderNo} onChange={(e) => set({ orderNo: e.target.value })} placeholder="Optional: SO, MO or old order no." aria-label={`Order for ${st.code} at ${p.name}`} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-foreground font-medium">Batch / Bundle Reference</span>
                <input className="form-input" value={g.bundle} onChange={(e) => set({ bundle: e.target.value })} placeholder="Optional" aria-label={`Bundle for ${st.code} at ${p.name}`} />
              </label>
            </div>
            <StyleGrid
              style={st}
              rates={g.rates}
              qty={g.qty}
              onRates={(rates) => set({ rates })}
              onQty={(qty) => set({ qty })}
              only={g.item ?? ''}
              onOnly={(item) => set({ item })}
              sizeRuns={options.sizeRuns}
              mayMakeItems={shared.mayMakeItems}
              maySetSizeRun={shared.maySetSizeRun}
              onColourMade={(colour, item) => shared.onColourMade(st.id, colour, item)}
              onReload={shared.onReload}
            />
          </Block>
        )
      })}
    </section>
  )
}

// ── Raw Materials: category → its items → lots and rolls ────────────────

export function RawMaterials({ materials, onChange, ...shared }: Shared & { materials: Material[]; onChange: (m: Material[]) => void }) {
  const { options } = shared
  const [categoryId, setCategoryId] = useState('')
  const [itemId, setItemId] = useState('')
  const taken = new Set(materials.map((m) => m.itemId))
  const inCategory = useMemo(() => options.items.filter((i) => i.categoryId === categoryId && !taken.has(i.id)), [options.items, categoryId, taken])
  const add = () => {
    if (!itemId) return
    onChange([...materials, { key: newKey(), itemId, lots: [newLot()] }])
    setItemId('')
  }
  const categoryName = (id: string) => options.categories.find((c) => c.id === id)?.name ?? ''
  return (
    <section className="space-y-3" aria-label="Raw materials by item">
      <Toolbar icon={Package} title="Add a material" hint="Category, then its item">
        <SmartSelect
          className="form-input h-10 w-64"
          value={categoryId}
          onChange={(e) => {
            // Another category: its own items, so the item picked goes.
            setCategoryId(e.target.value)
            setItemId('')
          }}
          aria-label="Material category"
        >
          <option value="">1. Material category…</option>
          {options.categories.map((c) => (
            <option key={c.id} value={c.id} data-sub={`${c.items} ${c.items === 1 ? 'item' : 'items'}`}>
              {c.name}
            </option>
          ))}
        </SmartSelect>
        <SmartSelect className="form-input h-10 min-w-72 flex-1" value={itemId} onChange={(e) => setItemId(e.target.value)} disabled={!categoryId} aria-label="Item">
          <option value="">{categoryId ? (inCategory.length ? '2. The item…' : 'Every item here is already added') : '2. Pick a category first'}</option>
          {inCategory.map((i) => (
            <option key={i.id} value={i.id} data-sub={`${i.code}${i.unit ? ` · in ${i.unit}` : ''}`}>
              {i.name}
            </option>
          ))}
        </SmartSelect>
        <button type="button" className="btn-primary h-10 text-sm" disabled={!itemId} onClick={add}>
          <Plus size={14} /> Add
        </button>
      </Toolbar>
      {materials.length === 0 && <Empty icon={Package} title="No materials yet" text="Pick a category, then its item: a row for each lot or roll, in the item's own unit." />}
      {materials.map((m) => {
        const it = options.items.find((x) => x.id === m.itemId)
        if (!it) return null
        const qty = m.lots.reduce((n, l) => n + Number(l.qty || 0), 0)
        const value = m.lots.reduce((n, l) => n + Number(l.qty || 0) * Number(l.rate || 0), 0)
        const setLots = (lots: Lot[]) => onChange(materials.map((x) => (x.key === m.key ? { ...x, lots } : x)))
        const lotProblems = m.lots.flatMap((l) => shared.problems.get(l.key) ?? [])
        return (
          <Block
            key={m.key}
            label={`Item ${it.code}`}
            title={
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-foreground text-base font-semibold leading-tight">{it.name}</span>
                  <span className="bg-primary/10 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold text-teal-400">{it.code}</span>
                  {it.tracked && (
                    <span className="badge-neutral">
                      <Tag size={11} /> Labelled by package
                    </span>
                  )}
                </div>
                <div className="text-muted-foreground mt-0.5 text-xs">
                  {categoryName(it.categoryId)} · counted in {it.unit ?? '—'} · {m.lots.length} {m.lots.length === 1 ? 'lot' : 'lots'}
                </div>
              </div>
            }
            totals={<BlockTotals pieces={qty} value={value} unit={it.unit ?? ''} />}
            problems={lotProblems.length ? lotProblems : undefined}
            onRemove={() => onChange(materials.filter((x) => x.key !== m.key))}
          >
            <LotRows item={it} lots={m.lots} problems={shared.problems} onChange={setLots} qty={qty} value={value} />
          </Block>
        )
      })}
    </section>
  )
}

function LotRows({
  item,
  lots,
  problems,
  onChange,
  qty,
  value,
}: {
  item: MaterialOption
  lots: Lot[]
  problems: Map<string, string[]>
  onChange: (lots: Lot[]) => void
  qty: number
  value: number
}) {
  const set = (key: string, change: Partial<Lot>) => onChange(lots.map((l) => (l.key === key ? { ...l, ...change } : l)))
  const unit = item.unit ?? ''
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary text-muted-foreground text-left text-[11px] font-semibold uppercase tracking-wide">
            <th className="w-10 px-3 py-2">#</th>
            <th className="min-w-[10rem] px-2 py-2">Lot / Batch / Roll No.</th>
            <th className="min-w-[10rem] px-2 py-2">Bundle / Barcode No.</th>
            <th className="w-44 px-2 py-2 text-right">Opening Qty</th>
            <th className="w-36 px-2 py-2 text-right">Unit Rate</th>
            <th className="w-32 px-3 py-2 text-right">Value</th>
            {item.tracked && <th className="w-52 px-2 py-2">Packed as</th>}
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {lots.map((l, i) => (
            <tr key={l.key} className={cn('border-border border-t', problems.get(l.key) && 'bg-red-500/5')}>
              <td className="text-muted-foreground px-3 py-1.5 text-xs tabular-nums">{i + 1}</td>
              <td className="px-2 py-1.5">
                <input className="form-input h-9" value={l.lot} onChange={(e) => set(l.key, { lot: e.target.value })} placeholder="Optional" aria-label={`Lot of ${item.code}, row ${i + 1}`} />
              </td>
              <td className="px-2 py-1.5">
                <input className="form-input h-9" value={l.bundle} onChange={(e) => set(l.key, { bundle: e.target.value })} placeholder="Optional" aria-label={`Bundle of ${item.code}, row ${i + 1}`} />
              </td>
              <td className="px-2 py-1.5">
                <div className="relative">
                  <StepInput
                    className="form-input h-9 pr-12 text-right"
                    value={l.qty}
                    decimals={item.decimals > 0}
                    onValueChange={(v) => set(l.key, { qty: v })}
                    aria-label={`Quantity of ${item.code}, row ${i + 1}`}
                  />
                  <span className="text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs">{unit}</span>
                </div>
              </td>
              <td className="px-2 py-1.5">
                <div className="relative">
                  <span className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs">₹</span>
                  <StepInput
                    className="form-input h-9 pl-7 text-right"
                    value={l.rate}
                    decimals
                    onValueChange={(v) => set(l.key, { rate: v })}
                    placeholder="Optional"
                    aria-label={`Rate of ${item.code}, row ${i + 1}`}
                  />
                </div>
              </td>
              <td className="text-foreground px-3 py-1.5 text-right font-semibold tabular-nums">{money(Number(l.qty || 0) * Number(l.rate || 0))}</td>
              {item.tracked && (
                <td className="px-2 py-1.5">
                  <PackedAs item={item} lot={l} row={i + 1} onChange={(pack) => set(l.key, { pack })} />
                </td>
              )}
              <td className="py-1.5 pr-2">
                <button
                  type="button"
                  className="btn-ghost text-muted-foreground hover:text-destructive p-1.5"
                  disabled={lots.length === 1}
                  onClick={() => onChange(lots.filter((x) => x.key !== l.key))}
                  aria-label={`Remove row ${i + 1} of ${item.code}`}
                >
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-border bg-secondary/40 border-t">
            <td colSpan={3} className="px-3 py-2">
              <button type="button" className="text-primary flex items-center gap-1 text-xs font-semibold hover:underline" onClick={() => onChange([...lots, newLot()])}>
                <Plus size={13} /> Add another lot or roll of {item.code}
              </button>
            </td>
            <td className="text-foreground px-2 py-2 text-right text-sm font-semibold tabular-nums">
              {qty ? (
                <>
                  {num(qty)} <span className="text-muted-foreground text-xs font-normal">{unit}</span>
                </>
              ) : (
                '—'
              )}
            </td>
            <td />
            <td className="text-foreground px-3 py-2 text-right text-sm font-semibold tabular-nums">{value ? money(value) : '—'}</td>
            {item.tracked && <td />}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** A lot's "Packed as": what its stickers will be, and the window to change it. */
function PackedAs({ item, lot, row, onChange }: { item: MaterialOption; lot: Lot; row: number; onChange: (pack: PackValue | null) => void }) {
  const [open, setOpen] = useState(false)
  const qty = Number(lot.qty || 0)
  const unit = item.unit ?? ''
  const value = lot.pack ?? usualPack(item, lot)
  const plan = planOf(value, qty, unit, item.decimals)
  return (
    <>
      <button
        type="button"
        className={cn('form-input flex h-9 w-full items-center justify-between gap-1 text-left text-sm', plan.problem && qty > 0 && 'border-amber-500')}
        onClick={() => setOpen(true)}
        disabled={!(qty > 0)}
        title={qty > 0 ? 'How it is packed: change it' : 'Enter the quantity first'}
        aria-label={`Packed as, ${item.code} row ${row}`}
      >
        <span className="truncate">{qty > 0 ? packText(plan, value.type, unit) : '—'}</span>
        <span className="text-muted-foreground shrink-0 text-[10px]">{lot.pack ? 'Change' : lot.bundle.trim() ? 'Own barcode' : item.perPack ? 'Suggested' : 'Set'}</span>
      </button>
      {open && (
        <PackagingDialog
          title="How is it packed?"
          subtitle={`${item.code} ${item.name}${lot.lot.trim() ? ` · lot ${lot.lot.trim()}` : ''} · ${num(qty)} ${unit}${lot.bundle.trim() ? ` · its own barcode ${lot.bundle.trim()} stays as one package's identity` : ''}`}
          initial={value}
          total={qty}
          unit={unit}
          places={item.decimals}
          noteLabel="Roll no. / reference (optional)"
          countForLater
          laterText="Saved as stock with packaging pending. Configure the packages later — from Stickers → Packaging pending, or the line in Opening Stock."
          saveLabel={() => 'Use this'}
          onSave={(_, v) => {
            onChange(v)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

// ── Pieces shared by the three ──────────────────────────────────────────

function Block({
  label,
  title,
  totals,
  problems,
  onRemove,
  children,
}: {
  label: string
  title: ReactNode
  totals: ReactNode
  problems: string[] | undefined
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <div className={cn('glass-card overflow-hidden p-0', problems && 'ring-1 ring-red-500/50')} aria-label={label}>
      <div className="border-border flex flex-wrap items-center gap-4 border-b px-5 py-3.5">
        <div className="min-w-0 flex-1 text-sm">{title}</div>
        {totals}
        <button type="button" className="btn-ghost text-muted-foreground hover:text-destructive p-1.5" onClick={onRemove} aria-label={`Remove ${label}`} title="Remove from this entry">
          <Trash2 size={15} />
        </button>
      </div>
      <div className="space-y-3 p-5">
        {children}
        {problems && (
          <ul className="space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-400" aria-label="Problems">
            {problems.map((p) => (
              <li key={p} className="border-l-2 border-red-500/60 pl-2.5">
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** The bar a kind's lines are added from: what it adds and how, then its choices. */
function Toolbar({ icon: Icon, title, hint, footer, children }: { icon: LucideIcon; title: string; hint: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="glass-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[12rem] items-center gap-3 pr-1">
          <span className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
            <Icon size={18} />
          </span>
          <div className="leading-tight">
            <div className="text-foreground text-sm font-semibold">{title}</div>
            <div className="text-muted-foreground text-xs">{hint}</div>
          </div>
        </div>
        {children}
      </div>
      {footer && <div className="mt-2.5 sm:pl-12">{footer}</div>}
    </div>
  )
}

/** A card's own totals, at its top right: pieces, and what they are worth. */
function BlockTotals({ pieces, value, unit = 'pcs' }: { pieces: number; value: number; unit?: string }) {
  if (!pieces) return <span className="text-muted-foreground text-xs">Nothing entered</span>
  return (
    <div className="flex items-baseline gap-3 text-right tabular-nums">
      <span>
        <span className="text-foreground text-base font-semibold">{num(pieces)}</span> <span className="text-muted-foreground text-xs">{unit}</span>
      </span>
      <span className="text-foreground text-sm font-semibold">{money(value)}</span>
    </div>
  )
}

function Empty({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="border-border bg-card/40 flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
      <span className="bg-primary/10 text-primary flex h-11 w-11 items-center justify-center rounded-full">
        <Icon size={20} />
      </span>
      <p className="text-foreground text-sm font-semibold">{title}</p>
      <p className="text-muted-foreground max-w-md text-sm">{text}</p>
    </div>
  )
}

/**
 * A lot's stickers when nothing is said, as the save makes them: one package
 * keeping a lot's own barcode, else the item's usual size suggested (to
 * check and change), else packaging pending — never sizes made up.
 */
export function usualPack(item: MaterialOption, lot: Pick<Lot, 'bundle'>): PackValue {
  const type = item.packType ?? 'OTHER'
  if (lot.bundle.trim()) return newPack(type, 'ONE')
  if (item.perPack) return { ...newPack(type, 'EACH'), each: String(item.perPack) }
  return newPack(type, 'LATER')
}

