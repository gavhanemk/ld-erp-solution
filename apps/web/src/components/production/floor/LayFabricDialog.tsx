'use client'

import { useState } from 'react'
import { Loader2, Ruler, Save } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { FormFrame } from '@/components/ui/FormFrame'
import { Section } from '@/components/purchase/Section'
import { StepInput } from '@/components/ui/StepInput'
import { fabricQty, type JobCardCutting } from './types'

/**
 * A received lay's fabric put right — what the contractor was given, used and
 * wasted — so what is left over with them reads true. Only the record
 * changes: the lay's pieces and bundles stay as they are.
 */

const num = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)))

export function LayFabricDialog({ lay, onClose, onSaved }: { lay: JobCardCutting; onClose: () => void; onSaved: (message: string) => void }) {
  const [given, setGiven] = useState(num(lay.fabricIssued))
  const [used, setUsed] = useState(num(lay.fabricUsed))
  const [waste, setWaste] = useState(num(lay.wastage))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const unit = lay.fabricItem?.uom?.symbol ?? ''
  const who = lay.cutterName ?? 'the contractor'
  const n = (v: string) => Number(v) || 0
  const g = given.trim() === '' ? null : n(given)
  const left = g == null ? null : Math.round((g - n(used) - n(waste)) * 1000) / 1000
  const note =
    g == null
      ? { warn: false, text: `Put in the fabric given to ${who} to see what is left over with them.` }
      : left! > 0
        ? { warn: true, text: `${fabricQty(left!, unit)} left over with ${who}.` }
        : left! < 0
          ? { warn: true, text: `Used and waste come to ${fabricQty(-left!, unit)} more than the ${fabricQty(g, unit)} given.` }
          : { warn: false, text: `All ${fabricQty(g, unit)} given is accounted for.` }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await api.patch<{ message?: string }>(`/production/cutting/${lay.id}/fabric`, { fabricGiven: g, fabricUsed: n(used), wastage: n(waste) })
      onSaved(res.message ?? 'Saved.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the fabric.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormFrame
      icon={Ruler}
      title={`Fabric on ${lay.cutOrderNumber}`}
      subtitle={`${who}${lay.fabricItem ? ` · ${lay.fabricItem.name}` : ''} · received — only the fabric record changes`}
      width="max-w-2xl"
      primary={
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
        </button>
      }
      footer={
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      }
      footerNote="The pieces and bundles of this lay stay as they are."
      error={error}
      onClose={onClose}
      busy={saving}
    >
      <Section icon={Ruler} title="Fabric">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-4">
          <label className="block">
            <span className="form-label">Given{unit ? ` (${unit})` : ''}</span>
            <StepInput decimals className="form-input text-right tabular-nums" value={given} placeholder="0" onValueChange={setGiven} aria-label="Fabric given" />
          </label>
          <label className="block">
            <span className="form-label">Used{unit ? ` (${unit})` : ''}</span>
            <StepInput decimals className="form-input text-right tabular-nums" value={used} placeholder="0" onValueChange={setUsed} aria-label="Fabric used" />
          </label>
          <label className="block">
            <span className="form-label">Waste{unit ? ` (${unit})` : ''}</span>
            <StepInput decimals className="form-input text-right tabular-nums" value={waste} placeholder="0" onValueChange={setWaste} aria-label="Cut waste" />
          </label>
          <div className="block">
            <span className="form-label">Left over{unit ? ` (${unit})` : ''}</span>
            <p
              className={`border-border flex min-h-[2.5rem] items-center justify-end rounded-lg border border-dashed px-3 text-sm font-semibold tabular-nums ${left ? 'warn-text' : 'text-foreground'}`}
              aria-label="Left over"
            >
              {left == null ? '—' : left.toLocaleString('en-IN', { maximumFractionDigits: 3 })}
            </p>
          </div>
          <p className={`text-xs sm:col-span-4 ${note.warn ? 'warn-text' : 'text-muted-foreground'}`}>{note.text}</p>
        </div>
      </Section>
    </FormFrame>
  )
}
