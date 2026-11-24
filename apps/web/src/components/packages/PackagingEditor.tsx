'use client'

import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardPaste, Loader2, Package, Printer, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { PACK_TYPES, parseSizes, qtyText, splitEvenly } from './packageTypes'
import { PackageRows, emptyRow, notesOf, rowsOf, sizesOf, type SizeRow } from './PackageRows'

/*
 * How a quantity goes on stickers — the one choice every screen that packs
 * stock offers: all in one package, split equally, full packages of a fixed
 * size, each package its own size, or no stickers yet. The stock is the same
 * whichever is picked; only how it is labelled changes. A line underneath
 * says, as it is typed, what goes on stickers and what is left without.
 */

export type PackMethod = 'ONE' | 'EQUAL' | 'EACH' | 'LIST' | 'LATER'

export interface PackValue {
  method: PackMethod
  type: string
  /** Split equally: into how many. Packaging pending: how many there will be, when known. */
  count: string
  /** Fixed size each: what one full package holds. */
  each: string
  /** Different sizes: a row a package, with its roll number or a note. */
  rows: SizeRow[]
}

export const PACK_METHODS: Array<{ value: PackMethod; label: string; hint: string }> = [
  { value: 'ONE', label: 'One package', hint: 'All of it under one sticker.' },
  { value: 'EQUAL', label: 'Split equally', hint: 'A number of packages of the same size; the last takes what does not divide.' },
  { value: 'EACH', label: 'Fixed size each', hint: 'Full packages of one size, and one more for the rest.' },
  { value: 'LIST', label: 'Different sizes', hint: 'Each package its own size: type them one by one, or paste a packing list.' },
  { value: 'LATER', label: 'Packaging pending', hint: 'The stock is saved without packages (packaging pending). Configure them later, when the sizes are known.' },
]

export const newPack = (type: string, method: PackMethod = 'ONE'): PackValue => ({ method, type, count: '', each: '', rows: [emptyRow()] })

const round3 = (n: number) => Math.round(n * 1000) / 1000
const fits = (q: number, places: number) => Math.abs(q * 10 ** places - Math.round(q * 10 ** places)) < 1e-6
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
export const nounsOf = (type: string) => PACK_TYPES.find((p) => p.value === type) ?? PACK_TYPES[6]

/** Full packages of `each` and one for the rest: 1,200 at 500 is 500, 500, 200. */
export function byCapacity(total: number, each: number): number[] {
  const t = round3(total)
  if (!(t > 0) || !(each > 0)) return []
  if (each >= t) return [t]
  const full = Math.floor(t / each + 1e-9)
  const rest = round3(t - full * each)
  return [...Array<number>(full).fill(round3(each)), ...(rest > 0.0005 ? [rest] : [])]
}

export interface PackPlan {
  qtys: number[]
  /** Each package's roll number or note, lined up with `qtys`. */
  notes: string[]
  /** What goes on stickers, and what is left without. */
  on: number
  loose: number
  /** What stops it being saved, in plain words. */
  problem: string | null
}

/**
 * What a choice makes of `total`. `part`: packages adding up to less than the
 * total are allowed, the rest staying without stickers.
 */
