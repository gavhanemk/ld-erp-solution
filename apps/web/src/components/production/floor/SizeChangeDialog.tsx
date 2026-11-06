'use client'

import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Loader2, Plus, Scale, Shirt, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { bundleRows } from './useFlow'
import { bundleShort, newClientKey, pcs, revisedQty, type FlowStep, type JobCardDetail } from './types'

/**
 * A size jump at stitching, size by size: "of the 30 pieces cut as 40 here, 25
 * are made as 38 and 5 stay 40". Each size shows what was cut, what is here,
 * what earlier changes took, what this change takes and what is left, and the
 * end shows every size before and after, so nobody adds anything up in their
 * head.
 *
 * Pieces change size once, from the size they were cut in: bundles made by an
 * earlier change, and pieces an outside unit stitched, are not offered. The
 * pieces of a size are taken from the bundles picked, or else its oldest
 * bundles first; each bundle's changed pieces become a new bundle with its own
 * sticker. The order's planned sizes stay as they are, and nothing goes into
 * stock until the pieces are packed in their new size.
 */

interface Target {
  key: number
  from: string
  to: string
  qty: string
  /** Bundles picked by hand, with the pieces from each; null takes them oldest first. */
  pick: Record<string, string> | null
}

let seq = 0
const num = (v: string | undefined) => Number(v) || 0
const signed = (v: number) => (v > 0 ? `+${pcs(v)}` : v < 0 ? `−${pcs(-v)}` : '—')
const tone = (v: number) => (v > 0 ? 'text-emerald-600' : v < 0 ? 'warn-text' : 'text-muted-foreground')
const dot = (cls: string) => <span className={`inline-block h-2 w-2 rounded-full ${cls}`} aria-hidden />

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
  const code = (sizeId: string) => sizes.find((z) => z.id === sizeId)?.code ?? '—'

  // What is at this step: pieces still in the size they were cut in (these may change size), pieces
  // an earlier change already made as another size, and pieces an outside unit stitched.
  const floor = useMemo(() => {
    const own = d.line ? d.bundles.filter((b) => b.line?.id === d.line!.id) : d.bundles
    const byId = new Map(own.map((b) => [b.id, b]))
    const viaUnit = new Set(
      d.transfers.filter((t) => t.toStep.id === step.id && t.vendor && t.status !== 'CANCELLED').flatMap((t) => t.lines.map((l) => l.bundle.id)),
    )
    const rows = bundleRows(own, { stepId: step.id, bucket: ['WIP', 'DONE'] }).map((r) => ({ ...r, sizeId: byId.get(r.id)?.size?.id ?? null, parent: byId.get(r.id)?.parent ?? null }))
    return {
      own,
      cut: rows.filter((r) => !r.parent && !viaUnit.has(r.id)),
      madeEarlier: rows.filter((r) => r.parent),
      outside: rows.filter((r) => !r.parent && viaUnit.has(r.id)),
      total: rows.reduce((s, r) => s + r.available, 0),
    }
  }, [d.bundles, d.line, d.transfers, step.id])
  const hereOf = (sizeId: string) => floor.cut.filter((r) => r.sizeId === sizeId).reduce((s, r) => s + r.available, 0)
  const cutOf = (sizeId: string) => floor.own.filter((b) => !b.parent && !b.cancelled && b.size?.id === sizeId).reduce((s, b) => s + b.qty, 0)
  const earlier = useMemo(() => (d.sizeChanges ?? []).filter((c) => c.step.id === step.id && !c.undone), [d.sizeChanges, step.id])
  const earlierOut = (sizeId: string) => earlier.reduce((s, c) => s + c.moves.filter((m) => m.from.sizeId === sizeId).reduce((t, m) => t + m.qty, 0), 0)

  const [targets, setTargets] = useState<Target[]>([])
  const [added, setAdded] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [personName, setPersonName] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)
  const reasonRef = useRef<HTMLInputElement>(null)
  const set = (key: number, patch: Partial<Target>) => setTargets((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)))
  // With two sizes on the line, the other one is the only size the pieces can be made as.
  const add = (from: string) => {
    const others = sizes.filter((z) => z.id !== from)
    const key = ++seq
    setTargets((ts) => [...ts, { key, from, to: others.length === 1 ? others[0].id : '', qty: '', pick: null }])
    setAdded(key)
  }

  // Which bundles each line takes its pieces from, never the same pieces for two lines: the bundles
  // picked by hand first, then the oldest of the size for the rest.
  const plan = useMemo(() => {
    const left = new Map(floor.cut.map((b) => [b.id, b.available]))
    const take = (t: Target) => {
      const want = t.pick ? Object.values(t.pick).reduce((s, v) => s + num(v), 0) : num(t.qty)
      const takes: Array<{ bundleId: string; code: string; qty: number }> = []
      let need = want
      for (const b of floor.cut.filter((x) => x.sizeId === t.from)) {
        const q = Math.min(t.pick ? num(t.pick[b.id]) : need, left.get(b.id) ?? 0)
        if (q <= 0) continue
        takes.push({ bundleId: b.id, code: b.code, qty: q })
        left.set(b.id, (left.get(b.id) ?? 0) - q)
        need -= q
        if (!t.pick && need <= 0) break
      }
      return { t, want, takes, got: takes.reduce((s, x) => s + x.qty, 0) }
    }
    const picked = new Map(targets.filter((t) => t.pick).map((t) => [t.key, take(t)]))
    return targets.map((t) => picked.get(t.key) ?? take(t))
  }, [targets, floor.cut])

  const askedFrom = (sizeId: string) => plan.filter((p) => p.t.from === sizeId).reduce((s, p) => s + p.want, 0)
  const outNow = (sizeId: string) => plan.filter((p) => p.t.from === sizeId && p.t.to).reduce((s, p) => s + p.got, 0)
  const inNow = (sizeId: string) => plan.filter((p) => p.t.to === sizeId).reduce((s, p) => s + p.got, 0)
  const changing = sizes.reduce((s, z) => s + Math.min(askedFrom(z.id), hereOf(z.id)), 0)
  const planned = sizes.reduce((s, z) => s + z.qty, 0)
  const finalOf = (z: (typeof sizes)[number]) => Math.max(0, revisedQty(z) + inNow(z.id) - outNow(z.id))
  const after = sizes.reduce((s, z) => s + finalOf(z), 0)
  const moving = plan.filter((p) => p.t.to).reduce((s, p) => s + p.got, 0)
  const newBundles = plan.filter((p) => p.t.to).reduce((s, p) => s + p.takes.length, 0)

  // What stops the save, each said where it is: on a line, on a size, at the reason.
  const lineIssue = (p: (typeof plan)[number]) =>
    !p.t.to
      ? 'Pick the size they are made as.'
      : p.want <= 0
        ? 'Enter how many pieces.'
        : p.t.pick && p.got < p.want
          ? `${pcs(p.want - p.got)} of the pieces picked are already taken by another line; pick them from other bundles.`
          : null
  const sizeIssue = (sizeId: string) => {
    const asked = askedFrom(sizeId)
    const here = hereOf(sizeId)
    return asked > here ? `Only ${pcs(here)} pcs of size ${code(sizeId)} are here; ${pcs(asked)} asked.` : null
  }
  const reasonIssue = reason.trim().length < 5 ? 'Write the reason, in a few words.' : null
  const issues = [
    ...(targets.length ? [] : [{ anchor: 'sizes', message: 'Pick a size below and say how many of its pieces were made as another size.' }]),
    ...plan.flatMap((p) => (lineIssue(p) ? [{ anchor: `line-${p.t.key}`, message: `Size ${code(p.t.from)}: ${lineIssue(p)!.charAt(0).toLowerCase()}${lineIssue(p)!.slice(1)}` }] : [])),
    ...sizes.flatMap((z) => (sizeIssue(z.id) ? [{ anchor: `size-${z.id}`, message: sizeIssue(z.id)! }] : [])),
    ...(reasonIssue ? [{ anchor: 'reason', message: reasonIssue }] : []),
  ]

  const save = async () => {
    if (issues.length) {
      setTried(true)
      const first = issues[0]
      document.getElementById(`sc-${first.anchor}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (first.anchor === 'reason') reasonRef.current?.focus({ preventScroll: true })
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { eventId: string; bundleIds: string[] } }>(`/production/orders/${d.mo.id}/size-changes`, {
        stepId: step.id,
        lines: plan.flatMap((p) => p.takes.map((x) => ({ bundleId: x.bundleId, toSizeId: p.t.to, qty: x.qty }))),
        reason: reason.trim(),
        personName: personName.trim() || null,
        eventDate: date,
        notes: notes.trim() || null,
        clientKey,
      })
      onSaved(res.message ?? 'Sizes changed.', res.data?.bundleIds ?? [])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the size changes. Nothing was changed; try again.')
    } finally {
      setSaving(false)
    }
  }

  const sizesHere = sizes.filter((z) => hereOf(z.id) > 0)
  const sizesNotHere = sizes.filter((z) => hereOf(z.id) === 0)
  const anyEarlier = sizes.some((z) => (z.changed ?? 0) !== 0)
  const tile = (label: string, value: string, sub: string, strong = false) => (
    <div className={`rounded-lg border px-3 py-2 ${strong ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'}`}>
      <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${strong ? 'text-primary' : 'text-foreground'}`}>{value}</p>
      <p className="text-muted-foreground text-[11px]">{sub}</p>
    </div>
  )

  return (
    <FormFrame
      icon={ArrowLeftRight}
      title={`Change sizes at ${step.name}`}
      subtitle={`${d.card.jobCardNumber} · ${d.line?.style.code ?? ''} ${d.line?.color ?? ''}`}
      width="max-w-4xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <ArrowLeftRight size={15} />} {saving ? 'Saving…' : 'Save size changes'}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        tried && issues.length ? (
          <span className="warn-text">{issues[0].message}</span>
        ) : !issues.length ? (
          `${pcs(changing)} pcs change size into ${newBundles} new ${newBundles === 1 ? 'bundle' : 'bundles'}; the order stays ${pcs(after)} pcs. Stickers print after saving.`
        ) : (
          'Nothing changes until you save.'
        )
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {/* The whole picture first: what is here, what moves, what stays, and that the total holds. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tile(`At ${step.name} now`, `${pcs(floor.total)} pcs`, `of ${pcs(planned)} on the order`)}
        {tile('Changing size', `${pcs(changing)} pcs`, 'moved between sizes, not added', changing > 0)}
        {tile('Keeping their size', `${pcs(Math.max(0, floor.total - changing))} pcs`, `of the ${pcs(floor.total)} here`)}
        {tile('Order after this', `${pcs(after)} pcs`, after === planned ? 'same total as planned' : `planned ${pcs(planned)}`)}
      </div>

      <Section icon={Shirt} title={`Sizes at ${step.name}`}>
        <p id="sc-sizes" className="text-muted-foreground mb-3 text-xs">
          For pieces cut in one size and stitched as another. Under the size they were cut in, say what they were made as. Each bundle&apos;s changed pieces become
          a new bundle with its own sticker.
        </p>
        {tried && !targets.length && (
          <p className="warn-text mb-3 flex items-center gap-1.5 text-xs">
            <AlertTriangle size={13} /> Pick a size below and say how many of its pieces were made as another size.
          </p>
        )}
        {!sizesHere.length && <p className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">No pieces here can change size now.</p>}
        <div className="space-y-3">
          {sizesHere.map((z) => {
            const here = hereOf(z.id)
            const cut = cutOf(z.id)
            const was = earlierOut(z.id)
            const asked = askedFrom(z.id)
            const now = Math.min(asked, here)
            const left = here - asked
            const away = Math.max(0, cut - was - here)
            const base = Math.max(cut, was + here) || 1
            const mine = plan.filter((p) => p.t.from === z.id)
            const over = sizeIssue(z.id)
            return (
              <div key={z.id} id={`sc-size-${z.id}`} className={`bg-card rounded-xl border p-4 ${over ? 'border-destructive/60' : mine.length ? 'border-primary/40' : 'border-border'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-foreground text-base font-semibold">Size {z.code}</p>
                    <p className="text-muted-foreground text-xs tabular-nums">
                      {pcs(cut)} cut as {z.code} · {pcs(here)} here at {step.name}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`text-xl font-semibold leading-tight tabular-nums ${left < 0 ? 'text-destructive' : 'text-foreground'}`}>{left < 0 ? `−${pcs(-left)}` : pcs(left)}</p>
                    <p className="text-muted-foreground text-[11px]">{left < 0 ? 'too many asked' : `left as size ${z.code}`}</p>
                  </div>
                </div>

                {/* What was cut in this size: made as other sizes earlier, changing now, left as it is, elsewhere. */}
                <div className="bg-secondary mt-3 flex h-2.5 overflow-hidden rounded-full" aria-hidden>
                  {was > 0 && <div className="bg-muted-foreground/40 h-full" style={{ width: `${(was / base) * 100}%` }} />}
                  {now > 0 && <div className="bg-primary h-full" style={{ width: `${(now / base) * 100}%` }} />}
                  {left > 0 && <div className="bg-primary/25 h-full" style={{ width: `${(left / base) * 100}%` }} />}
                </div>
                <div className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                  <span className="flex items-center gap-1.5">
                    {dot('bg-primary')} <span className={now ? 'text-primary font-medium' : ''}>{pcs(now)} changing now</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    {dot('bg-primary/25')} <span className="text-foreground">{pcs(Math.max(0, left))} stay size {z.code}</span>
                  </span>
                  {was > 0 && (
                    <span className="flex items-center gap-1.5">
                      {dot('bg-muted-foreground/40')} {pcs(was)} made as other sizes earlier
                    </span>
                  )}
                  {away > 0 && (
                    <span className="flex items-center gap-1.5">
                      {dot('bg-secondary border border-border')} {pcs(away)} not here now
                    </span>
                  )}
                </div>

                {mine.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {mine.map((p) => {
                      const issue = tried ? lineIssue(p) : null
                      const room = Math.max(0, here - mine.filter((x) => x.t.key !== p.t.key).reduce((s, x) => s + x.want, 0))
                      return (
                        <div key={p.t.key} id={`sc-line-${p.t.key}`} className={`bg-secondary/30 rounded-lg border p-3 ${issue ? 'border-destructive/60' : 'border-border'}`}>
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="block w-36">
                              <span className="form-label">Made as size</span>
                              <SmartSelect className="form-input" value={p.t.to} onChange={(e) => set(p.t.key, { to: e.target.value })} aria-label={`Size ${z.code} pieces made as`}>
                                <option value="">Pick…</option>
                                {sizes
                                  .filter((x) => x.id !== z.id)
                                  .map((x) => (
                                    <option key={x.id} value={x.id}>
                                      {x.code}
                                    </option>
                                  ))}
                              </SmartSelect>
                            </label>
                            <label className="block w-28">
                              <span className="form-label">Pieces</span>
                              {p.t.pick ? (
                                <span className="form-input flex items-center justify-end tabular-nums">{pcs(p.want)}</span>
                              ) : (
                                <StepInput
                                  className="form-input text-right tabular-nums"
                                  value={p.t.qty}
                                  max={room}
                                  placeholder="0"
                                  autoFocus={p.t.key === added && !!p.t.to}
                                  onValueChange={(v) => set(p.t.key, { qty: v })}
                                  aria-label={`Size ${z.code} pieces made as another size`}
                                />
                              )}
                            </label>
                            <p className="text-muted-foreground order-last mb-1 w-full text-xs sm:order-none sm:mb-2 sm:w-auto sm:min-w-0 sm:flex-1">
                              {p.t.to && p.got > 0 ? (
                                <>
                                  <span className={p.got < p.want ? 'text-destructive font-medium' : 'text-foreground font-medium'}>
                                    {p.got < p.want ? `Only ${pcs(p.got)} of these ${pcs(p.want)} are free: ` : ''}
                                    {pcs(p.got)} of size {z.code} → size {code(p.t.to)}
                                  </span>
                                  {' · from '}
                                  {p.takes.map((x) => `${bundleShort(x.code)} (${pcs(x.qty)})`).join(', ')}
                                </>
                              ) : (
                                `Up to ${pcs(room)} pcs`
                              )}
                            </p>
                            <button
                              type="button"
                              className="btn-ghost text-muted-foreground hover:text-destructive mb-1 ml-auto p-2 sm:ml-0"
                              onClick={() => setTargets((ts) => ts.filter((x) => x.key !== p.t.key))}
                              aria-label={`Remove this change of size ${z.code}`}
                              title="Remove"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                          {issue && <p className="text-destructive mt-1.5 text-xs">{issue}</p>}
                          {p.t.pick ? (
                            <div className="mt-2">
                              <div className="flex flex-wrap gap-2">
                                {floor.cut
                                  .filter((b) => b.sizeId === z.id)
                                  .map((b) => (
                                    <label key={b.id} className="border-border bg-card flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
                                      <span className="text-foreground font-mono">{bundleShort(b.code)}</span>
                                      <span className="text-muted-foreground">of {pcs(b.available)}</span>
                                      <StepInput
                                        className="form-input h-7 w-16 text-right text-xs tabular-nums"
                                        value={p.t.pick?.[b.id] ?? ''}
                                        max={b.available}
                                        placeholder="0"
                                        onValueChange={(v) => set(p.t.key, { pick: { ...(p.t.pick ?? {}), [b.id]: v } })}
                                        aria-label={`${b.code} pieces made as another size`}
                                      />
                                    </label>
                                  ))}
                              </div>
                              <button type="button" className="text-primary mt-1.5 text-xs font-medium hover:underline" onClick={() => set(p.t.key, { pick: null, qty: p.got ? String(p.got) : '' })}>
                                Take the oldest bundles first
                              </button>
                            </div>
                          ) : (
                            p.got > 0 && (
                              <button
                                type="button"
                                className="text-primary mt-1 text-xs font-medium hover:underline"
                                onClick={() => set(p.t.key, { pick: Object.fromEntries(p.takes.map((x) => [x.bundleId, String(x.qty)])) })}
                              >
                                Choose the bundles
                              </button>
                            )
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                {over && (
                  <p className="text-destructive mt-2 flex items-center gap-1.5 text-xs">
                    <AlertTriangle size={13} /> {over}
                  </p>
                )}
                {left > 0 && (
                  <button type="button" className="btn-secondary mt-3 h-8 px-3 text-xs" onClick={() => add(z.id)}>
                    <Plus size={13} /> {mine.length ? `Another size for the ${pcs(left)} left` : `Make some of size ${z.code} as another size`}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {(sizesNotHere.length > 0 || floor.madeEarlier.length > 0 || floor.outside.length > 0) && (
          <div className="text-muted-foreground mt-3 space-y-1 text-xs">
            {sizesNotHere.length > 0 && (
              <p>
                No pieces cut as {sizesNotHere.map((z) => z.code).join(', ')} are at {step.name} now.
              </p>
            )}
            {floor.madeEarlier.length > 0 && (
              <p>
                Already made as another size by an earlier change: {floor.madeEarlier.map((b) => `${bundleShort(b.code)} (${pcs(b.available)} as ${b.size ?? '—'})`).join(', ')}.
                Pieces change size once; to correct one, undo that change on the sheet.
              </p>
            )}
            {floor.outside.length > 0 && <p>Stitched by an outside unit, so their size stays: {floor.outside.map((b) => bundleShort(b.code)).join(', ')}.</p>}
          </div>
        )}
      </Section>

      <div id="sc-reason" className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="form-label">
            Reason <span className="text-destructive">*</span>
          </span>
          <input
            ref={reasonRef}
            className={`form-input ${tried && reasonIssue ? 'border-destructive' : ''}`}
            value={reason}
            maxLength={500}
            placeholder="Why were these made as another size?"
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={tried && !!reasonIssue}
            aria-label="Reason"
          />
          {tried && reasonIssue && <span className="text-destructive mt-1 block text-xs">{reasonIssue}</span>}
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

      <Section icon={Scale} title="Final size distribution">
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="data-table w-full">
            <thead>
              <tr className="bg-secondary">
                <th>Size</th>
                <th style={{ textAlign: 'right' }}>Planned</th>
                {anyEarlier && <th style={{ textAlign: 'right' }}>Earlier changes</th>}
                <th style={{ textAlign: 'right' }}>Made as other sizes</th>
                <th style={{ textAlign: 'right' }}>Made as this size</th>
                <th style={{ textAlign: 'right' }}>Final</th>
                <th style={{ textAlign: 'right' }}>Against planned</th>
              </tr>
            </thead>
            <tbody>
              {sizes.map((z) => {
                const out = outNow(z.id)
                const inn = inNow(z.id)
                const fin = finalOf(z)
                return (
                  <tr key={z.id}>
                    <td className="text-sm font-semibold">{z.code}</td>
                    <td className="text-muted-foreground text-right text-sm tabular-nums">{pcs(z.qty)}</td>
                    {anyEarlier && <td className={`text-right text-sm tabular-nums ${tone(z.changed ?? 0)}`}>{signed(z.changed ?? 0)}</td>}
                    <td className={`text-right text-sm tabular-nums ${out ? 'warn-text' : 'text-muted-foreground'}`}>{out ? `−${pcs(out)}` : '—'}</td>
                    <td className={`text-right text-sm tabular-nums ${inn ? 'text-emerald-600' : 'text-muted-foreground'}`}>{inn ? `+${pcs(inn)}` : '—'}</td>
                    <td className="text-foreground text-right text-sm font-semibold tabular-nums">{pcs(fin)}</td>
                    <td className={`text-right text-sm tabular-nums ${tone(fin - z.qty)}`}>{signed(fin - z.qty)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot className="[&_td]:px-4 [&_td]:py-2.5">
              <tr className="bg-secondary">
                <td className="text-xs font-semibold">Total</td>
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(planned)}</td>
                {anyEarlier && <td className="text-muted-foreground text-right text-xs tabular-nums">—</td>}
                <td className="text-right text-xs font-semibold tabular-nums">{moving ? `−${pcs(moving)}` : '—'}</td>
                <td className="text-right text-xs font-semibold tabular-nums">{moving ? `+${pcs(moving)}` : '—'}</td>
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(after)}</td>
                <td className="text-muted-foreground text-right text-xs tabular-nums">{signed(after - planned)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {/* Each changed size in a sentence, so nobody adds it up in their head. */}
        <ul className="mt-2 space-y-0.5 text-xs">
          {sizes
            .filter((z) => outNow(z.id) || inNow(z.id) || z.changed)
            .map((z) => {
              const parts = [`${pcs(z.qty)} planned`]
              if (z.changed) parts.push(`${z.changed > 0 ? '+' : '−'} ${pcs(Math.abs(z.changed))} earlier`)
              for (const p of plan.filter((x) => x.t.from === z.id && x.t.to && x.got)) parts.push(`− ${pcs(p.got)} made as ${code(p.t.to)}`)
              for (const p of plan.filter((x) => x.t.to === z.id && x.got)) parts.push(`+ ${pcs(p.got)} from ${code(p.t.from)}`)
              return (
                <li key={z.id} className="text-muted-foreground">
                  <span className="text-foreground font-medium">Size {z.code}:</span> {parts.join(' ')} = <span className="text-foreground font-semibold">{pcs(finalOf(z))}</span>
                </li>
              )
            })}
        </ul>
        <p className="text-foreground mt-2 flex items-center gap-1.5 text-xs">
          <CheckCircle2 size={13} className="text-primary shrink-0" /> {pcs(planned)} planned, {pcs(after)} after: pieces only move between sizes. The order&apos;s planned
          sizes stay as they are; finished goods are booked in the final sizes.
        </p>
      </Section>
    </FormFrame>
  )
}
