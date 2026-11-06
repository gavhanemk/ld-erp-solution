'use client'

import { useMemo, useState } from 'react'
import { ArrowLeftRight, ArrowRight, Loader2, Plus, Shirt, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { bundleRows } from './useFlow'
import { bundleShort, newClientKey, pcs, revisedQty, type FlowStep, type JobCardDetail } from './types'

/**
 * A size jump at stitching, said the way the floor says it: "5 pieces cut as
 * 40 were made as 38". The pieces are taken from that size's bundles here,
 * oldest first (or the bundles picked), and each bundle's go into a new bundle
 * of the new size with its own sticker; the old bundle keeps its history. The
 * order's planned sizes stay as they are, and nothing goes into stock until
 * the pieces are packed into finished goods in their new size.
 */

interface Change {
  key: number
  from: string
  to: string
  qty: string
  /** Bundles picked by hand, with the pieces from each; null takes them oldest first. */
  pick: Record<string, string> | null
}

let seq = 0
const blank = (): Change => ({ key: ++seq, from: '', to: '', qty: '', pick: null })
const n = (v: string | undefined) => Number(v) || 0

export function SizeChangeDialog({
  d,
  step,
  onClose,
  onSaved,
}: {
  d: JobCardDetail
  step: FlowStep
  onClose: () => void
  onSaved: (message: string, bundleIds: string[]) => void
}) {
  const sizes = useMemo(() => d.line?.sizes ?? [], [d.line])
  // The card's bundles with pieces in hand here or done and waiting, oldest first.
  const bundles = useMemo(() => {
    const own = d.line ? d.bundles.filter((b) => b.line?.id === d.line!.id) : d.bundles
    const sizeOf = new Map(own.map((b) => [b.id, b.size?.id ?? null]))
    return bundleRows(own, { stepId: step.id, bucket: ['WIP', 'DONE'] }).map((r) => ({ ...r, sizeId: sizeOf.get(r.id) ?? null }))
  }, [d.bundles, d.line, step.id])
  const hereOf = (sizeId: string) => bundles.filter((b) => b.sizeId === sizeId).reduce((s, b) => s + b.available, 0)
  const code = (sizeId: string) => sizes.find((z) => z.id === sizeId)?.code ?? '—'
  const here = bundles.reduce((s, b) => s + b.available, 0)

  const [changes, setChanges] = useState<Change[]>(() => [blank()])
  const [reason, setReason] = useState('')
  const [personName, setPersonName] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)
  const set = (key: number, patch: Partial<Change>) => setChanges((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)))

  // Which bundles each change takes its pieces from: those picked, or the
  // oldest of its size first — never the same pieces for two changes.
  const plan = useMemo(() => {
    const left = new Map(bundles.map((b) => [b.id, b.available]))
    return changes.map((c) => {
      const mine = bundles.filter((b) => b.sizeId === c.from)
      const want = c.pick ? Object.values(c.pick).reduce((s, v) => s + n(v), 0) : n(c.qty)
      const takes: Array<{ bundleId: string; code: string; qty: number }> = []
      if (c.pick) {
        for (const b of mine) {
          const q = Math.min(n(c.pick[b.id]), left.get(b.id) ?? 0)
          if (q > 0) {
            takes.push({ bundleId: b.id, code: b.code, qty: q })
            left.set(b.id, (left.get(b.id) ?? 0) - q)
          }
        }
      } else {
        let need = want
        for (const b of mine) {
          if (need <= 0) break
          const q = Math.min(need, left.get(b.id) ?? 0)
          if (q > 0) {
            takes.push({ bundleId: b.id, code: b.code, qty: q })
            left.set(b.id, (left.get(b.id) ?? 0) - q)
            need -= q
          }
        }
      }
      const got = takes.reduce((s, t) => s + t.qty, 0)
      return { change: c, want, takes, got }
    })
  }, [changes, bundles])

  const filled = plan.filter((p) => p.change.from || p.change.to || p.want > 0)
  const problem = (() => {
    if (!here) return `Nothing is in hand or done at ${step.name} on this job card.`
    if (!filled.length) return 'Say which size, made as which size, and how many pieces.'
    for (const p of filled) {
      if (!p.change.from) return 'Pick the size the pieces were cut as.'
      if (!p.change.to) return `Pick the size the ${code(p.change.from)} pieces are made as.`
      if (p.want <= 0) return `Enter how many pieces of ${code(p.change.from)} are made as ${code(p.change.to)}.`
      if (p.got < p.want) return `Only ${pcs(p.got)} pcs of ${code(p.change.from)} are here for this change.`
    }
    if (reason.trim().length < 5) return 'Give the reason, in a few words.'
    return null
  })()

  const moved = (sizeId: string) => filled.reduce((s, p) => s + (p.change.to === sizeId ? p.got : 0) - (p.change.from === sizeId ? p.got : 0), 0)
  const total = filled.reduce((s, p) => s + p.got, 0)
  const newBundles = filled.reduce((s, p) => s + p.takes.length, 0)
  const anyEarlier = sizes.some((z) => (z.changed ?? 0) !== 0)

  const save = async () => {
    if (problem) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { eventId: string; bundleIds: string[] } }>(`/production/orders/${d.mo.id}/size-changes`, {
        stepId: step.id,
        lines: filled.flatMap((p) => p.takes.map((t) => ({ bundleId: t.bundleId, toSizeId: p.change.to, qty: t.qty }))),
        reason: reason.trim(),
        personName: personName.trim() || null,
        eventDate: date,
        notes: notes.trim() || null,
        clientKey,
      })
      onSaved(res.message ?? 'Sizes changed.', res.data?.bundleIds ?? [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the sizes.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={ArrowLeftRight}
      title={`Change sizes at ${step.name}`}
      subtitle={`${d.card.jobCardNumber} · ${d.line?.style.code ?? ''} ${d.line?.color ?? ''} · ${pcs(here)} pcs here`}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!problem}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <ArrowLeftRight size={15} />} Change sizes
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        problem ? (
          <span className="warn-text">{problem}</span>
        ) : (
          `${pcs(total)} pcs into ${newBundles} new ${newBundles === 1 ? 'bundle' : 'bundles'}. Their stickers print when you save.`
        )
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Shirt} title="Pieces made as another size">
        <p className="text-muted-foreground mb-3 text-xs">
          For pieces cut in one size and stitched as another. Each bundle&apos;s changed pieces become a new bundle with its own sticker.
        </p>
        <div className="space-y-3">
          {plan.map(({ change: c, takes, got, want }, i) => (
            <div key={c.key} className="border-border rounded-lg border p-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="block w-40">
                  <span className="form-label">Cut as</span>
                  <SmartSelect
                    className="form-input"
                    value={c.from}
                    onChange={(e) => set(c.key, { from: e.target.value, to: c.to === e.target.value ? '' : c.to, pick: null })}
                    aria-label={`Change ${i + 1}: size cut as`}
                  >
                    <option value="">Size…</option>
                    {sizes
                      .filter((z) => hereOf(z.id) > 0)
                      .map((z) => (
                        <option key={z.id} value={z.id} data-sub={`${pcs(hereOf(z.id))} pcs here`}>
                          {z.code}
                        </option>
                      ))}
                  </SmartSelect>
                </label>
                <ArrowRight size={16} className="text-muted-foreground mb-2.5 shrink-0" aria-hidden />
                <label className="block w-40">
                  <span className="form-label">Made as</span>
                  <SmartSelect className="form-input" value={c.to} onChange={(e) => set(c.key, { to: e.target.value })} aria-label={`Change ${i + 1}: size made as`}>
                    <option value="">Size…</option>
                    {sizes
                      .filter((z) => z.id !== c.from)
                      .map((z) => (
                        <option key={z.id} value={z.id}>
                          {z.code}
                        </option>
                      ))}
                  </SmartSelect>
                </label>
                <label className="block w-28">
                  <span className="form-label">Pieces</span>
                  {c.pick ? (
                    <span className="form-input bg-secondary/40 flex items-center justify-end tabular-nums">{pcs(want)}</span>
                  ) : (
                    <StepInput
                      className="form-input text-right tabular-nums"
                      value={c.qty}
                      max={c.from ? hereOf(c.from) : undefined}
                      placeholder="0"
                      onValueChange={(v) => set(c.key, { qty: v })}
                      aria-label={`Change ${i + 1}: pieces`}
                    />
                  )}
                </label>
                {changes.length > 1 && (
                  <button
                    type="button"
                    className="btn-ghost text-muted-foreground hover:text-destructive mb-1 p-2"
                    onClick={() => setChanges((cs) => cs.filter((x) => x.key !== c.key))}
                    aria-label={`Remove change ${i + 1}`}
                    title="Remove this change"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>

              {c.from && (
                <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {!c.pick ? (
                    <>
                      <span>
                        {takes.length
                          ? `From ${takes.map((t) => `${bundleShort(t.code)} (${pcs(t.qty)})`).join(', ')}, oldest bundles first`
                          : `${pcs(hereOf(c.from))} pcs of ${code(c.from)} here, in ${bundles.filter((b) => b.sizeId === c.from).length} bundles`}
                      </span>
                      <button type="button" className="text-primary font-medium hover:underline" onClick={() => set(c.key, { pick: Object.fromEntries(takes.map((t) => [t.bundleId, String(t.qty)])) })}>
                        Choose bundles
                      </button>
                    </>
                  ) : (
                    <div className="w-full">
                      <div className="flex flex-wrap gap-2">
                        {bundles
                          .filter((b) => b.sizeId === c.from)
                          .map((b) => (
                            <label key={b.id} className="border-border bg-card flex items-center gap-2 rounded-md border px-2 py-1">
                              <span className="text-foreground font-mono text-xs">{bundleShort(b.code)}</span>
                              <span className="text-[11px]">of {pcs(b.available)}</span>
                              <StepInput
                                className="form-input h-7 w-16 text-right text-xs tabular-nums"
                                value={c.pick?.[b.id] ?? ''}
                                max={b.available}
                                placeholder="0"
                                onValueChange={(v) => set(c.key, { pick: { ...(c.pick ?? {}), [b.id]: v } })}
                                aria-label={`${b.code} pieces made as another size`}
                              />
                            </label>
                          ))}
                      </div>
                      <button type="button" className="text-primary mt-1.5 font-medium hover:underline" onClick={() => set(c.key, { pick: null, qty: String(got || '') })}>
                        Take the oldest bundles first instead
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="btn-secondary mt-3 h-8 px-3 text-xs" onClick={() => setChanges((cs) => [...cs, blank()])}>
          <Plus size={13} /> Another size
        </button>
      </Section>

      <Section icon={ArrowLeftRight} title="Sizes after this change">
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="data-table w-full">
            <thead>
              <tr className="bg-secondary">
                <th>Size</th>
                <th style={{ textAlign: 'right' }}>Planned</th>
                {anyEarlier && <th style={{ textAlign: 'right' }}>Now</th>}
                <th style={{ textAlign: 'right' }}>After this</th>
                <th style={{ textAlign: 'right' }}>Change</th>
              </tr>
            </thead>
            <tbody>
              {sizes.map((z) => {
                const now = revisedQty(z)
                const m = moved(z.id)
                const after = Math.max(0, now + m)
                return (
                  <tr key={z.id}>
                    <td className="text-sm font-semibold">{z.code}</td>
                    <td className="text-muted-foreground text-right text-sm tabular-nums">{pcs(z.qty)}</td>
                    {anyEarlier && <td className="text-muted-foreground text-right text-sm tabular-nums">{pcs(now)}</td>}
                    <td className={`text-right text-sm tabular-nums ${m ? 'text-foreground font-semibold' : ''}`}>{pcs(after)}</td>
                    <td className={`text-right text-sm tabular-nums ${m > 0 ? 'text-emerald-600' : m < 0 ? 'warn-text' : 'text-muted-foreground'}`}>
                      {m > 0 ? `+${pcs(m)}` : m < 0 ? `−${pcs(-m)}` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="bg-secondary">
                <td className="text-xs font-medium">Total</td>
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(sizes.reduce((s, z) => s + z.qty, 0))}</td>
                {anyEarlier && <td className="text-right text-xs font-semibold tabular-nums">{pcs(sizes.reduce((s, z) => s + revisedQty(z), 0))}</td>}
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(sizes.reduce((s, z) => s + Math.max(0, revisedQty(z) + moved(z.id)), 0))}</td>
                <td className="text-muted-foreground text-right text-xs tabular-nums">—</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">The order&apos;s planned sizes stay as they are. Finished goods are booked in the sizes made.</p>
      </Section>

      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="form-label">
            Reason <span className="text-destructive">*</span>
          </span>
          <input className="form-input" value={reason} maxLength={500} placeholder="e.g. measured small after stitching" onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="block">
          <span className="form-label">Done by</span>
          <input className="form-input" value={personName} maxLength={120} placeholder="Line or supervisor" onChange={(e) => setPersonName(e.target.value)} />
        </label>
        <label className="block">
          <span className="form-label">Date</span>
          <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block sm:col-span-2 lg:col-span-4">
          <span className="form-label">Note</span>
          <input className="form-input" value={notes} maxLength={1000} placeholder="Optional" onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </FormFrame>
  )
}