export function planOf(v: PackValue, total: number, unit: string, places: number, part = true): PackPlan {
  const t = round3(total)
  const out = (qtys: number[], notes: string[] = [], problem: string | null = null): PackPlan => {
    const on = round3(qtys.reduce((s, q) => s + q, 0))
    return { qtys, notes, on, loose: round3(Math.max(0, t - on)), problem }
  }
  if (!(t > 0)) return out([], [], 'Enter the quantity first.')
  const n = nounsOf(v.type)
  const whole = (q: number) => (places === 0 ? `${unit} are counted whole: ${qtyText(q)} is not.` : `At most ${places} decimals in ${unit}.`)
  switch (v.method) {
    case 'ONE':
      return out([t])
    case 'EQUAL': {
      const count = Math.floor(Number(v.count) || 0)
      if (!(count >= 1)) return out([], [], `Into how many ${n.many}?`)
      if (count > 1000) return out([], [], 'At most 1,000 packages at a time.')
      const qtys = splitEvenly(t, count, places)
      if (qtys.some((q) => !(q > 0))) return out([], [], `${qtyText(t)} ${unit} does not make ${count} ${n.many}.`)
      return out(qtys)
    }
    case 'EACH': {
      const each = Number(v.each) || 0
      if (!(each > 0)) return out([], [], `How much does one ${n.one} hold?`)
      if (!fits(each, places)) return out([], [], whole(each))
      const qtys = byCapacity(t, each)
      if (qtys.length > 1000) return out([], [], `That is ${qtys.length} ${n.many}: at most 1,000 at a time.`)
      return out(qtys)
    }
    case 'LIST': {
      const qtys = sizesOf(v.rows)
      const notes = notesOf(v.rows)
      if (!qtys.length) return out([], [], `Type what is in each ${n.one}.`)
      const bad = qtys.find((q) => !fits(q, places))
      if (bad !== undefined) return out(qtys, notes, whole(bad))
      const on = round3(qtys.reduce((s, q) => s + q, 0))
      if (on > t + 0.0005) return out(qtys, notes, `The ${n.many} add up to ${qtyText(on)} ${unit}, more than the ${qtyText(t)} ${unit} there is: ${qtyText(round3(on - t))} over.`)
      if (!part && on < t - 0.0005) return out(qtys, notes, `The ${n.many} add up to ${qtyText(on)} ${unit}, but there is ${qtyText(t)} ${unit}: ${qtyText(round3(t - on))} short.`)
      return out(qtys, notes)
    }
    case 'LATER':
      return out([])
  }
}

/** "5 rolls", "1 box", "Packaging pending" — and what is left pending, when some is. */
export function packText(plan: PackPlan, type: string, unit: string) {
  const n = nounsOf(type)
  const count = plan.qtys.length
  if (!count) return 'Packaging pending'
  return `${count} ${count === 1 ? n.one : n.many}${plan.loose > 0.0005 ? ` + ${qtyText(plan.loose)} ${unit} pending` : ''}`
}

/** The packing chosen, as a save or an import takes it: the sizes worked out here, or packaging pending. */
export interface PackInputBody {
  type: string
  qtys?: number[]
  refs?: Array<string | null>
  later?: boolean
  count?: number
}
export function packInputOf(v: PackValue, total: number, unit: string, places: number): PackInputBody {
  if (v.method === 'LATER') return { type: v.type, later: true, ...(Number(v.count) >= 1 ? { count: Math.floor(Number(v.count)) } : {}) }
  const plan = planOf(v, total, unit, places)
  return { type: v.type, qtys: plan.qtys, ...(plan.notes.some(Boolean) ? { refs: plan.notes.map((n) => n || null) } : {}) }
}

/** What a saved plan was, as the editor's value: one package, so many the same, each its own, or pending. */
export function packValueOf(p: { type: string; qtys: number[]; later: boolean; count: number | null }): PackValue {
  if (p.later || !p.qtys.length) return { ...newPack(p.type, 'LATER'), count: p.count ? String(p.count) : '' }
  if (p.qtys.length === 1) return newPack(p.type, 'ONE')
  if (p.qtys.every((q) => Math.abs(q - p.qtys[0]) < 0.0005)) return { ...newPack(p.type, 'EQUAL'), count: String(p.qtys.length) }
  return { ...newPack(p.type, 'LIST'), rows: rowsOf(p.qtys) }
}

/** What each package holds, in a few words: "200 mtr each", "500 + 500 + 200 mtr". */
export function sizesText(qtys: number[], unit: string) {
  if (!qtys.length) return ''
  if (qtys.length === 1) return `${qtyText(qtys[0])} ${unit}`
  if (qtys.every((q) => Math.abs(q - qtys[0]) < 0.0005)) return `${qtyText(qtys[0])} ${unit} each`
  const last = qtys[qtys.length - 1]
  if (qtys.length > 2 && qtys.slice(0, -1).every((q) => Math.abs(q - qtys[0]) < 0.0005)) return `${qtyText(qtys[0])} ${unit} each, the last ${qtyText(last)}`
  return qtys.length <= 8 ? `${qtys.map(qtyText).join(' + ')} ${unit}` : `${qtys.slice(0, 6).map(qtyText).join(' + ')} + … ${unit}`
}

