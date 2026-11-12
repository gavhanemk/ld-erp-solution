'use client'

import { useEffect, useState } from 'react'
import { Boxes, Loader2, PackageOpen } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { fabricQty, newClientKey, pcs, type JobCardCutting, type JobCardDetail } from './types'

/**
 * What came back cut from a cutting contractor, against what was issued to
 * them: the pieces by size, and the fabric — what they were given, what they
 * used and wasted, and what that leaves over with them. The pieces are tied
 * into bundles of the size given, each with its own number, and the stickers
 * open to print. Cutting more than the order needs a production manager.
 */

interface Fabric {
  itemId: string
  name: string
  uom: string | null
  fabric: boolean
  issued: number
  left: number
}

const DEFAULT_BUNDLE = 20
const num = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)))

export function CutterReceiveDialog({
  d,
  issue,
  onClose,
  onSaved,
}: {
  d: JobCardDetail
  issue: JobCardCutting
  onClose: () => void
  onSaved: (message: string, cuttingId: string) => void
}) {
  const planned = issue.plannedBreakup ?? {}
  const sizes = (d.line?.sizes ?? []).filter((z) => planned[z.id] || !Object.keys(planned).length)
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(sizes.map((z) => [z.id, planned[z.id] ? String(planned[z.id]) : ''])))
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [bundleSize, setBundleSize] = useState(String(DEFAULT_BUNDLE))
  const [fabrics, setFabrics] = useState<Fabric[]>([])
  const [fabricItemId, setFabricItemId] = useState(issue.fabricItem?.id ?? '')
  // What the contractor was given with the lay: as issued, or put in here when it was left off.
  const [fabricGiven, setFabricGiven] = useState(num(issue.fabricIssued))
  const [fabricUsed, setFabricUsed] = useState(num(issue.fabricIssued))
  const [wastage, setWastage] = useState('')
  const [allowExcess, setAllowExcess] = useState(false)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)

  useEffect(() => {
    let alive = true
    api
      .get<{ data: { fabrics: Fabric[] } }>(`/production/orders/${d.mo.id}/cutting`)
      .then((res) => {
        if (!alive) return
        const list = res.data.fabrics.filter((f) => f.issued > 0)
        setFabrics(list)
        setFabricItemId((cur) => cur || (list.find((f) => f.fabric) ?? list[0])?.itemId || '')
      })
      .catch(() => alive && setError('Could not load the fabric issued to the order.'))
    return () => {
      alive = false
    }
  }, [d.mo.id])

  const n = (v: string | undefined) => Number(v) || 0
  const total = sizes.reduce((s, z) => s + n(qty[z.id]), 0)
  const bundles = sizes.reduce((s, z) => {
    const q = n(qty[z.id])
    const b = n(bundleSize)
    return s + (q <= 0 ? 0 : b > 0 ? Math.ceil(q / b) : 1)
  }, 0)
  const manager = can('production', 'approve')
  const fabric = fabrics.find((f) => f.itemId === fabricItemId)
  const unit = fabric?.uom ?? issue.fabricItem?.uom?.symbol ?? ''
  const who = issue.cutterName ?? 'the contractor'

  // Given, less used and waste: what is left over with the contractor.
  const given = fabricGiven.trim() === '' ? null : n(fabricGiven)
  const leftOver = given == null ? null : Math.round((given - n(fabricUsed) - n(wastage)) * 1000) / 1000
  const leftNote =
    given == null
      ? { warn: false, text: `Put in the fabric given to ${who} to see what is left over with them.` }
      : leftOver! > 0
        ? { warn: true, text: `${fabricQty(leftOver!, unit)} left over — it stays on record with ${who} until it is accounted for.` }
        : leftOver! < 0
          ? { warn: true, text: `Used and waste come to ${fabricQty(-leftOver!, unit)} more than the ${fabricQty(given, unit)} given — check the figures.` }
          : { warn: false, text: `All ${fabricQty(given, unit)} given is accounted for: used and waste.` }

  /** What is wrong as filled, each shown under its own box; Save goes to the first. */
  const problems: Array<{ at: string; text: string }> = [
    ...(!total ? [{ at: 'receive-pieces', text: 'Enter the pieces received cut, by size.' }] : []),
    ...(!fabricItemId ? [{ at: 'receive-fabric', text: 'Say which fabric was cut.' }] : []),
  ]
  const problemAt = (at: string) => {
    const p = problems.find((x) => x.at === at)
    return p ? <span className="warn-text mt-1 block text-xs">{p.text}</span> : null
  }

  const save = async () => {
    if (problems.length) {
      const el = document.getElementById(problems[0].at)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true })
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string; data: { id: string } }>(`/production/cutting/${issue.id}/receive`, {
        cutDate: date,
        fabricItemId,
        fabricGiven: given,
        fabricUsed: n(fabricUsed),
        wastage: n(wastage),
        bundleSize: n(bundleSize),
        planned: Object.entries(planned).map(([sizeId, q]) => ({ sizeId, qty: Number(q) })),
        sizes: sizes.map((z) => ({ sizeId: z.id, qty: n(qty[z.id]) })).filter((z) => z.qty > 0),
        allowExcess: allowExcess && manager,
        notes: notes.trim() || null,
        clientKey,
      })
      onSaved(res.message ?? 'Received.', res.data.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not receive it.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={PackageOpen}
      title={`Receive cut pieces · ${issue.cutOrderNumber}`}
      subtitle={`From ${who} · ${d.card.jobCardNumber} · ${d.line?.style.code} ${d.line?.color}`}
      width="max-w-3xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Boxes size={15} />} Receive {total ? `${pcs(total)} pcs` : ''}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={
        problems.length ? (
          <span className="warn-text">{problems.length === 1 ? 'One box needs putting right — see the note under it.' : `${problems.length} boxes need putting right — see the notes under them.`}</span>
        ) : (
          `${bundles} ${bundles === 1 ? 'bundle' : 'bundles'}; the stickers open to print.`
        )
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {/* When it came back, its bundles and its fabric — first, as the issuing window has the lay first. */}
      <Section icon={PackageOpen} title="The lay, back cut">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="form-label">Received on</span>
            <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Pieces to a bundle</span>
            <StepInput className="form-input text-right tabular-nums" value={bundleSize} placeholder="0 = one per size" onValueChange={setBundleSize} aria-label="Pieces to a bundle" />
          </label>
          <label className="block sm:col-span-2" id="receive-fabric">
            <span className="form-label">Fabric</span>
            <SmartSelect className="form-input" value={fabricItemId} onChange={(e) => setFabricItemId(e.target.value)} aria-label="Fabric">
              <option value="">Pick the fabric…</option>
              {fabrics.map((f) => (
                <option key={f.itemId} value={f.itemId} data-sub={`${f.left} ${f.uom ?? ''} not yet used`}>
                  {f.name}
                </option>
              ))}
            </SmartSelect>
            {problemAt('receive-fabric')}
          </label>
          <label className="block">
            <span className="form-label">Fabric given{unit ? ` (${unit})` : ''}</span>
            <StepInput decimals className="form-input text-right tabular-nums" value={fabricGiven} placeholder="0" onValueChange={setFabricGiven} aria-label="Fabric given" />
          </label>
          <label className="block">
            <span className="form-label">Fabric used{unit ? ` (${unit})` : ''}</span>
            <StepInput decimals className="form-input text-right tabular-nums" value={fabricUsed} placeholder="0" onValueChange={setFabricUsed} aria-label="Fabric used" />
          </label>
          <label className="block">
            <span className="form-label">Cut waste{unit ? ` (${unit})` : ''}</span>
            <StepInput decimals className="form-input text-right tabular-nums" value={wastage} placeholder="0" onValueChange={setWastage} aria-label="Cut waste" />
          </label>
          <div className="block">
            <span className="form-label">Left over{unit ? ` (${unit})` : ''}</span>
            <p
              className={`border-border flex min-h-[2.5rem] items-center justify-end rounded-lg border border-dashed px-3 text-sm font-semibold tabular-nums ${leftOver ? 'warn-text' : 'text-foreground'}`}
              aria-label="Left over"
            >
              {leftOver == null ? '—' : leftOver.toLocaleString('en-IN', { maximumFractionDigits: 3 })}
            </p>
          </div>
          <p className={`text-xs sm:col-span-2 lg:col-span-4 ${leftNote.warn ? 'warn-text' : 'text-muted-foreground'}`}>{leftNote.text}</p>
          <label className="block sm:col-span-2 lg:col-span-4">
            <span className="form-label">Note</span>
            <input className="form-input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} aria-label="Note" />
          </label>
        </div>
      </Section>
      <Section icon={Boxes} title="Pieces received, by size">
        <div id="receive-pieces">
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="data-table w-full">
              <thead>
                <tr className="bg-secondary">
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>Issued to cut</th>
                  <th style={{ textAlign: 'right' }}>Received cut</th>
                </tr>
              </thead>
              <tbody>
                {sizes.map((z) => (
                  <tr key={z.id}>
                    <td className="text-xs font-medium">{z.code}</td>
                    <td className="text-right text-xs tabular-nums">{pcs(Number(planned[z.id] ?? 0))}</td>
                    <td className="w-32">
                      <StepInput
                        className="form-input h-8 text-right text-xs tabular-nums"
                        value={qty[z.id] ?? ''}
                        placeholder="0"
                        onValueChange={(v) => setQty((q) => ({ ...q, [z.id]: v }))}
                        aria-label={`Size ${z.code} received`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {problemAt('receive-pieces')}
        </div>
        {manager && (
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input type="checkbox" className="accent-primary" checked={allowExcess} onChange={(e) => setAllowExcess(e.target.checked)} />
            More was cut than the order needs: allow it
          </label>
        )}
      </Section>
    </FormFrame>
  )
}
