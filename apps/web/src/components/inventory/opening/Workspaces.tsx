'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ExternalLink, Factory, Package, Plus, Search, Shirt, Trash2 } from 'lucide-react'
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

/** Every finished item linked to a style, to find its style by: "SHI-007 — Formal Shirt White". */
function ItemFinder({ options, onPick, label }: { options: FormOptions; onPick: (styleId: string, itemId: string) => void; label: string }) {
  return (
    <SmartSelect
      className="form-input h-9 w-80"
      value=""
      onChange={(e) => {
        const st = options.styles.find((x) => (x.items ?? []).some((i) => i.id === e.target.value))
        if (st) onPick(st.id, e.target.value)
      }}
      aria-label={label}
    >
      <option value="">…or find by Item Code / Item Name</option>
      {options.styles.flatMap((st) =>
        (st.items ?? []).map((i) => (
          <option key={i.id} value={i.id} data-sub={[st.code, i.colour, i.description].filter(Boolean).join(' · ')}>
            {`${i.code} — ${i.name}`}
          </option>
        )),
      )}
    </SmartSelect>
  )
}

// ── Finished Goods: style → its colours → its sizes ─────────────────────

export function FinishedGoods({ garments, onChange, ...shared }: Shared & { garments: Garment[]; onChange: (g: Garment[]) => void }) {
  const { options } = shared
  const [pick, setPick] = useState('')
  const taken = new Set(garments.map((g) => g.styleId))
  const add = (styleId: string, item = '') => {
    if (!styleId) return
    // Found by its item: the style's block, already there or added, shows that item.
    if (taken.has(styleId)) {
      if (item) onChange(garments.map((g) => (g.styleId === styleId ? { ...g, item } : g)))
      return
    }
    onChange([...garments, { key: newKey(), styleId, processId: '', locationId: '', orderNo: '', bundle: '', rates: {}, qty: {}, item }])
    setPick('')
  }
  return (
    <section className="space-y-3" aria-label="Finished goods by style">
      <div className="glass-card flex flex-wrap items-center gap-3 p-3">
        <Shirt size={16} className="text-primary" />
        <span className="text-foreground text-sm font-semibold">Add a style</span>
        <SmartSelect className="form-input h-9 min-w-80 flex-1" value={pick} onChange={(e) => add(e.target.value)} aria-label="Add a style">
          <option value="">Pick a style — its colours and sizes come with it…</option>
          {options.styles
            .filter((st) => !taken.has(st.id))
            .map((st) => (
              <option key={st.id} value={st.id} data-sub={`${st.name} · ${st.colours.length} ${st.colours.length === 1 ? 'colour' : 'colours'} · ${st.sizes.length} sizes`}>
                {st.code}
              </option>
            ))}
        </SmartSelect>
        <Search size={14} className="text-muted-foreground" />
        <ItemFinder options={options} onPick={(styleId, itemId) => add(styleId, itemId)} label="Find by item code or name" />
      </div>
      {garments.length === 0 && <Empty icon={Shirt} text="Pick a style to enter its finished pieces: a box for each of its colours and sizes." />}
      {garments.map((g) => {
        const st = options.styles.find((x) => x.id === g.styleId)
        if (!st) return null
        return (
          <Block
            key={g.key}
            label={`Style ${st.code}`}
            title={
              <>
                <span className="font-mono font-semibold text-teal-400">{st.code}</span> <span className="text-foreground">{st.name}</span>
              </>
            }
            totals={totalsText(piecesOf(g), valueOf(g, st))}
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
      <div className="glass-card space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Factory size={16} className="text-primary" />
          <span className="text-foreground text-sm font-semibold">Add a style at a process</span>
          <SmartSelect
            className="form-input h-9 w-72"
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
          <SmartSelect className="form-input h-9 w-64" value={itemId} onChange={(e) => setItemId(e.target.value)} disabled={!style || !(style.items ?? []).length} aria-label="Item (optional)">
            <option value="">{style ? `All its items (${(style.items ?? []).length})` : 'Item: pick a style first'}</option>
            {(style?.items ?? []).map((i) => (
              <option key={i.id} value={i.id} data-sub={[i.name, i.colour, i.description].filter(Boolean).join(' · ')}>
                {i.code}
              </option>
            ))}
          </SmartSelect>
          <SmartSelect className="form-input h-9 w-64" value={processId} onChange={(e) => setProcessId(e.target.value)} disabled={!style || !style.route} aria-label="Process">
            <option value="">{style ? '2. Where are the pieces?' : '2. Pick a style first'}</option>
            {route.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SmartSelect>
          <button type="button" className="btn-primary h-9 text-sm" disabled={!style || !processId} onClick={add}>
            <Plus size={14} /> Add
          </button>
        </div>
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
      </div>
      {garments.length === 0 && <Empty icon={Factory} text="Pick a style and the process its pieces are at: a box for each of its colours and sizes." />}
      {garments.map((g) => {
        const st = options.styles.find((x) => x.id === g.styleId)
        const p = options.processes.find((x) => x.id === g.processId) ?? st?.route?.find((x) => x.id === g.processId)
        if (!st || !p) return null
        const set = (change: Partial<Garment>) => onChange(garments.map((x) => (x.key === g.key ? { ...x, ...change } : x)))
        return (
          <Block
            key={g.key}
            label={`Style ${st.code} at ${p.name}`}
            title={
              <>
                <span className="font-mono font-semibold text-teal-400">{st.code}</span> <span className="text-foreground">{st.name}</span>
                <span className="badge-info ml-2">at {p.name}</span>
              </>
            }
            totals={totalsText(piecesOf(g), valueOf(g, st))}
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
      <div className="glass-card flex flex-wrap items-center gap-3 p-3">
        <Package size={16} className="text-primary" />
        <span className="text-foreground text-sm font-semibold">Add a material</span>
        <SmartSelect
          className="form-input h-9 w-64"
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
        <SmartSelect className="form-input h-9 min-w-72 flex-1" value={itemId} onChange={(e) => setItemId(e.target.value)} disabled={!categoryId} aria-label="Item">
          <option value="">{categoryId ? (inCategory.length ? '2. The item…' : 'Every item here is already added') : '2. Pick a category first'}</option>
          {inCategory.map((i) => (
            <option key={i.id} value={i.id} data-sub={`${i.code}${i.unit ? ` · in ${i.unit}` : ''}`}>
              {i.name}
            </option>
          ))}
        </SmartSelect>
        <button type="button" className="btn-primary h-9 text-sm" disabled={!itemId} onClick={add}>
          <Plus size={14} /> Add
        </button>
      </div>
      {materials.length === 0 && <Empty icon={Package} text="Pick a category, then its item: a row for each lot or roll, in the item's own unit." />}
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
              <>
                <span className="font-mono font-semibold text-teal-400">{it.code}</span> <span className="text-foreground">{it.name}</span>
                <span className="text-muted-foreground ml-2 text-xs">
                  {categoryName(it.categoryId)} · in {it.unit ?? '—'}
                </span>
              </>
            }
            totals={qty ? `${num(qty)} ${it.unit ?? ''} · ${money(value)}` : ''}
            problems={lotProblems.length ? lotProblems : undefined}
            onRemove={() => onChange(materials.filter((x) => x.key !== m.key))}
          >
            <LotRows item={it} lots={m.lots} problems={shared.problems} onChange={setLots} />
          </Block>
        )
      })}
    </section>
  )
}

function LotRows({ item, lots, problems, onChange }: { item: MaterialOption; lots: Lot[]; problems: Map<string, string[]>; onChange: (lots: Lot[]) => void }) {
  const set = (key: string, change: Partial<Lot>) => onChange(lots.map((l) => (l.key === key ? { ...l, ...change } : l)))
  return (
    <div className="space-y-2">
      <table className="subtable w-full text-sm">
        <thead>
          <tr className="text-muted-foreground text-left text-[11px] font-semibold uppercase tracking-wide">
            <th className="py-1.5 pr-2">Lot / Batch / Roll No.</th>
            <th className="px-2 py-1.5">Bundle / Barcode No.</th>
            <th className="w-40 px-2 py-1.5 text-right">Opening Qty</th>
            <th className="w-32 px-2 py-1.5 text-right">Unit Rate ₹</th>
            <th className="w-32 px-2 py-1.5 text-right">Opening Value</th>
            {item.tracked && <th className="w-44 px-2 py-1.5">Packed as</th>}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {lots.map((l, i) => (
            <tr key={l.key} className={cn('border-border border-t', problems.get(l.key) && 'bg-red-500/5')}>
              <td className="py-1.5 pr-2">
                <input className="form-input" value={l.lot} onChange={(e) => set(l.key, { lot: e.target.value })} placeholder="Optional" aria-label={`Lot of ${item.code}, row ${i + 1}`} />
              </td>
              <td className="px-2 py-1.5">
                <input className="form-input" value={l.bundle} onChange={(e) => set(l.key, { bundle: e.target.value })} placeholder="Optional" aria-label={`Bundle of ${item.code}, row ${i + 1}`} />
              </td>
              <td className="px-2 py-1.5">
                <div className="flex items-center gap-1">
                  <StepInput className="form-input text-right" value={l.qty} decimals={item.decimals > 0} onValueChange={(v) => set(l.key, { qty: v })} aria-label={`Quantity of ${item.code}, row ${i + 1}`} />
                  <span className="text-muted-foreground w-9 text-xs">{item.unit ?? ''}</span>
                </div>
              </td>
              <td className="px-2 py-1.5">
                <StepInput
                  className={cn('form-input text-right', Number(l.qty || 0) > 0 && !Number(l.rate || 0) && 'border-amber-500')}
                  value={l.rate}
                  decimals
                  onValueChange={(v) => set(l.key, { rate: v })}
                  aria-label={`Rate of ${item.code}, row ${i + 1}`}
                />
              </td>
              <td className="text-foreground px-2 py-1.5 text-right font-semibold tabular-nums">{money(Number(l.qty || 0) * Number(l.rate || 0))}</td>
              {item.tracked && (
                <td className="px-2 py-1.5">
                  <PackedAs item={item} lot={l} row={i + 1} onChange={(pack) => set(l.key, { pack })} />
                </td>
              )}
              <td className="py-1.5">
                <button type="button" className="btn-ghost p-1" disabled={lots.length === 1} onClick={() => onChange(lots.filter((x) => x.key !== l.key))} aria-label={`Remove row ${i + 1} of ${item.code}`}>
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="text-primary flex items-center gap-1 text-xs font-medium hover:underline" onClick={() => onChange([...lots, newLot()])}>
        <Plus size={12} /> Add another lot or roll of {item.code}
      </button>
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
  totals: string
  problems: string[] | undefined
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <div className={cn('glass-card space-y-3 p-4', problems && 'ring-1 ring-red-500/50')} aria-label={label}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 text-sm">{title}</div>
        {totals && <span className="text-foreground text-sm font-semibold tabular-nums">{totals}</span>}
        <button type="button" className="btn-ghost p-1" onClick={onRemove} aria-label={`Remove ${label}`}>
          <Trash2 size={14} />
        </button>
      </div>
      {children}
      {problems && (
        <ul className="space-y-0.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400" aria-label="Problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Empty({ icon: Icon, text }: { icon: typeof Package; text: string }) {
  return (
    <div className="border-border text-muted-foreground flex items-center gap-3 rounded-xl border border-dashed p-6 text-sm">
      <Icon size={20} />
      {text}
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

const totalsText = (pieces: number, value: number) => (pieces ? `${num(pieces)} pcs · ${money(value)}` : '')
