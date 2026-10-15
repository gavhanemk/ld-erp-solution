'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Loader2, Printer, Tags } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { StepInput } from '@/components/ui/StepInput'
import { openPrintTab, packCount, printOutward, qtyText, type OutwardRef } from './packageTypes'

interface Spot {
  key: string
  item: string
  itemCode: string
  unit: string
  store: string
  over: number
  packages: Array<{ id: string; code: string; qty: number; lotNo: string | null; packType: string; take: number }>
}

interface Plan {
  number: string
  to: string
  /** The stock only moved to another store, so whole rolls go with it. */
  moves: boolean
  lines: Array<{ key: string; item: string; itemCode: string; qty: number; unit: string; from: string; owner: string | null }>
  spots: Spot[]
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * The labels after stock goes out, one card per item, in plain words.
 *
 * Each item that left gets one label to stick on it — the document number as
 * its QR, where it is going, how much. Under it, the rolls or boxes it came
 * off when it went out without a scan: the oldest first, worked out here. A
 * whole one used up needs nothing; a part-used one gets a fresh sticker for
 * what is left. "Not these? Change" is only for when that guess is wrong.
 */
export function OutwardStickers({ source, onClose, onDone }: { source: OutwardRef; onClose: () => void; onDone: (message: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [takes, setTakes] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .post<{ data: Plan }>('/packages/outward/plan', { type: source.type, id: source.id, q: source.q ?? null })
      .then((res) => {
        if (!live) return
        if (!res.data.lines.length) return onClose()
        setPlan(res.data)
        setTakes(Object.fromEntries(res.data.spots.flatMap((s) => s.packages.map((p) => [p.id, p.take > 0 ? String(p.take) : '']))))
      })
      // The document is saved either way; no labels is not worth an error over it.
      .catch(() => live && onClose())
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.type, source.id, source.q])

  const chosen = useMemo(
    () => (plan?.spots ?? []).flatMap((s) => s.packages.map((p) => ({ s, p, qty: Number(takes[p.id]) || 0 })).filter((x) => x.qty > 0)),
    [plan, takes],
  )
  const problem = (plan?.spots ?? [])
    .map((s) => {
      const tooMuch = s.packages.find((p) => (Number(takes[p.id]) || 0) > p.qty + 1e-9)
      if (tooMuch) return `${tooMuch.code} has only ${qtyText(tooMuch.qty)} ${s.unit} in it.`
      const total = r3(s.packages.reduce((sum, p) => sum + (Number(takes[p.id]) || 0), 0))
      if (total > s.over + 1e-6) return `${s.item}: only ${qtyText(s.over)} ${s.unit} went out.`
      return null
    })
    .find(Boolean)
  // A part-used package gets a fresh sticker for what is left in it; when the
  // stock only moved, the part that went is a new package with its own too.
  const fresh = chosen.reduce((n, { p, qty }) => n + (qty < p.qty - 1e-9 ? (plan?.moves ? 2 : 1) : 0), 0)
  const count = (plan?.lines.length ?? 0) + fresh

  /*
   * Not printing still brings the rolls and boxes in line: the stock has
   * already gone, so their stickers come down with it now, not on some later
   * issue. Closing the window any way does the same.
   */
  const skip = async () => {
    if (!plan || saving) return
    if (!chosen.length || problem) return onClose()
    setSaving(true)
    try {
      await api.post('/packages/outward/apply', { type: source.type, id: source.id, q: source.q ?? null, takes: chosen.map(({ p, qty }) => ({ packageId: p.id, qty })) })
      onDone(`No labels printed. The stickers on ${plan.spots.map((s) => s.item).join(', ')} now match the stock.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the stickers.')
    } finally {
      setSaving(false)
    }
  }

  const print = async () => {
    if (!plan) return
    setSaving(true)
    setError(null)
    // Opened on the click itself: a tab opened after the save is blocked as a pop-up.
    const tab = openPrintTab()
    try {
      let reprint: string[] = []
      if (chosen.length) {
        const res = await api.post<{ data: { reprint: string[] } }>('/packages/outward/apply', {
          type: source.type,
          id: source.id,
          q: source.q ?? null,
          takes: chosen.map(({ p, qty }) => ({ packageId: p.id, qty })),
        })
        reprint = res.data.reprint
      }
      printOutward(source, reprint, tab)
      onDone(`Stickers for ${plan.number} have opened in a new tab: press Print there.`)
    } catch (err) {
      tab?.close()
      setError(err instanceof ApiError ? err.message : 'Could not print. Is the API running?')
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

  /** What a package is, said once: "roll", "box". */
  const kind = (t: string) => packCount(1, t).replace(/^1 /, '')

  /** What happens to one package, in words a store keeper uses. */
  const fate = (s: Spot, p: Spot['packages'][number]) => {
    const take = Number(takes[p.id]) || 0
    const left = r3(p.qty - take)
    if (take <= 0) return null
    const what = `${kind(p.packType)} of ${qtyText(p.qty)} ${s.unit}${p.lotNo ? `, lot ${p.lotNo}` : ''}`
    if (left <= 0) {
      return { text: plan.moves ? `The whole ${what} goes, with its own sticker.` : `The whole ${what} — used up, nothing to print.`, fresh: false, code: p.code }
    }
    return {
      text: plan.moves
        ? `${qtyText(take)} ${s.unit} of the ${what} goes on a new sticker; ${qtyText(left)} ${s.unit} stays.`
        : `${qtyText(take)} ${s.unit} taken off the ${what}; ${qtyText(left)} ${s.unit} left on it.`,
      fresh: true,
      code: p.code,
    }
  }

  // Each item once: what went, its label, and which rolls or boxes it came off.
  const used = new Set<string>()
  const cards = plan.lines.map((l) => {
    const spot = plan.spots.find((s) => !used.has(s.key) && s.itemCode === l.itemCode && s.store === l.from)
    if (spot) used.add(spot.key)
    return { l, spot }
  })
  const loose = plan.spots.filter((s) => !used.has(s.key))
  const verb = plan.moves ? 'moved' : 'issued'

  /** `went`: how much this document sent, when the stickers are behind by more than that. */
  const spotBlock = (s: Spot, went?: number) => {
    const fates = s.packages.map((p) => fate(s, p)).filter((f): f is NonNullable<ReturnType<typeof fate>> => !!f)
    return (
      <div className="border-border mt-2.5 border-t pt-2.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">Taken from</p>
          <button type="button" className="text-primary text-xs font-medium hover:underline" onClick={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))}>
            {open[s.key] ? 'Done' : 'Not these? Change'}
          </button>
        </div>
        {/* The stickers can be behind by more than this one issue: earlier stock went out with its labels skipped. Said, so the sum is not a surprise. */}
        {went != null && s.over > went + 1e-6 && (
          <p className="warn-text mt-1 text-xs">
            {qtyText(s.over)} {s.unit} has left {s.store} without its stickers being updated: {qtyText(went)} {s.unit} now, the rest on earlier issues whose labels were skipped. Taking it off these {packCount(2, s.packages[0]?.packType ?? 'OTHER').replace(/^2 /, '')} puts the stickers back in line with the stock.
          </p>
        )}
        {!open[s.key] ? (
          <ul className="mt-1 space-y-1 text-sm">
            {fates.length ? (
              fates.map((f) => (
                <li key={f.code} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-foreground">{f.text}</span>
                  {f.fresh && <span className="badge-info">+1 fresh sticker</span>}
                  <span className="text-muted-foreground font-mono text-[11px]">{f.code}</span>
                </li>
              ))
            ) : (
              <li className="warn-text text-xs">None picked. Say which {kind(s.packages[0]?.packType ?? 'OTHER')} it came off, or the stickers will not match the stock.</li>
            )}
          </ul>
        ) : (
          <div className="mt-2 space-y-1.5">
            <p className="text-muted-foreground text-xs">
              {qtyText(s.over)} {s.unit} went out of {s.store}. Type how much came off each:
            </p>
            {s.packages.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-foreground w-48 text-xs">
                  {kind(p.packType)} of {qtyText(p.qty)} {s.unit}
                  {p.lotNo ? `, lot ${p.lotNo}` : ''} <span className="text-muted-foreground font-mono">{p.code}</span>
                </span>
                <div className="relative w-32">
                  <StepInput
                    className="form-input h-9 pr-10"
                    value={takes[p.id] ?? ''}
                    onValueChange={(v) => setTakes((t) => ({ ...t, [p.id]: v }))}
                    decimals
                    max={p.qty}
                    aria-label={`Taken off ${p.code}`}
                  />
                  <span className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs">{s.unit}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <FormFrame
      icon={Tags}
      title={`Labels for ${plan.number}`}
      subtitle={`${plan.lines.length} ${plan.lines.length === 1 ? 'item' : 'items'} ${verb} to ${plan.to}. The stock is already updated; these labels only mark the goods.`}
      onClose={() => void skip()}
      busy={saving}
      error={error}
      width="max-w-2xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void print()} disabled={saving || Boolean(problem)}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />}
          Print {count} {count === 1 ? 'label' : 'labels'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={() => void skip()} disabled={saving}>
          Not now
        </button>
      }
      footerNote={
        problem ? (
          <span className="warn-text">{problem}</span>
        ) : (
          `${count} to print: one for each item that went${fresh ? `, and ${fresh} fresh for what is left on part-used ${fresh === 1 ? 'roll or box' : 'rolls or boxes'}` : ''}.`
        )
      }
    >
      <div className="space-y-2.5">
        {cards.map(({ l, spot }) => (
          <div key={l.key} className="border-border bg-card rounded-xl border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-foreground text-sm font-semibold">{l.item}</span>
              <span className="text-foreground flex items-center gap-1 text-sm tabular-nums">
                {qtyText(l.qty)} {l.unit}
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  · {l.from} <ArrowRight size={11} /> {plan.to}
                </span>
              </span>
            </div>
            <p className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-sm">
              <Tags size={14} className="text-primary shrink-0" />
              <span>
                <span className="text-foreground">1 label</span> to stick on what goes, with {plan.number} and {plan.to} on it
              </span>
            </p>
            {spot && spotBlock(spot, l.qty)}
          </div>
        ))}
        {loose.map((s) => (
          <div key={s.key} className="border-border bg-card rounded-xl border p-3">
            <p className="text-foreground text-sm font-semibold">{s.item}</p>
            {spotBlock(s)}
          </div>
        ))}
      </div>
    </FormFrame>
  )
}
