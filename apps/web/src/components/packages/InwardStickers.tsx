'use client'

import { useEffect, useMemo, useState } from 'react'
import { Info, ListOrdered, Loader2, Printer, Tags } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
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
}

interface Target {
  key: string
  itemId: string
  itemCode: string
  item: string
  unit: string
  warehouseId: string
  store: string
  ownership: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId: string | null
  owner: string | null
  lotNo: string | null
  grnLineId: string | null
  max: number
  packType: string
  perPack: number | null
  remembered: boolean
  qtys: number[]
}

interface Plan {
  sourceRef: string
  targets: Target[]
  untracked: Array<{ itemId: string; code: string; name: string; category: string }>
}

interface Row {
  on: boolean
  packType: string
  mode: 'same' | 'each'
  /** What one sticker holds, when they are all the same. */
  each: string
  /** One quantity a line, when they are not. */
  list: string
  lotNo: string
  remember: boolean
  /** Unticked by hand: a later edit does not tick it again. */
  rememberSet: boolean
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** 12 at 1 → twelve 1s; 25 at 10 → 10, 10, 5. Rounding dust goes on the last one, not a sticker of its own. */
function split(max: number, each: number): number[] {
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

function qtysOf(t: Target, r: Row): number[] {
  return r.mode === 'same' ? split(t.max, Number(r.each)) : parseList(r.list)
}

function startRow(t: Target): Row {
  const q = t.qtys
  const head = q.slice(0, -1)
  const same = q.length > 0 && head.every((x) => x === q[0])
  return {
    on: true,
    packType: t.packType,
    mode: same ? 'same' : 'each',
    each: same ? String(q[0]) : '',
    list: same ? '' : q.join('\n'),
    lotNo: t.lotNo ?? '',
    remember: false,
    rememberSet: false,
  }
}

/**
 * The stickers for what just came in, ready to print.
 *
 * Opens by itself after a GRN, a stock-in, opening stock, a customer's
 * material, a job worker's return or a return from the floor, filled in from
 * each item's remembered setting — one sticker a roll, say — so printing is
 * one click. Anything can be changed first, and "remember" keeps the change
 * for the item. Nothing is saved until Print, and closing it loses nothing:
 * the same stock waits under Packages & Stickers → To label.
 */
export function InwardStickers({ source, onClose, onDone }: { source: InwardRef; onClose: () => void; onDone: (message: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .post<{ data: Plan }>('/packages/plan', { sourceType: source.type, sourceId: source.id, lines: source.lines })
      .then((res) => {
        if (!live) return
        // Nothing to label and nothing to explain: no window at all.
        if (!res.data.targets.length && !res.data.untracked.length) return onClose()
        setPlan(res.data)
        setRows(Object.fromEntries(res.data.targets.map((t) => [t.key, startRow(t)])))
      })
      // The document is saved either way; a window that cannot open is not worth an error over it.
      .catch(() => live && onClose())
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.type, source.id])

  const edit = (key: string, patch: Partial<Row>, settingChange = true) =>
    setRows((p) => {
      const r = { ...p[key], ...patch }
      // Changing how it is packed ticks "remember", unless somebody unticked it.
      if (settingChange && !r.rememberSet) r.remember = true
      return { ...p, [key]: r }
    })

  const picked = useMemo(
    () =>
      (plan?.targets ?? [])
        .filter((t) => rows[t.key]?.on)
        .map((t) => {
          const r = rows[t.key]
          const qtys = qtysOf(t, r)
          const total = r3(qtys.reduce((s, q) => s + q, 0))
          const problem = !qtys.length
            ? `Say what one sticker holds for ${t.item}.`
            : total > t.max + 1e-9
              ? `${t.item}: that is ${qtyText(total)} ${t.unit}; only ${qtyText(t.max)} came in.`
              : null
          return { t, r, qtys, total, problem }
        }),
    [plan, rows],
  )
  const stickers = picked.reduce((s, p) => s + p.qtys.length, 0)
  const blocker = !picked.length ? 'Tick at least one item, or close to label it later.' : (picked.find((p) => p.problem)?.problem ?? (stickers > 500 ? 'Up to 500 stickers at a time.' : null))

  const print = async () => {
    if (!plan) return
    setSaving(true)
    setError(null)
    // Opened on the click itself: a tab opened after the save is blocked as a pop-up.
    const tab = openPrintTab()
    try {
      const res = await api.post<{ message: string; data: Array<{ id: string }> }>('/packages/batch', {
        sourceType: source.type,
        sourceId: source.id,
        groups: picked.map(({ t, r, qtys }) => ({
          itemId: t.itemId,
          warehouseId: t.warehouseId,
          ownership: t.ownership,
          ownerCustomerId: t.ownerCustomerId,
          grnLineId: t.grnLineId,
          packType: r.packType,
          qtys,
          lotNo: r.lotNo.trim() || null,
          remember: r.remember,
        })),
      })
      printLabels(
        res.data.map((p) => p.id),
        tab,
      )
      onDone(`${res.message} The stickers have opened in a new tab for printing.`)
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
          <Loader2 size={16} className="animate-spin" /> Working out what came in…
        </div>
      </FormFrame>
    )
  }

  return (
    <FormFrame
      icon={Tags}
      title={`Stickers for ${plan.sourceRef}`}
      subtitle="Filled in from each item's sticker settings. Change anything before printing; tick Remember to keep it for next time."
      onClose={onClose}
      busy={saving}
      error={error}
      width="max-w-4xl"
      primary={
        plan.targets.length ? (
          <button type="button" className="btn-primary" onClick={() => void print()} disabled={saving || Boolean(blocker)}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />}
            Print {stickers || ''} {stickers === 1 ? 'sticker' : 'stickers'}
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={onClose}>
            Close
          </button>
        )
      }
      footer={
        plan.targets.length ? (
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Later
          </button>
        ) : null
      }
      footerNote={
        blocker ? (
          <span className="warn-text">{blocker}</span>
        ) : plan.targets.length ? (
          'Later keeps them under Packages & Stickers → To label.'
        ) : null
      }
    >
      <div className="space-y-3">
        {plan.targets.map((t) => {
          const r = rows[t.key]
          if (!r) return null
          const qtys = qtysOf(t, r)
          const total = r3(qtys.reduce((s, q) => s + q, 0))
          const kind = PACK_TYPES.find((p) => p.value === r.packType) ?? PACK_TYPES[6]
          return (
            <div key={t.key} className={`border-border rounded-xl border p-3 ${r.on ? 'bg-card' : 'bg-secondary/40 opacity-70'}`}>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={r.on} onChange={(e) => edit(t.key, { on: e.target.checked }, false)} />
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block text-sm font-semibold">
                    {t.item} <span className="text-muted-foreground font-mono text-xs font-normal">{t.itemCode}</span>
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {qtyText(t.max)} {t.unit} into {t.store}
                    {t.owner ? ` · ${t.owner}'s` : ''}
                  </span>
                </span>
              </label>

              {r.on && (
                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-[9rem_1fr_9rem]">
                  <div>
                    <span className="form-label">Each package is a</span>
                    <SmartSelect className="form-input h-9" value={r.packType} onChange={(e) => edit(t.key, { packType: e.target.value })}>
                      {PACK_TYPES.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </SmartSelect>
                  </div>

                  {r.mode === 'same' ? (
                    <div className="col-span-2 sm:col-span-1">
                      {/* Two figures, each named: "1 box = 2 boxes" read as nonsense
                        when the second was the number of stickers. */}
                      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                        <label className="block">
                          <span className="form-label">One sticker holds</span>
                          <div className="relative w-32">
                            <StepInput
                              className="form-input h-9 pr-10"
                              value={r.each}
                              onValueChange={(v) => edit(t.key, { each: v })}
                              decimals
                              aria-label={`What one sticker holds for ${t.item}`}
                            />
                            <span className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs">{t.unit}</span>
                          </div>
                        </label>
                        <label className="block">
                          <span className="form-label">Number of stickers</span>
                          <div className="w-24">
                            <StepInput
                              className="form-input h-9"
                              value={qtys.length ? String(qtys.length) : ''}
                              onValueChange={(v) => {
                                const n = Math.floor(Number(v) || 0)
                                if (n > 0) edit(t.key, { each: String(r3(t.max / n)) })
                              }}
                              min={1}
                              aria-label={`Number of stickers for ${t.item}`}
                            />
                          </div>
                        </label>
                        <button
                          type="button"
                          className="text-primary pb-2.5 text-xs font-medium hover:underline"
                          onClick={() => edit(t.key, { mode: 'each', list: qtys.join('\n') })}
                          title={`For ${kind.many} that hold different amounts, like rolls of 48 m and 51 m`}
                        >
                          <ListOrdered size={12} className="mr-1 inline" />
                          Each one different
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="col-span-2 sm:col-span-1">
                      <span className="form-label">One {kind.one} a line</span>
                      <textarea
                        className="form-input font-mono text-sm"
                        rows={Math.min(6, Math.max(2, r.list.split('\n').length))}
                        value={r.list}
                        onChange={(e) => edit(t.key, { list: e.target.value })}
                        placeholder={'e.g.\n48.5\n51\n50.2'}
                        aria-label={`Quantities of each ${kind.one} of ${t.item}`}
                      />
                      <button type="button" className="text-primary mt-1 text-xs font-medium hover:underline" onClick={() => edit(t.key, { mode: 'same', each: String(qtys[0] ?? '') })}>
                        All the same size
                      </button>
                    </div>
                  )}

                  <div>
                    <span className="form-label">Lot / batch</span>
                    <input
                      className="form-input h-9 placeholder:text-muted-foreground/60"
                      value={r.lotNo}
                      onChange={(e) => edit(t.key, { lotNo: e.target.value }, false)}
                      placeholder="Optional"
                      maxLength={50}
                      aria-label={`Lot of ${t.item}`}
                    />
                  </div>

                  <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 sm:col-span-3">
                    <span className={`text-xs ${total > t.max + 1e-9 ? 'text-red-400' : 'text-muted-foreground'}`}>
                      {qtys.length
                        ? `${qtys.length} ${qtys.length === 1 ? 'sticker' : 'stickers'}, ${qtyText(total)} ${t.unit} in all${total < t.max - 1e-9 ? ` · ${qtyText(r3(t.max - total))} ${t.unit} stays without a sticker` : ''}`
                        : `Up to ${qtyText(t.max)} ${t.unit}.`}
                    </span>
                    <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
                      <input type="checkbox" checked={r.remember} onChange={(e) => edit(t.key, { remember: e.target.checked, rememberSet: true }, false)} />
                      Remember for {t.item.length > 28 ? 'this item' : t.item}
                    </label>
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
