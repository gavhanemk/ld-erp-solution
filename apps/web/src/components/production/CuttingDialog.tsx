'use client'

import { useEffect, useMemo, useState } from 'react'
import { Boxes, Layers, Loader2, Ruler, Scissors, Shirt, Wand2 } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { newClientKey } from './floor/types'

/**
 * The cutting document: one lay of one line of the order — a style in one
 * colour — as the cutting room records it. The fabric lot and how much was
 * used and wasted; the marker ratio and layers; who cut it; and the pieces by
 * size, planned against actual. Whatever is left of the issue goes back to the
 * store from the requisition.
 *
 * On an order with a route the pieces are tied into bundles of the size given
 * here, each with its own number and sticker, and are ready to send on to the
 * next step. Without a route they are counted as before, and can be put into
 * a store as panels.
 */

interface PrepLine {
  id: string
  style: { code: string; name: string }
  color: string
  totalQty: number
  cut: number
  sizes: Array<{ sizeId: string; code: string; planned: number; cut: number }>
}
interface Prep {
  mo: {
    id: string
    moNumber: string
    status: string
    held: boolean
    totalPlannedQty: number
    totalCutQty: number
    routed: boolean
    nextBundleNo: number
    cuttingStep: { id: string; name: string } | null
    so: { soNumber: string; isJobWork: boolean; customer: { name: string } } | null
  }
  defaultBundleSize: number
  fabrics: Array<{ itemId: string; code: string; name: string; uom: string | null; fabric: boolean; theirs: boolean; issued: number; accounted: number; left: number }>
  sizes: Array<{ sizeId: string; code: string; planned: number; cut: number }>
  lines: PrepLine[]
  panelItems: Array<{ id: string; code: string; name: string }>
  warehouses: Array<{ id: string; name: string }>
}

const num = (v: string | undefined) => Number(v) || 0
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
const today = () => new Date().toISOString().slice(0, 10)
const BUNDLE_KEY = 'ld.cutting.bundleSize'

/** "38x2 40x2", "38:2, 40:2" or "38-2 40-2" → { '38': 2, '40': 2 }. */
function parseRatio(ratio: string) {
  const out: Record<string, number> = {}
  for (const m of ratio.matchAll(/([A-Za-z0-9]+)\s*[x×:*-]\s*(\d+)/g)) out[m[1].toUpperCase()] = (out[m[1].toUpperCase()] ?? 0) + Number(m[2])
  return out
}

