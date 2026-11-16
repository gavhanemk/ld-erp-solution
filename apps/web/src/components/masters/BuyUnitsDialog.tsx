'use client'

import { useEffect, useState } from 'react'
import { Boxes, Loader2, Plus, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'

/** A pack an item is bought in, as GET /masters/items returns it. */
export interface BuyUnit {
  id?: string
  factor: string | number
  isDefault: boolean
  uom: { id: string; name: string; symbol: string; decimalPlaces?: number }
}

interface Unit {
  id: string
  name: string
  symbol: string
  isActive: boolean
}

interface Row {
  uomId: string
  factor: string
  isDefault: boolean
}

/**
 * "Bought in": the packs an item is bought in besides its own unit — a box of
 * 20 pcs, a gross of 144 — and which one a new purchase order line starts in.
 * Only buying uses them; the store keeps counting the item in its own unit, so
 * a box received puts its 20 pcs into stock.
 */
export function BuyUnitsDialog({
  item,
  onClose,
  onSaved,
}: {
  item: { id: string; code: string; name: string; uom: { id: string; symbol: string } | null; buyUnits?: BuyUnit[] }
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const own = item.uom?.symbol ?? 'its own unit'
  const [units, setUnits] = useState<Unit[]>([])
  const [rows, setRows] = useState<Row[]>(() =>
    (item.buyUnits ?? []).map((u) => ({ uomId: u.uom.id, factor: String(Number(u.factor)), isDefault: u.isDefault })),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Unit[] }>('/masters/uoms?limit=200')
      .then((r) => setUnits(r.data.filter((u) => u.isActive && u.id !== item.uom?.id)))
      .catch(() => setError('Could not load the units.'))
  }, [item.uom?.id])

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : patch.isDefault ? { ...r, isDefault: false } : r)))
  const symbolOf = (id: string) => units.find((u) => u.id === id)?.symbol ?? ''

  const save = async () => {
    setError(null)
    const blank = rows.findIndex((r) => !r.uomId || !(Number(r.factor) > 0))
    if (blank >= 0) return setError(`Line ${blank + 1}: choose the pack and say how many ${own} one holds.`)
    setSaving(true)
    try {
      const res = await api.patch<{ message?: string }>(`/masters/items/${item.id}/buy-units`, {
        units: rows.map((r) => ({ uomId: r.uomId, factor: Number(r.factor), isDefault: r.isDefault })),
      })
      onSaved(res.message ?? 'Saved.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Boxes}
      title={`Bought in — ${item.name}`}
      subtitle={`${item.code} is counted in ${own} in the store. List the packs it is bought in, and what each holds.`}
      width="max-w-2xl"
      error={error}
      onClose={onClose}
      busy={saving}
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving} data-hotkey="save">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Boxes size={15} />}
          Save
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote="A purchase line keeps the pack size it was bought at; changing one here does not change orders or bills already made."
    >
      <div className="space-y-3 p-4">
        {rows.length === 0 && <p className="text-sm text-muted-foreground">Bought in {own} only. Add a pack if a supplier sells it by the box, gross or bundle.</p>}
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_8rem_auto_auto] items-end gap-2">
            <label className="block min-w-0">
              <span className="form-label">Pack</span>
              <SmartSelect className="form-input h-9" value={r.uomId} onChange={(e) => setRow(i, { uomId: e.target.value })} aria-label={`Pack ${i + 1}`}>
                <option value="">Choose…</option>
                {units
                  .filter((u) => u.id === r.uomId || !rows.some((x) => x.uomId === u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.symbol})
                    </option>
                  ))}
              </SmartSelect>
            </label>
            <label className="block min-w-0">
              <span className="form-label">Holds ({own})</span>
              <StepInput
                decimals
                className="form-input h-9 text-right tabular-nums"
                value={r.factor}
                onValueChange={(v) => setRow(i, { factor: v })}
                placeholder="20"
                aria-label={`How many ${own} pack ${i + 1} holds`}
              />
            </label>
            <label className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground" title="A new purchase order line starts in this pack">
              <input type="radio" name="usual-pack" checked={r.isDefault} onChange={() => setRow(i, { isDefault: true })} aria-label={`Pack ${i + 1} is the usual one`} />
              Usual
            </label>
            <button type="button" className="btn-ghost h-9 px-2 text-muted-foreground" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove pack ${i + 1}`}>
              <Trash2 size={15} />
            </button>
            {r.uomId && Number(r.factor) > 0 && (
              <p className="col-span-4 -mt-1 text-[11px] text-muted-foreground">
                1 {symbolOf(r.uomId)} = {Number(r.factor).toLocaleString('en-IN')} {own}
                {r.isDefault ? ' · a new purchase order line starts in it' : ''}
              </p>
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary h-8 px-3 text-xs"
          onClick={() => setRows((rs) => [...rs, { uomId: '', factor: '', isDefault: rs.length === 0 }])}
        >
          <Plus size={14} /> Add a pack
        </button>
        {rows.length > 0 && !rows.some((r) => r.isDefault) && (
          <p className="text-[11px] text-muted-foreground">No pack is the usual one, so a new purchase order line starts in {own}.</p>
        )}
      </div>
    </FormFrame>
  )
}
