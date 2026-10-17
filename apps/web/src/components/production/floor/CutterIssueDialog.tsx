'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Scissors } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { SuggestInput } from '@/components/ui/SuggestInput'
import { pcs, type JobCardDetail } from './types'

/**
 * The first entry on a cutting sheet: sizes issued to a cutting contractor —
 * a lay, with its lot, ratio and the fabric given for it. Each size shows
 * what is still to cut after what has been cut and what other contractors
 * already have. What comes back cut is received against this issue.
 */

interface Fabric {
  itemId: string
  code: string
  name: string
  uom: string | null
  fabric: boolean
  issued: number
  left: number
}

export function CutterIssueDialog({ d, onClose, onSaved }: { d: JobCardDetail; onClose: () => void; onSaved: (message: string) => void }) {
  const [fabrics, setFabrics] = useState<Fabric[]>([])
  const [cutterName, setCutterName] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [lotNo, setLotNo] = useState(d.card.lotNo ?? '')
  const [ratio, setRatio] = useState(d.card.ratio ?? '')
  const [layers, setLayers] = useState('')
  const [fabricItemId, setFabricItemId] = useState('')
  const [fabricGiven, setFabricGiven] = useState('')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [allowExcess, setAllowExcess] = useState(false)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .get<{ data: { fabrics: Fabric[] } }>(`/production/orders/${d.mo.id}/cutting`)
      .then((res) => {
        if (!alive) return
        const list = res.data.fabrics.filter((f) => f.issued > 0)
        setFabrics(list)
        const first = list.find((f) => f.fabric) ?? list[0]
        if (first) setFabricItemId(first.itemId)
      })
      .catch(() => alive && setError('Could not load the fabric issued to the order.'))
    return () => {
      alive = false
    }
  }, [d.mo.id])

  // Every contractor named before, on any order, to pick from — this order's first.
  const [everyone, setEveryone] = useState<Array<{ name: string; cuts: number }>>([])
  useEffect(() => {
    let alive = true
    api
      .get<{ data: Array<{ name: string; cuts: number }> }>('/production/cutting-contractors')
      .then((res) => alive && setEveryone(res.data))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const known = useMemo(() => {
    const here = [...new Set(d.cuttings.map((c) => c.cutterName).filter(Boolean) as string[])]
    const rest = everyone.filter((c) => !here.some((h) => h.toLowerCase() === c.name.toLowerCase()))
    return [...here.map((name) => ({ value: name, label: 'on this order' })), ...rest.map((c) => ({ value: c.name, label: `${c.cuts} ${c.cuts === 1 ? 'cutting' : 'cuttings'} before` }))]
  }, [d.cuttings, everyone])
  // A name nobody has used before is fine, but worth a second look for spelling.
  const typedNew = !!cutterName.trim() && !known.some((k) => k.value.toLowerCase() === cutterName.trim().replace(/\s+/g, ' ').toLowerCase())
  const cutting = d.steps.find((s) => s.kind === 'CUTTING')
  const sizes = useMemo(
    () =>
      (d.line?.sizes ?? []).map((z) => {
        const cut = d.sizeFigures[z.id]?.find((f) => f.stepId === cutting?.id)?.completed ?? 0
        const withCutters = d.cuttings.filter((c) => c.status === 'IN_PROGRESS').reduce((s, c) => s + Number(c.plannedBreakup?.[z.id] ?? 0), 0)
        return { ...z, cut, withCutters, left: Math.max(0, z.qty - cut - withCutters) }
      }),
    [d, cutting?.id],
  )
  const n = (v: string | undefined) => Number(v) || 0
  const total = sizes.reduce((s, z) => s + n(qty[z.id]), 0)
  const over = sizes.find((z) => n(qty[z.id]) > z.left)
  const manager = can('production', 'approve')
  const blocker = !d.materials.issued
    ? 'The order’s materials have not been issued yet.'
    : !cutterName.trim()
      ? 'Name the cutting contractor.'
      : !total
        ? 'Enter the pieces of each size issued for cutting.'
        : over && !(allowExcess && manager)
          ? `Size ${over.code}: only ${over.left} left to cut.`
          : null

  const save = async () => {
    if (blocker) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${d.mo.id}/cutting-issues`, {
        moLineId: d.card.moLineId,
        cutterName: cutterName.trim(),
        issuedOn: date,
        lotNo: lotNo.trim() || null,
        ratio: ratio.trim() || null,
        noOfLayers: layers ? Number(layers) : null,
        fabricItemId: fabricItemId || null,
        fabricGiven: fabricGiven ? Number(fabricGiven) : null,
        planned: sizes.map((z) => ({ sizeId: z.id, qty: n(qty[z.id]) })).filter((z) => z.qty > 0),
        allowExcess: allowExcess && manager,
        notes: notes.trim() || null,
      })
      onSaved(res.message ?? 'Issued.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue it.')
    } finally {
      setSaving(false)
    }
  }

  const fabric = fabrics.find((f) => f.itemId === fabricItemId)
  return (
    <FormFrame
      icon={Scissors}
      title="Issue to cutting contractor"
      subtitle={`${d.card.jobCardNumber} · ${d.line?.style.code} ${d.line?.color} · ${d.mo.moNumber}`}
      width="max-w-4xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Scissors size={15} />} Issue {total ? `${pcs(total)} pcs` : ''}
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker ? <span className="warn-text">{blocker}</span> : 'Received back cut on the cutting sheet, which ties the bundles.'}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Scissors} title="The lay">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className="form-label">Cutting contractor</span>
            <SuggestInput className="form-input" value={cutterName} maxLength={120} placeholder="Ramesh (cutting master)" onValueChange={setCutterName} suggestions={known} aria-label="Cutting contractor" />
            {typedNew && known.length > 0 && <span className="form-help">A new contractor. Check the spelling: the same name written two ways counts as two people.</span>}
          </label>
          <label className="block">
            <span className="form-label">Issued on</span>
            <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Lot no.</span>
            <input className="form-input" value={lotNo} maxLength={60} onChange={(e) => setLotNo(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Ratio</span>
            <input className="form-input" value={ratio} maxLength={120} placeholder="M1 L2 XL2" onChange={(e) => setRatio(e.target.value)} />
          </label>
          <label className="block">
            <span className="form-label">Layers</span>
            <StepInput className="form-input text-right tabular-nums" value={layers} placeholder="0" onValueChange={setLayers} aria-label="Layers" />
          </label>
          <label className="block">
            <span className="form-label">Fabric</span>
            <SmartSelect className="form-input" value={fabricItemId} onChange={(e) => setFabricItemId(e.target.value)}>
              <option value="">—</option>
              {fabrics.map((f) => (
                <option key={f.itemId} value={f.itemId} data-sub={`${f.left} ${f.uom ?? ''} not yet used`}>
                  {f.name}
                </option>
              ))}
            </SmartSelect>
          </label>
          <label className="block">
            <span className="form-label">Fabric given{fabric?.uom ? ` (${fabric.uom})` : ''}</span>
            <StepInput decimals className="form-input text-right tabular-nums" value={fabricGiven} placeholder="0" onValueChange={setFabricGiven} aria-label="Fabric given" />
          </label>
        </div>
        {!d.materials.issued && (
          <p className="warn-text mt-2 text-xs">Cutting starts once the store has issued the order’s materials. Raise the requisition on the manufacturing order and have it issued first.</p>
        )}
      </Section>

      <Section icon={Scissors} title="Pieces to cut, by size">
        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="data-table w-full">
            <thead>
              <tr className="bg-secondary">
                <th>Size</th>
                <th style={{ textAlign: 'right' }}>To make</th>
                <th style={{ textAlign: 'right' }}>Cut</th>
                <th style={{ textAlign: 'right' }}>With contractors</th>
                <th style={{ textAlign: 'right' }}>Left</th>
                <th style={{ textAlign: 'right' }}>Issue now</th>
              </tr>
            </thead>
            <tbody>
              {sizes.map((z) => (
                <tr key={z.id}>
                  <td className="text-xs font-medium">{z.code}</td>
                  <td className="text-right text-xs tabular-nums">{pcs(z.qty)}</td>
                  <td className="text-right text-xs tabular-nums">{pcs(z.cut)}</td>
                  <td className="text-right text-xs tabular-nums">{pcs(z.withCutters)}</td>
                  <td className={`text-right text-xs tabular-nums ${n(qty[z.id]) > z.left ? 'text-destructive font-semibold' : ''}`}>{pcs(z.left)}</td>
                  <td className="w-28">
                    <StepInput
                      className="form-input h-8 text-right text-xs tabular-nums"
                      value={qty[z.id] ?? ''}
                      max={allowExcess && manager ? undefined : z.left}
                      placeholder="0"
                      onValueChange={(v) => setQty((q) => ({ ...q, [z.id]: v }))}
                      aria-label={`Size ${z.code} to issue`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-secondary">
                <td className="text-xs font-medium">Total</td>
                <td className="text-right text-xs tabular-nums">{pcs(sizes.reduce((s, z) => s + z.qty, 0))}</td>
                <td className="text-right text-xs tabular-nums">{pcs(sizes.reduce((s, z) => s + z.cut, 0))}</td>
                <td className="text-right text-xs tabular-nums">{pcs(sizes.reduce((s, z) => s + z.withCutters, 0))}</td>
                <td className="text-right text-xs tabular-nums">{pcs(sizes.reduce((s, z) => s + z.left, 0))}</td>
                <td className="text-right text-xs font-semibold tabular-nums">{pcs(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={() => setQty(Object.fromEntries(sizes.map((z) => [z.id, z.left ? String(z.left) : ''])))}>
            Issue all that is left
          </button>
          {manager && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="accent-primary" checked={allowExcess} onChange={(e) => setAllowExcess(e.target.checked)} />
              Allow cutting more than the order (an allowance)
            </label>
          )}
        </div>
        <label className="mt-3 block">
          <span className="form-label">Note</span>
          <input className="form-input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </Section>
    </FormFrame>
  )
}
