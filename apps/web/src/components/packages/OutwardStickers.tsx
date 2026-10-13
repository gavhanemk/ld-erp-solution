'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Loader2, PackageOpen, Printer, Tags } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { StepInput } from '@/components/ui/StepInput'
import { openPrintTab, packLabel, printOutward, qtyText, type OutwardRef } from './packageTypes'

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
 * What prints after stock goes out: a label for each line that left — the
 * document number as its QR, who it went to, how much — and, where it came out
 * of stickered rolls or boxes without being scanned, the packages it came
 * from, so they can be brought down to what is really left in them and get a
 * fresh sticker. The oldest packages are suggested first; any can be changed.
 */
export function OutwardStickers({ source, onClose, onDone }: { source: OutwardRef; onClose: () => void; onDone: (message: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [takes, setTakes] = useState<Record<string, string>>({})
  const [labels, setLabels] = useState(true)
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
    () =>
      (plan?.spots ?? []).flatMap((s) =>
        s.packages.map((p) => ({ s, p, qty: Number(takes[p.id]) || 0 })).filter((x) => x.qty > 0),
      ),
    [plan, takes],
  )
  const problem = (plan?.spots ?? [])
    .map((s) => {
      const total = r3(s.packages.reduce((sum, p) => sum + (Number(takes[p.id]) || 0), 0))
      const tooMuch = s.packages.find((p) => (Number(takes[p.id]) || 0) > p.qty + 1e-9)
      if (tooMuch) return `${tooMuch.code} has only ${qtyText(tooMuch.qty)} ${s.unit} in it.`
      if (total > s.over + 1e-6) return `${s.item}: only ${qtyText(s.over)} ${s.unit} went out without a scan.`
      return null
    })
    .find(Boolean)
  // What gets a fresh sticker: a package part used, for what is left in it —
  // and when the stock only moved, the new package that went as well. A whole
  // package that moved keeps the sticker it has.
  const fresh = chosen.reduce((n, { p, qty }) => n + (qty < p.qty - 1e-9 ? (plan?.moves ? 2 : 1) : 0), 0)
  const count = (labels ? (plan?.lines.length ?? 0) : 0) + fresh
  const blocker = problem ?? (count === 0 && !chosen.length ? 'Nothing to print. Tick the labels, or close.' : null)

  const print = async () => {
    if (!plan) return
    setSaving(true)
    setError(null)
    // Opened on the click itself: a tab opened after the save is blocked as a pop-up.
    const tab = count > 0 ? openPrintTab() : null
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
      if (labels || reprint.length) printOutward(labels ? source : null, reprint, tab)
      else tab?.close()
      onDone(
        [
          labels ? `${plan.lines.length} ${plan.lines.length === 1 ? 'label' : 'labels'} for ${plan.number}` : null,
          chosen.length ? `${chosen.length} ${chosen.length === 1 ? 'package' : 'packages'} brought up to date` : null,
        ]
          .filter(Boolean)
          .join('; ') + (count > 0 ? '. They have opened in a new tab for printing.' : '.'),
      )
    } catch (err) {
      tab?.close()
      setError(err instanceof ApiError ? err.message : 'Could not print. Is the API running?')
    } finally {
      setSaving(false)
    }
  }

  if (!plan) {
    return (
      <FormFrame icon={Tags} title="Labels" subtitle="Getting the labels ready…" onClose={onClose} primary={null} width="max-w-md">
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 size={16} className="animate-spin" /> Working out what went out…
        </div>
      </FormFrame>
    )
  }

  return (
    <FormFrame
      icon={Tags}
      title={`Labels for ${plan.number}`}
      subtitle={`What went out to ${plan.to}. Print a label to stick on it, and bring the rolls and boxes it came from up to date.`}
      onClose={onClose}
      busy={saving}
      error={error}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void print()} disabled={saving || Boolean(blocker)}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />}
          {count > 0 ? `Print ${count} ${count === 1 ? 'label' : 'labels'}` : 'Save'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Later
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : null}
    >
      <Section icon={Tags} title="Label for what goes out">
        <label className="mb-2 flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
          Print a label for each line, with {plan.number} as its QR
        </label>
        <div className="divide-border/60 divide-y">
          {plan.lines.map((l) => (
            <div key={l.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm">
              <span className="text-foreground min-w-0 flex-1 truncate font-medium">
                {l.item} <span className="text-muted-foreground font-mono text-xs font-normal">{l.itemCode}</span>
              </span>
              <span className="whitespace-nowrap font-semibold tabular-nums">
                {qtyText(l.qty)} {l.unit}
              </span>
              <span className="text-muted-foreground flex items-center gap-1 whitespace-nowrap text-xs">
                {l.from} <ArrowRight size={11} /> {plan.to}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {plan.spots.map((s) => (
        <Section key={s.key} icon={PackageOpen} title={`Which ${s.packages.length === 1 ? 'package' : 'packages'} did ${s.item} come from?`}>
          <p className="text-muted-foreground mb-2 text-xs">
            {qtyText(s.over)} {s.unit} left {s.store} without a scan, so the stickers there say more than is on the rack.{' '}
            {plan.moves
              ? 'A whole package moves with it; part of one becomes a new package there, with its own sticker.'
              : 'What is taken off a package is printed fresh with what is left in it.'}
          </p>
          <div className="space-y-1.5">
            {s.packages.map((p) => {
              const take = Number(takes[p.id]) || 0
              const left = r3(p.qty - take)
              return (
                <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="w-28 font-mono text-xs font-semibold">{p.code}</span>
                  <span className="text-muted-foreground w-40 truncate text-xs">
                    {packLabel(p.packType)} of {qtyText(p.qty)} {s.unit}
                    {p.lotNo ? ` · lot ${p.lotNo}` : ''}
                  </span>
                  <div className="relative w-32">
                    <StepInput
                      className="form-input h-9 pr-10"
                      value={takes[p.id] ?? ''}
                      onValueChange={(v) => setTakes((t) => ({ ...t, [p.id]: v }))}
                      decimals
                      max={p.qty}
                      aria-label={`Taken from ${p.code}`}
                    />
                    <span className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs">{s.unit}</span>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {take <= 0
                      ? 'untouched'
                      : left <= 0
                        ? plan.moves
                          ? `whole ${packLabel(p.packType).toLowerCase()} moves`
                          : 'used up'
                        : `${qtyText(left)} ${s.unit} left · fresh sticker`}
                  </span>
                </div>
              )
            })}
          </div>
        </Section>
      ))}
    </FormFrame>
  )
}
