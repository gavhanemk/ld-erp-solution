'use client'

import { useMemo, useState } from 'react'
import { ArrowLeftRight, Loader2, Wand2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { bundleRows } from './useFlow'
import { newClientKey, pcs, revisedQty, type FlowStep, type JobCardDetail } from './types'

/**
 * A size jump at stitching: pieces of a bundle made as another size of the
 * order — cut as M, made as L. Each bundle's pieces go into a new bundle of
 * the new size, made from it here, with its own sticker; the old bundle keeps
 * its history. The order's planned sizes stay as they are, with the revised
 * count of each shown beside them, and nothing goes into stock until the
 * pieces are packed into finished goods in their new size.
 */
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
  const rows = useMemo(() => {
    const own = d.line ? d.bundles.filter((b) => b.line?.id === d.line!.id) : d.bundles
    const sizeOf = new Map(own.map((b) => [b.id, b.size?.id ?? null]))
    return bundleRows(own, { stepId: step.id, bucket: ['WIP', 'DONE'] }).map((r) => ({ ...r, sizeId: sizeOf.get(r.id) ?? null }))
  }, [d.bundles, d.line, step.id])

  const [lines, setLines] = useState<Record<string, { qty: string; to: string }>>({})
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [many, setMany] = useState('')
  const [reason, setReason] = useState('')
  const [personName, setPersonName] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)

  const n = (v: string | undefined) => Number(v) || 0
  const sizeCode = (id: string | null) => sizes.find((z) => z.id === id)?.code ?? '—'
  const set = (id: string, patch: Partial<{ qty: string; to: string }>) => setLines((x) => ({ ...x, [id]: { qty: x[id]?.qty ?? '', to: x[id]?.to ?? '', ...patch } }))

  // "20 of M made as L": spread over the M bundles here, oldest first.
  const inFrom = rows.filter((r) => r.sizeId === from).reduce((s, r) => s + r.available, 0)
  const fill = () => {
    // Worked out once, outside the state update, so it is the same however often React runs that.
    let left = Math.min(n(many), inFrom)
    const filled: Record<string, { qty: string; to: string }> = {}
    for (const r of rows.filter((r) => r.sizeId === from)) {
      const take = Math.min(left, r.available)
      left -= take
      filled[r.id] = { qty: take ? String(take) : '', to: take ? to : (lines[r.id]?.to ?? '') }
    }
    setLines((x) => ({ ...x, ...filled }))
  }

  const chosen = rows.map((r) => ({ r, qty: n(lines[r.id]?.qty), to: lines[r.id]?.to ?? '' })).filter((l) => l.qty > 0)
  const total = chosen.reduce((s, l) => s + l.qty, 0)
  const outOf = (sizeId: string) => chosen.filter((l) => l.r.sizeId === sizeId).reduce((s, l) => s + l.qty, 0)
  const into = (sizeId: string) => chosen.filter((l) => l.to === sizeId).reduce((s, l) => s + l.qty, 0)
  const planned = sizes.reduce((s, z) => s + z.qty, 0)
  const noTarget = chosen.find((l) => !l.to || l.to === l.r.sizeId)
  const over = chosen.find((l) => l.qty > l.r.available)
  const blocker = !rows.length
    ? `Nothing is in hand or done at ${step.name} on this job card.`
    : !chosen.length
      ? 'Enter the pieces made as another size.'
      : noTarget
        ? `${noTarget.r.code}: pick the size its pieces are made as.`
        : over
          ? `${over.r.code} has only ${over.r.available} here.`
          : reason.trim().length < 5
            ? 'Say why the sizes changed, in a few words.'
            : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { eventId: string; bundleIds: string[] } }>(`/production/orders/${d.mo.id}/size-changes`, {
        stepId: step.id,
        lines: chosen.map((l) => ({ bundleId: l.r.id, toSizeId: l.to, qty: l.qty })),
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

  const newBundles = chosen.length
  return (
    <FormFrame
      icon={ArrowLeftRight}
      title={`Change sizes at ${step.name}`}
      subtitle={`${d.card.jobCardNumber} · ${d.line?.style.code ?? ''} ${d.line?.color ?? ''} · ${pcs(planned)} pcs planned`}
      width="max-w-5xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <ArrowLeftRight size={15} />} Change sizes
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        blocker ? (
          <span className="warn-text">{blocker}</span>
        ) : (
          `${pcs(total)} pcs into ${newBundles} new ${newBundles === 1 ? 'bundle' : 'bundles'}; the total stays ${pcs(planned)}. Their stickers print when you save.`
        )
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Wand2} title="Quick fill">
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="block w-28">
            <span className="form-label">Size</span>
            <SmartSelect
              className="form-input"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value)
                if (e.target.value === to) setTo('')
              }}
              aria-label="Size the pieces were cut as"
            >
              <option value="">Pick…</option>
              {sizes.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.code}
                </option>
              ))}
            </SmartSelect>
          </label>
          <span className="text-muted-foreground pb-2">made as</span>
          <label className="block w-28">
            <span className="form-label">New size</span>
            <SmartSelect className="form-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Size they are made as">
              <option value="">Pick…</option>
              {sizes
                .filter((z) => z.id !== from)
                .map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.code}
                  </option>
                ))}
            </SmartSelect>
          </label>
          <label className="block w-28">
            <span className="form-label">Pieces</span>
            <StepInput className="form-input text-right tabular-nums" value={many} max={inFrom || undefined} placeholder="0" onValueChange={setMany} aria-label="Pieces made as the new size" />
          </label>
          <button type="button" className="btn-secondary h-9" disabled={!from || !to || from === to || !n(many)} onClick={fill}>
            Fill the bundles
          </button>
          {from && <span className="text-muted-foreground pb-2 text-xs">{pcs(inFrom)} pcs of {sizeCode(from)} here, oldest bundles first</span>}
        </div>
      </Section>

      <Section icon={ArrowLeftRight} title="Bundles here">
        {!rows.length ? (
          <p className="text-muted-foreground text-sm">Nothing is in hand or done at {step.name} on this job card. Count the pieces in first.</p>
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="data-table w-full min-w-[620px]">
              <thead>
                <tr className="bg-secondary">
                  <th>Bundle</th>
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>Here</th>
                  <th style={{ textAlign: 'right' }}>Pieces</th>
                  <th>Made as</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-xs">{r.code}</td>
                    <td className="text-sm font-semibold">{r.size ?? '—'}</td>
                    <td className="text-right text-xs tabular-nums">{pcs(r.available)}</td>
                    <td className="w-28">
                      <StepInput
                        className="form-input h-8 text-right text-xs tabular-nums"
                        value={lines[r.id]?.qty ?? ''}
                        max={r.available}
                        placeholder="0"
                        onValueChange={(v) => set(r.id, { qty: v })}
                        aria-label={`${r.code} pieces made as another size`}
                      />
                    </td>
                    <td className="w-36">
                      <SmartSelect className="form-input h-8 text-xs" value={lines[r.id]?.to ?? ''} onChange={(e) => set(r.id, { to: e.target.value })} aria-label={`${r.code} made as`}>
                        <option value="">—</option>
                        {sizes
                          .filter((z) => z.id !== r.sizeId)
                          .map((z) => (
                            <option key={z.id} value={z.id}>
                              {z.code}
                            </option>
                          ))}
                      </SmartSelect>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section icon={ArrowLeftRight} title="Sizes of the order">
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="data-table w-full">
            <thead>
              <tr className="bg-secondary">
                <th>Size</th>
                <th style={{ textAlign: 'right' }}>Planned</th>
                <th style={{ textAlign: 'right' }}>Revised so far</th>
                <th style={{ textAlign: 'right' }}>After this</th>
                <th style={{ textAlign: 'right' }}>Against planned</th>
              </tr>
            </thead>
            <tbody>
              {sizes.map((z) => {
                const now = revisedQty(z)
                const after = Math.max(0, now - outOf(z.id) + into(z.id))
                const diff = after - z.qty
                return (
                  <tr key={z.id}>
                    <td className="text-sm font-semibold">{z.code}</td>
                    <td className="text-right text-xs tabular-nums">{pcs(z.qty)}</td>
                    <td className="text-muted-foreground text-right text-xs tabular-nums">{pcs(now)}</td>
                    <td className={`text-right text-xs font-semibold tabular-nums ${after !== now ? 'text-primary' : ''}`}>{pcs(after)}</td>
                    <td className={`text-right text-xs tabular-nums ${diff > 0 ? 'text-emerald-600' : diff < 0 ? 'warn-text' : 'text-muted-foreground'}`}>{diff > 0 ? `+${pcs(diff)}` : diff < 0 ? `−${pcs(-diff)}` : '0'}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="bg-secondary">
                <td className="text-xs font-medium">Total</td>
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(planned)}</td>
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(sizes.reduce((s, z) => s + revisedQty(z), 0))}</td>
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(sizes.reduce((s, z) => s + Math.max(0, revisedQty(z) - outOf(z.id) + into(z.id)), 0))}</td>
                <td className="text-muted-foreground text-right text-xs tabular-nums">0</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">The order&apos;s planned sizes stay as they are. Finished goods are booked in the revised sizes, and the delivery challan decides how many of each size go.</p>
      </Section>

      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="form-label">Why the sizes changed</span>
          <input className="form-input" value={reason} maxLength={500} placeholder="Measured large after stitching; buyer agreed" onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="block">
          <span className="form-label">Done by</span>
          <input className="form-input" value={personName} maxLength={120} placeholder="Line or supervisor" onChange={(e) => setPersonName(e.target.value)} />
        </label>
        <label className="block">
          <span className="form-label">On</span>
          <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block sm:col-span-2 lg:col-span-4">
          <span className="form-label">Note</span>
          <input className="form-input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </FormFrame>
  )
}
