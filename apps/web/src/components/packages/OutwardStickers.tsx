'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Loader2, PackageOpen, Printer, Tags } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { StepInput } from '@/components/ui/StepInput'
import { openPrintTab, printOutward, qtyText, type OutwardRef } from './packageTypes'

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
 * The stickers after stock goes out, as sentences to check and print.
 *
 * One label for each line that left — the document number as its QR, where it
 * is going, how much. And where it came out of stickered rolls or boxes
 * without a scan, which ones it was taken off: the oldest first, worked out
 * here, with a fresh sticker for what is left in them. "Change" is only for
 * when that guess is wrong.
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

  /** What happens to one package, in words. */
  const fate = (s: Spot, p: Spot['packages'][number]) => {
    const take = Number(takes[p.id]) || 0
    const left = r3(p.qty - take)
    if (take <= 0) return null
    if (left <= 0) return plan.moves ? `${p.code} goes whole to ${plan.to}` : `${p.code} is used up`
    return plan.moves
      ? `${qtyText(take)} ${s.unit} from ${p.code} goes as a new sticker; ${qtyText(left)} ${s.unit} stays, fresh sticker`
      : `${qtyText(take)} ${s.unit} taken off ${p.code}; ${qtyText(left)} ${s.unit} left, fresh sticker`
  }

  return (
    <FormFrame
      icon={Tags}
      title={`Stickers for ${plan.number}`}
      subtitle="Check the lines below and press Print."
      onClose={onClose}
      busy={saving}
      error={error}
      width="max-w-2xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void print()} disabled={saving || Boolean(problem)}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />}
          Print {count} {count === 1 ? 'sticker' : 'stickers'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Skip
        </button>
      }
      footerNote={problem ? <span className="warn-text">{problem}</span> : null}
    >
      <div className="space-y-2.5">
        {plan.lines.map((l) => (
          <div key={l.key} className="border-border bg-card rounded-xl border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-foreground text-sm font-semibold">
                {l.item} <span className="text-muted-foreground font-mono text-xs font-normal">{l.itemCode}</span>
              </span>
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                {qtyText(l.qty)} {l.unit} · {l.from} <ArrowRight size={11} /> {plan.to}
              </span>
            </div>
            <p className="text-foreground mt-2 flex items-center gap-1.5 text-sm">
              <Tags size={14} className="text-primary shrink-0" />
              1 sticker for what goes out, with {plan.number} on it
            </p>
          </div>
        ))}

        {plan.spots.map((s) => {
          const lines = s.packages.map((p) => fate(s, p)).filter(Boolean)
          return (
            <div key={s.key} className="border-border bg-card rounded-xl border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <p className="text-foreground flex items-center gap-1.5 font-medium">
                    <PackageOpen size={14} className="text-primary shrink-0" />
                    {s.item}: taken from these stickered {s.packages[0]?.packType === 'ROLL' ? 'rolls' : 'packages'}
                  </p>
                  <ul className="text-muted-foreground mt-1 space-y-0.5 pl-5 text-xs">
                    {lines.length ? lines.map((t) => <li key={t}>{t}</li>) : <li>None — the stickers will not match the stock until it is fixed.</li>}
                  </ul>
                </div>
                <button type="button" className="text-primary text-sm font-medium hover:underline" onClick={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))}>
                  {open[s.key] ? 'Done' : 'Change'}
                </button>
              </div>
              {open[s.key] && (
                <div className="border-border mt-3 space-y-1.5 border-t pt-3">
                  <p className="text-muted-foreground mb-1 text-xs">
                    {qtyText(s.over)} {s.unit} went out of {s.store}. Say how much came off each:
                  </p>
                  {s.packages.map((p) => (
                    <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="w-24 font-mono text-xs font-semibold">{p.code}</span>
                      <span className="text-muted-foreground w-32 text-xs">
                        has {qtyText(p.qty)} {s.unit}
                        {p.lotNo ? ` · lot ${p.lotNo}` : ''}
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
        })}
      </div>
    </FormFrame>
  )
}