export function CuttingDialog({ moId, onClose, onSaved }: { moId: string; onClose: () => void; onSaved: (message: string, cuttingId?: string, bundles?: number) => void }) {
  const [prep, setPrep] = useState<Prep | null>(null)
  const [lineId, setLineId] = useState('')
  const [cutDate, setCutDate] = useState(today())
  const [fabricItemId, setFabricItemId] = useState('')
  const [used, setUsed] = useState('')
  const [waste, setWaste] = useState('')
  const [layers, setLayers] = useState('')
  const [lotNo, setLotNo] = useState('')
  const [ratio, setRatio] = useState('')
  const [cutterName, setCutterName] = useState('')
  const [bundleSize, setBundleSize] = useState('')
  const [planned, setPlanned] = useState<Record<string, string>>({})
  const [sizes, setSizes] = useState<Record<string, string>>({})
  const [pieces, setPieces] = useState('')
  const [allowExcess, setAllowExcess] = useState(false)
  const [panelItemId, setPanelItemId] = useState('')
  const [panelWarehouseId, setPanelWarehouseId] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientKey] = useState(newClientKey)
  const manager = can('production', 'approve')

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
        const open = res.data.lines.find((l) => l.cut < l.totalQty) ?? res.data.lines[0]
        if (open && (res.data.mo.routed || res.data.lines.length > 1)) setLineId(open.id)
        let remembered = ''
        try {
          remembered = localStorage.getItem(BUNDLE_KEY) ?? ''
        } catch {
          remembered = ''
        }
        setBundleSize(remembered || String(res.data.defaultBundleSize))
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not open the cutting.'))
    return () => {
      alive = false
    }
  }, [moId])

  const line = prep?.lines.find((l) => l.id === lineId) ?? null
  // The size grid: the line's own, or the whole order's when no line is picked.
  const grid = line ? line.sizes : prep?.sizes ?? []
  const sized = grid.length > 0
  const fabric = prep?.fabrics.find((f) => f.itemId === fabricItemId)
  const totalPieces = sized ? grid.reduce((s, z) => s + num(sizes[z.sizeId]), 0) : num(pieces)
  const totalPlanned = grid.reduce((s, z) => s + num(planned[z.sizeId]), 0)
  const leftAfter = fabric ? Math.round((fabric.left - num(used) - num(waste)) * 1000) / 1000 : 0
  const average = totalPieces > 0 ? num(used) / totalPieces : 0
  const over = sized ? grid.filter((z) => num(sizes[z.sizeId]) + z.cut > z.planned) : line && num(pieces) + line.cut > line.totalQty ? [{ code: 'pieces', planned: line.totalQty, cut: line.cut }] : []
  const routed = !!prep?.mo.routed
  const perBundle = num(bundleSize)
  const bundlesMade = routed
    ? sized
      ? grid.reduce((s, z) => s + (num(sizes[z.sizeId]) > 0 ? (perBundle > 0 ? Math.ceil(num(sizes[z.sizeId]) / perBundle) : 1) : 0), 0)
      : totalPieces > 0
        ? perBundle > 0
          ? Math.ceil(totalPieces / perBundle)
          : 1
        : 0
    : 0

  const fromRatio = () => {
    const r = parseRatio(ratio)
    const lay = num(layers)
    if (!lay || !Object.keys(r).length) return
    setPlanned(Object.fromEntries(grid.map((z) => [z.sizeId, r[z.code.toUpperCase()] ? String(r[z.code.toUpperCase()] * lay) : ''])))
  }

  const blocker = useMemo(() => {
    if (!prep) return 'Loading…'
    if (prep.mo.held) return `${prep.mo.moNumber} is on hold.`
    if (routed && !line) return 'Pick the line — style and colour — that was cut.'
    if (!fabric) return prep.fabrics.length ? 'Pick the fabric that was cut.' : 'No fabric has been issued to this order yet. Issue it on its requisition first.'
    if (leftAfter < -1e-9) return `Only ${fmt(fabric.left)} ${fabric.uom ?? ''} of ${fabric.name} is left to account for.`
    if (over.length && !(manager && allowExcess)) {
      return manager ? `Size ${over[0].code}: ${over[0].planned} planned and ${over[0].cut} already cut — tick "allow" to cut over.` : `Size ${over[0].code}: ${over[0].planned} planned and ${over[0].cut} already cut. Cutting over the plan needs a production manager.`
    }
    if (totalPieces <= 0 && (routed || num(used) <= 0)) return 'Enter the pieces cut.'
    if ((panelItemId && !panelWarehouseId) || (!panelItemId && panelWarehouseId)) return 'Pick both the panel item and the store, or neither.'
    return null
  }, [prep, routed, line, fabric, leftAfter, over, manager, allowExcess, totalPieces, used, panelItemId, panelWarehouseId])

  const save = async () => {
    if (blocker || !prep) return
    setSaving(true)
    setError(null)
    try {
      try {
        if (routed && bundleSize) localStorage.setItem(BUNDLE_KEY, bundleSize)
      } catch {
        // Remembering the bundle size is a convenience only.
      }
      const res = await api.post<{ message?: string; data: { id: string; bundles?: number } }>(`/production/orders/${moId}/cutting`, {
        cutDate,
        moLineId: line?.id ?? null,
        fabricItemId,
        fabricUsed: num(used),
        wastage: num(waste),
        noOfLayers: layers ? Number(layers) : null,
        lotNo: lotNo.trim() || null,
        ratio: ratio.trim() || null,
        cutterName: cutterName.trim() || null,
        bundleSize: routed ? perBundle : null,
        planned: sized ? grid.map((z) => ({ sizeId: z.sizeId, qty: num(planned[z.sizeId]) })).filter((z) => z.qty > 0) : undefined,
        ...(sized ? { sizes: grid.map((z) => ({ sizeId: z.sizeId, qty: num(sizes[z.sizeId]) })).filter((z) => z.qty > 0) } : { pieces: num(pieces) }),
        allowExcess: over.length ? allowExcess : false,
        panelItemId: routed ? null : panelItemId || null,
        panelWarehouseId: routed ? null : panelWarehouseId || null,
        notes: notes.trim() || null,
        clientKey,
      })
      onSaved(res.message ?? 'Cutting recorded.', res.data.id, res.data.bundles ?? 0)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the cutting.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Scissors}
      title={`Cutting${prep ? ` · ${prep.mo.moNumber}` : ''}`}
      subtitle={routed ? 'One lay: the fabric, the marker, and the pieces by size — tied into bundles, ready for the next step.' : 'Fabric used, cut waste and pieces cut by size.'}
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
      footerNote={
        blocker && prep ? (
          <span className="warn-text">{blocker}</span>
        ) : (
          `${totalPieces.toLocaleString('en-IN')} pieces · average ${fmt(average)} ${fabric?.uom ?? ''} a piece${routed ? ` · ${bundlesMade} ${bundlesMade === 1 ? 'bundle' : 'bundles'}` : ''}`
        )
      }
      error={error}
      onClose={onClose}
      busy={saving}
    >
      {!prep ? (
        <div className="skeleton h-48 w-full rounded-xl" />
      ) : (
        <>
          <Section icon={Layers} title="The lay">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-6">
              {(routed || prep.lines.length > 1) && (
                <label className="block min-w-0 sm:col-span-2">
                  <span className="form-label">Line cut</span>
                  <SmartSelect
                    className="form-input"
                    value={lineId}
                    onChange={(e) => {
                      setLineId(e.target.value)
                      setSizes({})
                      setPlanned({})
                    }}
                    aria-label="Line cut"
                  >
                    {!routed && <option value="">All lines together</option>}
                    {routed && !lineId && <option value="">Pick the style and colour…</option>}
                    {prep.lines.map((l) => (
                      <option key={l.id} value={l.id} data-sub={`${l.cut.toLocaleString('en-IN')} of ${l.totalQty.toLocaleString('en-IN')} cut`}>
                        {l.style.code} · {l.color}
                      </option>
                    ))}
                  </SmartSelect>
                </label>
              )}
              <label className="block min-w-0">
                <span className="form-label">Date</span>
                <input type="date" className="form-input" value={cutDate} onChange={(e) => setCutDate(e.target.value || today())} />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Lot / shade</span>
                <input className="form-input" value={lotNo} maxLength={60} placeholder="LOT-7" onChange={(e) => setLotNo(e.target.value)} />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Cut by</span>
                <input className="form-input" value={cutterName} maxLength={120} placeholder="Cutting master" onChange={(e) => setCutterName(e.target.value)} />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Layers</span>
                <StepInput className="form-input text-right tabular-nums" value={layers} placeholder="—" onValueChange={setLayers} aria-label="Layers" />
              </label>
              <label className="block min-w-0 sm:col-span-2 lg:col-span-3">
                <span className="form-label">Marker ratio</span>
                <input className="form-input" value={ratio} maxLength={120} placeholder={grid.length ? grid.slice(0, 3).map((z) => `${z.code}x1`).join(' ') : 'M x2  L x2'} onChange={(e) => setRatio(e.target.value)} />
              </label>
              {routed && (
                <label className="block min-w-0">
                  <span className="form-label">Pieces a bundle</span>
                  <StepInput className="form-input text-right tabular-nums" value={bundleSize} placeholder="One per size" onValueChange={setBundleSize} aria-label="Pieces a bundle" />
                </label>
              )}
            </div>
          </Section>

          <Section icon={Ruler} title="Fabric">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
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
                <span className="form-label">Used ({fabric?.uom ?? 'mtr'})</span>
                <StepInput decimals className="form-input text-right tabular-nums" value={used} placeholder="0" onValueChange={setUsed} aria-label="Fabric used" />
              </label>
              <label className="block min-w-0">
                <span className="form-label">Cut waste ({fabric?.uom ?? 'mtr'})</span>
                <StepInput decimals className="form-input text-right tabular-nums" value={waste} placeholder="0" onValueChange={setWaste} aria-label="Cut waste" />
              </label>
            </div>
            {fabric && (
              <p className={`mt-2 text-xs ${leftAfter < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                Issued to this order {fmt(fabric.issued)} {fabric.uom ?? ''} · already accounted {fmt(fabric.accounted)} · left after this cutting <b className="text-foreground">{fmt(leftAfter)}</b>
                {leftAfter > 0 ? ' — return it to the store from the requisition when cutting is done.' : ''}
              </p>
            )}
          </Section>

          <Section
            icon={Shirt}
            title="Pieces by size"
            actions={
              sized && ratio && layers ? (
                <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={fromRatio} title="Planned = layers × the marker ratio">
                  <Wand2 size={13} /> Plan from the ratio
                </button>
              ) : undefined
            }
          >
            {sized ? (
              <div className="overflow-x-auto">
                <table className="subtable w-auto">
                  <thead>
                    <tr>
                      <th />
                      {grid.map((z) => (
                        <th key={z.sizeId} className="w-16 text-center">
                          {z.code}
                        </th>
                      ))}
                      <th className="w-16 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="text-muted-foreground pr-4 text-xs">Order · cut so far</td>
                      {grid.map((z) => (
                        <td key={z.sizeId} className="text-center text-xs tabular-nums">
                          {z.planned} · {z.cut}
                        </td>
                      ))}
                      <td className="text-right text-xs tabular-nums">
                        {grid.reduce((s, z) => s + z.planned, 0)} · {grid.reduce((s, z) => s + z.cut, 0)}
                      </td>
                    </tr>
                    <tr>
                      <td className="text-muted-foreground pr-4 text-xs">This lay, planned</td>
                      {grid.map((z) => (
                        <td key={z.sizeId} className="px-1 py-1">
                          <StepInput className="form-input h-8 w-14 px-1 text-center text-xs tabular-nums" value={planned[z.sizeId] ?? ''} placeholder="—" aria-label={`Size ${z.code} planned`} onValueChange={(v) => setPlanned((p) => ({ ...p, [z.sizeId]: v }))} />
                        </td>
                      ))}
                      <td className="text-right text-xs tabular-nums">{totalPlanned || '—'}</td>
                    </tr>
                    <tr>
                      <td className="text-foreground pr-4 text-xs font-medium">Actually cut</td>
                      {grid.map((z) => {
                        const isOver = num(sizes[z.sizeId]) + z.cut > z.planned
                        return (
                          <td key={z.sizeId} className="px-1 py-1">
                            <StepInput
                              className={`form-input h-8 w-14 px-1 text-center text-xs tabular-nums ${isOver ? 'border-destructive/60' : ''}`}
                              value={sizes[z.sizeId] ?? ''}
                              placeholder="0"
                              aria-label={`Size ${z.code} cut`}
                              onValueChange={(v) => setSizes((s) => ({ ...s, [z.sizeId]: v }))}
                            />
                          </td>
                        )
                      })}
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
            {over.length > 0 && manager && (
              <label className="mt-2 flex items-start gap-2 text-xs">
                <input type="checkbox" className="accent-primary mt-0.5" checked={allowExcess} onChange={(e) => setAllowExcess(e.target.checked)} />
                <span className="warn-text">Allow cutting over the plan (an allowance for losses) — recorded as cut by you.</span>
              </label>
            )}
            {routed && bundlesMade > 0 && (
              <p className="text-muted-foreground mt-2 text-xs">
                Tied into {bundlesMade} {bundlesMade === 1 ? 'bundle' : 'bundles'}
                {perBundle > 0 ? ` of up to ${perBundle}` : ', one per size'}, numbered {prep.mo.moNumber}-B{String(prep.mo.nextBundleNo).padStart(3, '0')}
                {bundlesMade > 1 ? ` to -B${String(prep.mo.nextBundleNo + bundlesMade - 1).padStart(3, '0')}` : ''}. Print their stickers after saving.
              </p>
            )}
          </Section>

          {!routed && (
            <Section icon={Boxes} title="Panels into a store (optional)">
              <p className="text-muted-foreground mb-2 text-xs">
                Only when the cut panels go out for outside work on an order without a route: they go into stock as a semi-finished item
                {prep.mo.so?.isJobWork ? `, as ${prep.mo.so.customer.name}'s` : ''}, ready for a job-work challan.
              </p>
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
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
              </div>
            </Section>
          )}

          <label className="block">
            <span className="form-label">Note</span>
            <input className="form-input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Marker length, shade remarks" />
          </label>
        </>
      )}
    </FormFrame>
  )
}
