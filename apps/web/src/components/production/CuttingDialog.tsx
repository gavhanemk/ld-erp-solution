'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Scissors, Ruler, Shirt, Boxes } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

/**
 * Recording a cutting against a manufacturing order.
 *
 * What the cutting floor did with the fabric the store issued: the metres
 * used, the cut waste, and the pieces cut by size. Whatever is left of the
 * issue goes back to the store on a floor return from the requisition. When
 * the cut panels go out for outside work (embroidery), they can be put into a
 * store here as a semi-finished item — the customer's on a job-work order —
 * so a job-work challan can carry them.
 */

interface Prep {
  mo: { id: string; moNumber: string; status: string; totalPlannedQty: number; totalCutQty: number; so: { soNumber: string; isJobWork: boolean; customer: { name: string } } | null }
  fabrics: Array<{ itemId: string; code: string; name: string; uom: string | null; fabric: boolean; theirs: boolean; issued: number; accounted: number; left: number }>
  sizes: Array<{ sizeId: string; code: string; planned: number; cut: number }>
  panelItems: Array<{ id: string; code: string; name: string }>
  warehouses: Array<{ id: string; name: string }>
}

const num = (v: string) => Number(v) || 0
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const today = () => new Date().toISOString().slice(0, 10)

export function CuttingDialog({ moId, onClose, onSaved }: { moId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [prep, setPrep] = useState<Prep | null>(null)
  const [cutDate, setCutDate] = useState(today())
  const [fabricItemId, setFabricItemId] = useState('')
  const [used, setUsed] = useState('')
  const [waste, setWaste] = useState('')
  const [layers, setLayers] = useState('')
  const [sizes, setSizes] = useState<Record<string, string>>({})
  const [pieces, setPieces] = useState('')
  const [panelItemId, setPanelItemId] = useState('')
  const [panelWarehouseId, setPanelWarehouseId] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .get<{ data: Prep }>(`/production/orders/${moId}/cutting`)
      .then((res) => {
        if (!alive) return
        setPrep(res.data)
        // The fabric still to be accounted for is the usual pick.
        const first = res.data.fabrics.find((f) => f.fabric && f.left > 0) ?? res.data.fabrics.find((f) => f.left > 0)
        if (first) setFabricItemId(first.itemId)
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not open the cutting.'))
    return () => {
      alive = false
    }
  }, [moId])

  const fabric = prep?.fabrics.find((f) => f.itemId === fabricItemId)
  const totalPieces = prep?.sizes.length ? Object.values(sizes).reduce((s, v) => s + num(v), 0) : num(pieces)
  const leftAfter = fabric ? Math.round((fabric.left - num(used) - num(waste)) * 1000) / 1000 : 0
  const perPiece = totalPieces > 0 ? num(used) / totalPieces : 0

  const blocker = useMemo(() => {
    if (!prep) return 'Loading…'
    if (!fabric) return prep.fabrics.length ? 'Pick the fabric that was cut.' : 'No fabric has been issued to this order yet. Issue it on its requisition first.'
    if (leftAfter < -1e-9) return `Only ${fmt(fabric.left)} ${fabric.uom ?? ''} of ${fabric.name} is left to account for.`
    const over = prep.sizes.find((s) => num(sizes[s.sizeId] ?? '') + s.cut > s.planned)
    if (over) return `Size ${over.code}: ${over.planned} planned and ${over.cut} already cut.`
    if (totalPieces <= 0 && num(used) <= 0) return 'Enter the pieces cut and the fabric used.'
    if ((panelItemId && !panelWarehouseId) || (!panelItemId && panelWarehouseId)) return 'Pick both the panel item and the store, or neither.'
    return null
  }, [prep, fabric, leftAfter, sizes, totalPieces, used, panelItemId, panelWarehouseId])

  const save = async () => {
    if (blocker || !prep) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${moId}/cutting`, {
        cutDate,
        fabricItemId,
        fabricUsed: num(used),
        wastage: num(waste),
        noOfLayers: layers ? Number(layers) : null,
        ...(prep.sizes.length
          ? { sizes: prep.sizes.map((s) => ({ sizeId: s.sizeId, qty: num(sizes[s.sizeId] ?? '') })).filter((s) => s.qty > 0) }
          : { pieces: num(pieces) }),
        panelItemId: panelItemId || null,
        panelWarehouseId: panelWarehouseId || null,
        notes: notes.trim() || null,
      })
      onSaved(res.message ?? 'Cutting recorded.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the cutting.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Scissors}
      title={`Record cutting${prep ? ` · ${prep.mo.moNumber}` : ''}`}
      subtitle="Fabric used, cut waste and pieces cut by size. Whatever is left of the issue goes back to the store from the requisition."
      width="max-w-5xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || !!blocker}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Scissors size={15} />} Save cutting
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote={blocker && prep ? <span className="warn-text">{blocker}</span> : `${totalPieces.toLocaleString('en-IN')} pieces · ${fmt(perPiece)} per piece`}
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {!prep ? (
        <div className="skeleton h-48 w-full rounded-xl" />
      ) : (
        <>
          <Section icon={Ruler} title="Fabric">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="block min-w-0 lg:col-span-2">
                <span className="form-label">Fabric cut</span>
                <SmartSelect className="form-input" value={fabricItemId} onChange={(e) => setFabricItemId(e.target.value)} aria-label="Fabric cut">
                  <option value="">Choose the fabric…</option>
                  {prep.fabrics.map((f) => (
                    <option key={f.itemId} value={f.itemId} data-sub={`${fmt(f.left)} ${f.uom ?? ''} of ${fmt(f.issued)} issued left${f.theirs ? " · the customer's" : ''}`}>
                      {f.code} — {f.name}
                    </option>
                  ))}
                </SmartSelect>
              </label>
              <label className="block min-w-0">
                <span className="form-label">Date</span>
                <input type="date" className="form-input" value={cutDate} onChange={(e) => setCutDate(e.target.value || today())} />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Used ({fabric?.uom ?? 'mtr'})</span>
                <StepInput decimals className="form-input text-right tabular-nums" value={used} placeholder="0" onValueChange={setUsed} aria-label="Fabric used" />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Cut waste ({fabric?.uom ?? 'mtr'})</span>
                <StepInput decimals className="form-input text-right tabular-nums" value={waste} placeholder="0" onValueChange={setWaste} aria-label="Cut waste" />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Layers</span>
                <StepInput className="form-input text-right tabular-nums" value={layers} placeholder="—" onValueChange={setLayers} aria-label="Layers" />
              </label>
            </div>
            {fabric && (
              <p className={`mt-2 text-xs ${leftAfter < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                Issued to this order {fmt(fabric.issued)} {fabric.uom ?? ''} · already accounted {fmt(fabric.accounted)} · left after this cutting{' '}
                <b className="text-foreground">{fmt(leftAfter)}</b>
                {leftAfter > 0 ? ' — return it to the store from the requisition when cutting is done.' : ''}
              </p>
            )}
          </Section>

          <Section icon={Shirt} title="Pieces cut">
            {prep.sizes.length ? (
              <div className="overflow-x-auto">
                <table className="subtable w-auto">
                  <thead>
                    <tr>
                      <th />
                      {prep.sizes.map((s) => (
                        <th key={s.sizeId} className="w-16 text-center">
                          {s.code}
                        </th>
                      ))}
                      <th className="w-16 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="text-muted-foreground pr-4 text-xs">Planned · cut</td>
                      {prep.sizes.map((s) => (
                        <td key={s.sizeId} className="text-center text-xs tabular-nums">
                          {s.planned} · {s.cut}
                        </td>
                      ))}
                      <td className="text-right text-xs tabular-nums">
                        {prep.mo.totalPlannedQty} · {prep.mo.totalCutQty}
                      </td>
                    </tr>
                    <tr>
                      <td className="text-foreground pr-4 text-xs font-medium">Cut now</td>
                      {prep.sizes.map((s) => (
                        <td key={s.sizeId} className="px-1 py-1">
                          <StepInput
                            className="form-input h-8 w-14 px-1 text-center text-xs tabular-nums"
                            value={sizes[s.sizeId] ?? ''}
                            placeholder="0"
                            aria-label={`Size ${s.code} cut now`}
                            onValueChange={(v) => setSizes((z) => ({ ...z, [s.sizeId]: v }))}
                          />
                        </td>
                      ))}
                      <td className="text-foreground text-right text-xs font-semibold tabular-nums">{totalPieces}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <label className="block w-40">
                <span className="form-label">Pieces cut</span>
                <StepInput className="form-input text-right tabular-nums" value={pieces} placeholder="0" onValueChange={setPieces} aria-label="Pieces cut" />
              </label>
            )}
          </Section>

          <Section icon={Boxes} title="Panels into a store (optional)">
            <p className="text-muted-foreground mb-2 text-xs">
              Only when the cut panels go out for outside work, such as embroidery: they go into stock as a semi-finished item
              {prep.mo.so?.isJobWork ? `, as ${prep.mo.so.customer.name}'s` : ''}, ready for a job-work challan.
            </p>
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
              <label className="block min-w-0">
                <span className="form-label">Panel item</span>
                <SmartSelect className="form-input" value={panelItemId} onChange={(e) => setPanelItemId(e.target.value)} aria-label="Panel item">
                  <option value="">Not into stock</option>
                  {prep.panelItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.code} — {it.name}
                    </option>
                  ))}
                </SmartSelect>
              </label>
              <label className="block min-w-0">
                <span className="form-label">Store</span>
                <SmartSelect className="form-input" value={panelWarehouseId} onChange={(e) => setPanelWarehouseId(e.target.value)} aria-label="Panel store">
                  <option value="">—</option>
                  {prep.warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </SmartSelect>
              </label>
              <label className="block min-w-0">
                <span className="form-label">Note</span>
                <input className="form-input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Marker, lay length" />
              </label>
            </div>
            {!prep.panelItems.length && (
              <p className="warn-text mt-2 text-xs">No semi-finished item exists yet. Add one (e.g. &quot;Front panel — formal shirt&quot;) in Masters → Items with type Semi-finished.</p>
            )}
          </Section>
        </>
      )}
    </FormFrame>
  )
}