export function PackagingEditor({
  value,
  onChange,
  total,
  unit,
  places = 3,
  part = true,
  noteLabel = 'Note (optional)',
  countForLater = false,
  laterText,
  idPrefix = 'packing',
  methods,
  tried = false,
}: {
  value: PackValue
  onChange: (v: PackValue) => void
  /** What is being packed. */
  total: number
  unit: string
  /** How finely the item is counted: 0 for pieces and cartons. */
  places?: number
  /** Packages may hold less than the total, the rest left without stickers. */
  part?: boolean
  /** The heading over each package's note: "Roll no. / note". */
  noteLabel?: string
  /** Packaging pending: ask how many packages there will be. */
  countForLater?: boolean
  laterText?: string
  idPrefix?: string
  /** The choices offered: all, unless said. */
  methods?: PackMethod[]
  /** Save was pressed: what stops it is said loudly. */
  tried?: boolean
}) {
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const plan = planOf(value, total, unit, places, part)
  const n = nounsOf(value.type)
  const set = (patch: Partial<PackValue>) => onChange({ ...value, ...patch })
  // Into "Different sizes", what was worked out so far is the start: change any row that differs.
  const switchTo = (method: PackMethod) => set(method === 'LIST' && value.method !== 'LIST' && plan.qtys.length > 1 ? { method, rows: rowsOf(plan.qtys) } : { method })
  const hint = value.method === 'LATER' && laterText ? laterText : PACK_METHODS.find((m) => m.value === value.method)?.hint

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground text-sm font-medium">Packed in</span>
        <SmartSelect id={`${idPrefix}-type`} className="form-input h-9 w-36" value={value.type} onChange={(e) => set({ type: e.target.value })} aria-label="What each package is">
          {PACK_TYPES.map((p) => (
            <option key={p.value} value={p.value}>
              {cap(p.many)}
            </option>
          ))}
        </SmartSelect>
      </div>

      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="How it is packed">
        {PACK_METHODS.filter((m) => !methods || methods.includes(m.value)).map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={value.method === m.value}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm transition-colors',
              value.method === m.value ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-border text-muted-foreground hover:text-foreground',
            )}
            onClick={() => switchTo(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">{hint}</p>

      {value.method === 'EQUAL' && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground">Into</span>
          <StepInput id={`${idPrefix}-count`} className="form-input h-9 w-24 text-right" value={value.count} onValueChange={(v) => set({ count: v })} min={0} max={1000} aria-label={`Into how many ${n.many}`} autoFocus />
          <span className="text-foreground">{n.many}</span>
        </label>
      )}
      {value.method === 'EACH' && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground">Each {n.one} holds</span>
          <StepInput id={`${idPrefix}-each`} decimals={places > 0} className="form-input h-9 w-28 text-right" value={value.each} onValueChange={(v) => set({ each: v })} aria-label={`What one ${n.one} holds`} autoFocus />
          <span className="text-foreground">{unit}</span>
        </label>
      )}
      {value.method === 'LIST' && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <button type="button" className="text-primary inline-flex items-center gap-1 text-xs font-medium hover:underline" onClick={() => setPasting((p) => !p)}>
              <ClipboardPaste size={13} /> {pasting ? 'Close' : 'Paste a packing list'}
            </button>
          </div>
          {pasting && (
            <div className="space-y-1.5">
              <textarea
                id={`${idPrefix}-paste`}
                className="form-input min-h-[5rem] w-full text-sm"
                placeholder={'One size a line, or with commas:\n200\n250\n150'}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                aria-label="Packing list"
              />
              <button
                type="button"
                className="btn-secondary h-8 text-xs"
                disabled={!parseSizes(pasted).length}
                onClick={() => {
                  set({ rows: rowsOf(parseSizes(pasted)) })
                  setPasting(false)
                  setPasted('')
                }}
              >
                Use {parseSizes(pasted).length || ''} sizes
              </button>
            </div>
          )}
          <PackageRows rows={value.rows} onChange={(rows) => set({ rows })} unit={unit} idPrefix={idPrefix} noteLabel={noteLabel} max={1000} />
        </div>
      )}
      {value.method === 'LATER' && countForLater && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground">How many {n.many}, if known</span>
          <StepInput id={`${idPrefix}-later-count`} className="form-input h-9 w-24 text-right" value={value.count} onValueChange={(v) => set({ count: v })} min={0} max={1000} aria-label={`How many ${n.many} there are`} />
        </label>
      )}

      <PackSummary plan={plan} type={value.type} unit={unit} total={total} tried={tried} />
    </div>
  )
}

