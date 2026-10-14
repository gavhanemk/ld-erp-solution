'use client'

import { useEffect, useMemo, useState } from 'react'
import { Info, Loader2, Printer, Tags } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { StepInput } from '@/components/ui/StepInput'
import { PACK_TYPES, openPrintTab, printLabels, qtyText } from './packageTypes'

/** The inward documents the sticker window opens after. */
export type InwardSource = 'GRN' | 'STOCK_IN' | 'OPENING' | 'CUSTOMER_GRN' | 'JOB_WORK_RETURN' | 'MR_RETURN'

/** What the window is for: a document, and — for a return from the floor — what came back on it. */
export interface InwardRef {
  type: InwardSource
  id: string
  lines?: Array<{
    itemId: string
    warehouseId: string
    ownership: 'OWNED' | 'CUSTOMER_OWNED'
    ownerCustomerId: string | null
    qty: number
  }>
  /** Opened by hand ("Print stickers"), so it says so when there is nothing left, rather than not opening. */
  explicit?: boolean
}

/** Stock to sticker: one item in one store, and how much of it can be. */
export interface LabelTarget {
  itemId: string
  item: string
  itemCode: string
  unit: string
  warehouseId: string
  store: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  owner?: string | null
  grnLineId?: string | null
  lotNo?: string | null
  packType: string
  /** What one sticker usually holds: the item's own setting, or 1 for a roll or box. */
  perPack?: number | null
  /** How much can be stickered. */
  max: number
  /** Where it came in, for the window's title: GRN-0004. */
  sourceRef?: string | null
  /** What one unit holds, when the item says: 144 pcs to a box. */
  content?: { each: number; unit: string } | null
}

interface Plan {
  sourceRef: string
  targets: Array<LabelTarget & { key: string; qtys: number[] }>
  untracked: Array<{ itemId: string; code: string; name: string; category: string }>
}

