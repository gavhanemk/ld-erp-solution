'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ExternalLink, Factory, Package, Plus, Shirt, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { StyleGrid, ReloadButton } from './StyleGrid'
import { cellKey, money, num, type FormOptions, type MaterialOption, type StyleOption } from './kinds'

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
  onColourMade: (styleId: string, colour: string, item: { id: string; code: string }) => void
}

const piecesOf = (g: Garment) => Object.values(g.qty).reduce((n, v) => n + Number(v || 0), 0)
const valueOf = (g: Garment, st: StyleOption | undefined) =>
  (st?.colours ?? []).reduce((n, c) => n + (st?.sizes ?? []).reduce((m, s) => m + Number(g.qty[cellKey(c.colour, s.id)] || 0) * Number(g.rates[s.id] || 0), 0), 0)

// ── Finished Goods: style → its colours → its sizes ─────────────────────

export function FinishedGoods({ garments, onChange, ...shared }: Shared & { garments: Garment[]; onChange: (g: Garment[]) => void }) {
  const { options } = shared
  const [pick, setPick] = useState('')
  const taken = new Set(garments.map((g) => g.styleId))
  const add = (styleId: string) => {
    if (!styleId || taken.has(styleId)) return
    onChange([...garments, { key: newKey(), styleId, processId: '', locationId: '', orderNo: '', bundle: '', rates: {}, qty: {} }])
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
  const [processId, setProcessId] = useState('')
  const [busy, setBusy] = useState(false)
  const style = options.styles.find((x) => x.id === styleId)
  // A process already entered for this style is not offered twice.
  const route = (style?.route ?? []).filter((p) => !garments.some((g) => g.styleId === styleId && g.processId === p.id))
  const add = () => {
    if (!style || !processId) return
    onChange([...garments, { key: newKey(), styleId: style.id, processId, locationId: '', orderNo: '', bundle: '', rates: {}, qty: {} }])
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
              // A new style: its route, so the process chosen for the last one goes.
              setStyleId(e.target.value)
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

const totalsText = (pieces: number, value: number) => (pieces ? `${num(pieces)} pcs · ${money(value)}` : '')