/** Total · on stickers · without, as it is typed — and what stops it, if anything. */
export function PackSummary({ plan, type, unit, total, tried = false }: { plan: PackPlan; type: string; unit: string; total: number; tried?: boolean }) {
  const n = nounsOf(type)
  const count = plan.qtys.length
  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="border-border grid grid-cols-3 divide-x divide-border rounded-lg border text-sm" aria-label="Packing summary">
        <Figure label="Total" value={`${qtyText(total)} ${unit}`} />
        <Figure label={count ? `On ${count} ${count === 1 ? 'sticker' : 'stickers'}` : 'On stickers'} value={`${qtyText(plan.on)} ${unit}`} sub={count ? `${count} ${count === 1 ? n.one : n.many}: ${sizesText(plan.qtys, unit)}` : undefined} />
        <Figure label="Without stickers" value={`${qtyText(plan.loose)} ${unit}`} tone={plan.loose > 0.0005 ? 'warn' : undefined} />
      </div>
      {plan.problem && (
        <p className={cn('text-sm', tried ? 'font-semibold text-red-400' : 'warn-text')} role={tried ? 'alert' : undefined}>
          {plan.problem}
        </p>
      )}
    </div>
  )
}

function Figure({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className="min-w-0 px-3 py-2">
      <p className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">{label}</p>
      <p className={cn('font-semibold tabular-nums', tone === 'warn' ? 'warn-text' : 'text-foreground')}>{value}</p>
      {sub && <p className="text-muted-foreground truncate text-[11px]" title={sub}>{sub}</p>}
    </div>
  )
}

/**
 * The editor in a window of its own, over a row or a line: "Packed as" on an
 * opening stock lot, "Make stickers" on a line still without them.
 */
export function PackagingDialog({
  title,
  subtitle,
  initial,
  total,
  unit,
  places,
  part = true,
  noteLabel,
  countForLater,
  laterText,
  allowLater = true,
  busy = false,
  error,
  saveLabel,
  onSave,
  onSaveAndPrint,
  onClose,
}: {
  title: string
  subtitle: ReactNode
  initial: PackValue
  total: number
  unit: string
  places: number
  part?: boolean
  noteLabel?: string
  countForLater?: boolean
  laterText?: string
  /** "Packaging pending" offered: not when stickers are being made now. */
  allowLater?: boolean
  busy?: boolean
  error?: string | null
  saveLabel: (plan: PackPlan) => string
  onSave: (plan: PackPlan, value: PackValue) => void
  /** "Save & print" beside it, when there are stickers to print. */
  onSaveAndPrint?: (plan: PackPlan, value: PackValue) => void
  onClose: () => void
}) {
  const [value, setValue] = useState<PackValue>(!allowLater && initial.method === 'LATER' ? { ...initial, method: 'ONE' } : initial)
  const [tried, setTried] = useState(false)
  const plan = planOf(value, total, unit, places, part)
  const save = (then: (plan: PackPlan, value: PackValue) => void) => {
    if (plan.problem) return setTried(true)
    then(plan, value)
  }
  useEscape(() => {
    if (!busy) onClose()
  })

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className={cn('glass-card flex max-h-full w-full flex-col overflow-hidden', value.method === 'LIST' ? 'max-w-2xl' : 'max-w-xl')} role="dialog" aria-modal="true" aria-labelledby="packaging-title">
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <Package size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="packaging-title" className="text-foreground text-lg font-semibold">
              {title}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">{subtitle}</p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          <PackagingEditor
            value={value}
            onChange={(v) => {
              setValue(v)
              setTried(false)
            }}
            methods={allowLater ? undefined : ['ONE', 'EQUAL', 'EACH', 'LIST']}
            tried={tried}
            total={total}
            unit={unit}
            places={places}
            part={part}
            noteLabel={noteLabel}
            countForLater={countForLater}
            laterText={laterText}
          />
          {error && (
            <p className="mt-2 text-sm text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 p-5">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {onSaveAndPrint && plan.qtys.length > 0 && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => save(onSaveAndPrint)}>
              <Printer size={15} /> Save &amp; print
            </button>
          )}
          <button type="button" className="btn-primary" disabled={busy} onClick={() => save(onSave)}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            {saveLabel(plan)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