interface Row {
  skip: boolean
  open: boolean
  /** Different sizes: one quantity a line, for rolls of 48 m, 51 m… */
  sizes: boolean
  each: string
  /** Empty: as many as it takes to cover everything. */
  count: string
  list: string
  lotNo: string
  changed: boolean
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** Everything, at so much a sticker: 12 at 1 → twelve 1s; 25 at 10 → 10, 10, 5. */
function cover(max: number, each: number): number[] {
  if (!(each > 0) || !(max > 0)) return []
  if (each >= max) return [r3(max)]
  const n = Math.floor(max / each + 1e-9)
  if (n > 500) return []
  const out = Array.from({ length: n }, () => r3(each))
  const rest = r3(max - n * each)
  if (rest >= 0.0105) out.push(rest)
  else if (rest > 0) out[out.length - 1] = r3(out[out.length - 1] + rest)
  return out
}

const parseList = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((t) => Number(t.replace(/[^\d.]/g, '')))
    .filter((n) => n > 0)

function qtysOf(t: LabelTarget, r: Row): number[] {
  if (r.skip) return []
  if (r.sizes) return parseList(r.list)
  const each = Number(r.each)
  const count = Math.floor(Number(r.count) || 0)
  return count > 0 ? (each > 0 ? Array.from({ length: Math.min(count, 500) }, () => r3(each)) : []) : cover(t.max, each)
}

function startRow(t: LabelTarget, suggested?: number[]): Row {
  const q = suggested?.length ? suggested : t.perPack && t.perPack > 0 ? cover(t.max, t.perPack) : [r3(t.max)]
  // Too many to cover in one go — 1,211 rolls on the rack: what each holds is
  // known, how many to print now is the one thing to ask.
  const tooMany = Boolean(!suggested?.length && t.perPack && t.perPack > 0 && !q.length)
  const same = tooMany || (q.length > 0 && q.slice(0, -1).every((x) => x === q[0]))
  return {
    skip: false,
    open: Boolean(tooMany),
    sizes: !same,
    each: tooMany ? String(t.perPack) : same ? String(q[0]) : '',
    count: '',
    list: same ? '' : q.join('\n'),
    lotNo: t.lotNo ?? '',
    changed: false,
  }
}

const many = (packType: string) => (PACK_TYPES.find((p) => p.value === packType) ?? PACK_TYPES[6]).many
const one = (packType: string) => (PACK_TYPES.find((p) => p.value === packType) ?? PACK_TYPES[6]).one

/** "2 stickers, 1 box on each" — the whole plan for one item, in words. */
function sentence(t: LabelTarget, r: Row, qtys: number[]) {
  if (r.skip) return 'No stickers for this one.'
  if (!qtys.length) return r.sizes ? `Type what is in each ${one(t.packType)}, one a line.` : 'Say how many stickers.'
  const total = r3(qtys.reduce((s, q) => s + q, 0))
  const n = `${qtys.length} ${qtys.length === 1 ? 'sticker' : 'stickers'}`
  const what = r.sizes
    ? `${qtys.map(qtyText).join(', ')} ${t.unit}`
    : qtys.length > 1 && qtys[qtys.length - 1] !== qtys[0]
      ? `${qtyText(qtys[0])} ${t.unit} on each, the last ${qtyText(qtys[qtys.length - 1])}`
      : `${qtyText(qtys[0])} ${t.unit} on each${t.content ? ` (${qtyText(qtys[0] * t.content.each)} ${t.content.unit})` : ''}`
  const left = r3(t.max - total)
  return `${n}, ${what}${left > 0.0005 ? ` · ${qtyText(left)} ${t.unit} stays without a sticker` : ''}`
}

/**
 * The one sticker window: after stock comes in, and from To label.
 *
 * Each item is a sentence — "2 stickers, 1 box on each" — worked out from the
 * item, so the usual case is one press of Print. "Change" opens the two
 * figures behind the sentence, a lot, and sizes for rolls that differ; what is
 * changed is remembered for the item without being asked. Nothing is saved
 * until Print; Skip leaves the stock under Stickers → No stickers.
 */
export function InwardStickers({
  source,
  targets: given,
  onClose,
  onDone,
}: {
  /** After an inward: the document, its lines read from the server. */
  source?: InwardRef
  /** From To label: the stock to sticker, already known. */
  targets?: LabelTarget[]
  onClose: () => void
  /** The message, and the packages made, so they can be printed again. */
  onDone: (message: string, ids: string[]) => void
}) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (given) {
      const targets = given.map((t, i) => ({ ...t, key: `${t.itemId}-${t.warehouseId}-${t.grnLineId ?? i}`, qtys: [] as number[] }))
      setPlan({ sourceRef: given[0]?.sourceRef ?? '', targets, untracked: [] })
      setRows(Object.fromEntries(targets.map((t) => [t.key, startRow(t)])))
      return
    }
    if (!source) return onClose()
    let live = true
    api
      .post<{ data: Plan }>('/packages/plan', { sourceType: source.type, sourceId: source.id, lines: source.lines })
      .then((res) => {
        if (!live) return
        // Nothing to sticker and nothing to explain: no window at all, unless
        // somebody asked for it — then it says why there is nothing.
        if (!res.data.targets.length && !res.data.untracked.length && !source.explicit) return onClose()
        setPlan(res.data)
        setRows(Object.fromEntries(res.data.targets.map((t) => [t.key, startRow(t, t.qtys)])))
      })
      // The document is saved either way; a window that cannot open is not worth an error over it.
      .catch(() => live && onClose())
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.type, source?.id])

  const edit = (key: string, patch: Partial<Row>) => setRows((p) => ({ ...p, [key]: { ...p[key], ...patch, changed: true } }))

  const picked = useMemo(
    () =>
      (plan?.targets ?? [])
        .filter((t) => rows[t.key] && !rows[t.key].skip)
        .map((t) => {
          const r = rows[t.key]
          const qtys = qtysOf(t, r)
          const total = r3(qtys.reduce((s, q) => s + q, 0))
          const problem = !qtys.length
            ? `${t.item}: ${r.sizes ? 'type what is in each, one a line' : 'say how many stickers'}.`
            : total > t.max + 1e-9
              ? `${t.item}: that is ${qtyText(total)} ${t.unit}, but only ${qtyText(t.max)} can have stickers.`
              : null
          return { t, r, qtys, problem }
        }),
    [plan, rows],
  )
  const stickers = picked.reduce((s, p) => s + p.qtys.length, 0)
  const blocker = !picked.length ? 'Nothing to print.' : (picked.find((p) => p.problem)?.problem ?? (stickers > 500 ? 'Up to 500 stickers at a time.' : null))

  const print = async () => {
    if (!plan) return
    setSaving(true)
    setError(null)
    // Opened on the click itself: a tab opened after the save is blocked as a pop-up.
    const tab = openPrintTab()
    try {
      const groups = picked.map(({ t, r, qtys }) => ({
        itemId: t.itemId,
        warehouseId: t.warehouseId,
        ownership: t.ownership,
        ownerCustomerId: t.ownerCustomerId,
        grnLineId: t.grnLineId ?? null,
        packType: t.packType,
        qtys,
        lotNo: r.lotNo.trim() || null,
        // Changed here, so next time starts the same way. Sizes that differ
        // roll to roll are nothing to remember.
        remember: r.changed && !r.sizes,
      }))
      const ids: string[] = []
      let message = ''
      if (source) {
        const res = await api.post<{ message: string; data: Array<{ id: string }> }>('/packages/batch', { sourceType: source.type, sourceId: source.id, groups })
        ids.push(...res.data.map((p) => p.id))
        message = res.message
      } else {
        for (const g of groups) {
          const res = await api.post<{ message: string; data: Array<{ id: string }> }>('/packages', g)
          ids.push(...res.data.map((p) => p.id))
          message = res.message
        }
      }
      printLabels(ids, tab)
      onDone(`${message} The stickers have opened in a new tab: press Print there.`, ids)
    } catch (err) {
      tab?.close()
      setError(err instanceof ApiError ? err.message : 'Could not make the stickers. Is the API running?')
    } finally {
      setSaving(false)
    }
  }

  if (!plan) {
    return (
      <FormFrame icon={Tags} title="Stickers" subtitle="Getting the stickers ready…" onClose={onClose} primary={null} width="max-w-md">
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 size={16} className="animate-spin" /> One moment…
        </div>
      </FormFrame>
    )
  }

  const printButton = plan.targets.length ? (
    <button type="button" className="btn-primary" onClick={() => void print()} disabled={saving || Boolean(blocker)}>
      {saving ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />}
      Print {stickers || ''} {stickers === 1 ? 'sticker' : 'stickers'}
    </button>
  ) : (
    <button type="button" className="btn-primary" onClick={onClose}>
      Close
    </button>
  )

  return (
    <FormFrame
      icon={Tags}
      title={plan.sourceRef ? `Stickers for ${plan.sourceRef}` : 'Stickers'}
      subtitle="Check the line below and press Print. Change it only if it is not how the goods are packed."
      onClose={onClose}
      busy={saving}
      error={error}
      width="max-w-2xl"
      primary={printButton}
      footer={
        plan.targets.length ? (
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Skip
          </button>
        ) : null
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : null}
    >
      <div className="space-y-2.5">
        {!plan.targets.length && !plan.untracked.length && (
          <p className="text-muted-foreground py-4 text-center text-sm">
            Nothing left to sticker on {plan.sourceRef || 'this'}: it all has stickers already, or has since been used.
          </p>
        )}
        {plan.targets.map((t) => {
          const r = rows[t.key]
          if (!r) return null
          const qtys = qtysOf(t, r)
          return (
            <div key={t.key} className="border-border bg-card rounded-xl border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="text-foreground text-sm font-semibold">
                  {t.item} <span className="text-muted-foreground font-mono text-xs font-normal">{t.itemCode}</span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {qtyText(t.max)} {t.unit} · {t.store}
                  {t.owner ? ` · ${t.owner}'s` : ''}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className={`flex items-center gap-1.5 text-sm ${r.skip ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                  <Tags size={14} className="text-primary shrink-0" />
                  {sentence(t, r, qtys)}
                </span>
                <button type="button" className="text-primary text-sm font-medium hover:underline" onClick={() => setRows((p) => ({ ...p, [t.key]: { ...r, open: !r.open } }))}>
                  {r.open ? 'Done' : 'Change'}
                </button>
              </div>

              {r.open && (
                <div className="border-border mt-3 space-y-3 border-t pt-3">
                  {r.sizes ? (
                    <label className="block">
                      <span className="form-label">What is in each {one(t.packType)}, one a line</span>
                      <textarea
                        className="form-input font-mono text-sm"
                        rows={Math.min(6, Math.max(3, r.list.split('\n').length))}
                        value={r.list}
                        onChange={(e) => edit(t.key, { list: e.target.value })}
                        placeholder={'e.g.\n48.5\n51\n50.2'}
                        aria-label={`What is in each ${one(t.packType)} of ${t.item}`}
                      />
                    </label>
                  ) : (
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="block">
                        <span className="form-label">How many stickers</span>
                        <StepInput
                          className="form-input h-10 w-28"
                          value={r.count || (qtys.length ? String(qtys.length) : '')}
                          onValueChange={(v) => edit(t.key, { count: v })}
                          min={1}
                          aria-label={`How many stickers for ${t.item}`}
                        />
                      </label>
                      <span className="text-muted-foreground pb-2.5">×</span>
                      <label className="block">
                        <span className="form-label">On each</span>
                        <div className="relative w-32">
                          <StepInput
                            className="form-input h-10 pr-10"
                            value={r.each}
                            // A new amount a sticker: cover everything again, unless a count was typed.
                            onValueChange={(v) => edit(t.key, { each: v })}
                            decimals
                            aria-label={`How much on each sticker for ${t.item}`}
                          />
                          <span className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs">{t.unit}</span>
                        </div>
                      </label>
                    </div>
                  )}
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block">
                      <span className="form-label">Lot (optional)</span>
                      <input
                        className="form-input h-10 w-40"
                        value={r.lotNo}
                        onChange={(e) => edit(t.key, { lotNo: e.target.value })}
                        maxLength={50}
                        aria-label={`Lot of ${t.item}`}
                      />
                    </label>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 pb-2.5 text-sm">
                      <button
                        type="button"
                        className="text-primary font-medium hover:underline"
                        onClick={() =>
                          edit(t.key, r.sizes ? { sizes: false, each: String(qtys[0] ?? t.perPack ?? ''), count: '' } : { sizes: true, list: qtys.join('\n') })
                        }
                      >
                        {r.sizes ? 'All the same size' : `${many(t.packType).replace(/^./, (c) => c.toUpperCase())} of different sizes`}
                      </button>
                      <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => setRows((p) => ({ ...p, [t.key]: { ...r, skip: !r.skip } }))}>
                        {r.skip ? 'Print stickers for this' : "Don't print this one"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {plan.untracked.length > 0 && (
          <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
            <Info size={13} className="mt-0.5 shrink-0" />
            No stickers for {plan.untracked.map((u) => u.name).join(', ')}: stickers are switched off for{' '}
            {[...new Set(plan.untracked.map((u) => u.category))].join(', ')} in Masters → Item Categories.
          </p>
        )}
      </div>
    </FormFrame>
  )
}
