'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Printer, Settings2, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { PACK_TYPES } from './packageTypes'

/*
 * How each kind of package's sticker looks — one for rolls, one for boxes,
 * bundles, cartons…, anything not set following "Any package": its size, its
 * codes, what it shows, how big the writing is, the company logo or not, and
 * how many copies print. The print page starts from these; it can still be
 * changed there for one print.
 */

export interface StickerTemplate {
  size: 'sheet' | 'roll' | 'small' | 'custom'
  width?: number | null
  height?: number | null
  codes: 'both' | 'qr' | 'barcode'
  fields: string[]
  font: 'S' | 'M' | 'L'
  logo: boolean
  copies: number
}
type Templates = Record<string, StickerTemplate>

const KINDS = [{ value: 'DEFAULT', label: 'Any package' }, ...PACK_TYPES.map((p) => ({ value: p.value, label: p.label }))]
// Quantity is always on a sticker: the rest can be left off.
const FIELDS: Array<{ key: string; label: string }> = [
  { key: 'itemCode', label: 'Item code' },
  { key: 'style', label: 'Style' },
  { key: 'contents', label: 'What is inside (pieces in a box)' },
  { key: 'lot', label: 'Lot / roll no.' },
  { key: 'rack', label: 'Rack' },
  { key: 'challan', label: 'Challan no.' },
  { key: 'document', label: 'GRN / document no. and date' },
  { key: 'po', label: 'PO no.' },
  { key: 'supplier', label: 'Supplier' },
  { key: 'store', label: 'Store' },
  { key: 'notes', label: 'Note' },
  { key: 'packNo', label: 'Package 2 of 5' },
]
const SIZES = [
  { value: 'sheet', label: 'A4 sheet, 24 a page (70 × 37 mm)' },
  { value: 'roll', label: 'Label printer, 75 × 50 mm' },
  { value: 'small', label: 'Label printer, 50 × 25 mm' },
  { value: 'custom', label: 'Label printer, another size' },
]

export function StickerSettings({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }) {
  const [templates, setTemplates] = useState<Templates | null>(null)
  const [hasLogo, setHasLogo] = useState(false)
  const [kind, setKind] = useState('DEFAULT')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEscape(() => {
    if (!busy) onClose()
  })

  useEffect(() => {
    api
      .get<{ data: { templates: Templates; hasLogo: boolean } }>('/packages/templates')
      .then((r) => {
        setTemplates(r.data.templates)
        setHasLogo(r.data.hasLogo)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the sticker settings.'))
  }, [])

  const t = templates?.[kind]
  const set = (patch: Partial<StickerTemplate>) => setTemplates((all) => all && { ...all, [kind]: { ...all[kind], ...patch } })
  const toggleField = (key: string, on: boolean) => t && set({ fields: on ? [...t.fields.filter((f) => f !== key), key] : t.fields.filter((f) => f !== key) })

  const save = async () => {
    if (!templates) return
    const bad = Object.entries(templates).find(([, v]) => v.size === 'custom' && !(Number(v.width) >= 20 && Number(v.height) >= 15))
    if (bad) {
      setKind(bad[0])
      return setError('A custom size needs its width (20–150 mm) and height (15–150 mm).')
    }
    setBusy(true)
    setError(null)
    try {
      const clean = Object.fromEntries(
        Object.entries(templates).map(([k, v]) => [k, { ...v, width: v.size === 'custom' ? Number(v.width) : null, height: v.size === 'custom' ? Number(v.height) : null }]),
      )
      const res = await api.patch<{ message: string }>('/packages/templates', { templates: clean })
      onSaved(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the sticker settings.')
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:left-[var(--sidebar-current-width)]">
      <div className="glass-card flex max-h-full w-full max-w-3xl flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="sticker-settings-title">
        <div className="flex items-start gap-3 p-5 pb-3">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <Settings2 size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="sticker-settings-title" className="text-foreground text-lg font-semibold">
              Sticker settings
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">How each kind of package&apos;s sticker prints. Anything not set for a kind follows &quot;Any package&quot;.</p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </div>

        {!templates ? (
          <p className="text-muted-foreground flex items-center gap-2 px-5 pb-5 text-sm">
            {error ?? (
              <>
                <Loader2 size={15} className="animate-spin" /> Loading…
              </>
            )}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-5">
            <ul className="w-36 shrink-0 space-y-0.5 overflow-y-auto" role="tablist" aria-label="Kind of package">
              {KINDS.map((k) => (
                <li key={k.value}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={kind === k.value}
                    className={cn('w-full rounded-lg px-3 py-1.5 text-left text-sm', kind === k.value ? 'bg-primary/10 text-primary font-semibold' : 'text-muted-foreground hover:text-foreground')}
                    onClick={() => setKind(k.value)}
                  >
                    {k.label}
                  </button>
                </li>
              ))}
            </ul>
            {t && (
              <div className="min-w-0 flex-1 space-y-4 overflow-y-auto pb-2">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-foreground font-medium">Size</span>
                    <SmartSelect className="form-input" value={t.size} onChange={(e) => set({ size: e.target.value as StickerTemplate['size'] })} aria-label="Sticker size">
                      {SIZES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </SmartSelect>
                  </label>
                  {t.size === 'custom' && (
                    <div className="flex items-end gap-2 text-sm">
                      <label className="space-y-1">
                        <span className="text-foreground font-medium">Width (mm)</span>
                        <StepInput className="form-input w-24 text-right" value={t.width ? String(t.width) : ''} min={0} max={150} onValueChange={(v) => set({ width: v ? Number(v) : null })} aria-label="Width in mm" />
                      </label>
                      <span className="text-muted-foreground pb-2">×</span>
                      <label className="space-y-1">
                        <span className="text-foreground font-medium">Height (mm)</span>
                        <StepInput className="form-input w-24 text-right" value={t.height ? String(t.height) : ''} min={0} max={150} onValueChange={(v) => set({ height: v ? Number(v) : null })} aria-label="Height in mm" />
                      </label>
                    </div>
                  )}
                  <label className="space-y-1 text-sm">
                    <span className="text-foreground font-medium">Codes</span>
                    <SmartSelect className="form-input" value={t.codes} onChange={(e) => set({ codes: e.target.value as StickerTemplate['codes'] })} aria-label="Codes">
                      <option value="both">QR code and barcode</option>
                      <option value="qr">QR code only</option>
                      <option value="barcode">Barcode only</option>
                    </SmartSelect>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-foreground font-medium">Writing</span>
                    <SmartSelect className="form-input" value={t.font} onChange={(e) => set({ font: e.target.value as StickerTemplate['font'] })} aria-label="Writing size">
                      <option value="S">Small</option>
                      <option value="M">Medium</option>
                      <option value="L">Large</option>
                    </SmartSelect>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-foreground font-medium">Copies of each sticker</span>
                    <StepInput className="form-input w-24 text-right" value={String(t.copies)} min={1} max={5} onValueChange={(v) => set({ copies: Math.min(5, Math.max(1, Number(v) || 1)) })} aria-label="Copies" />
                    <span className="text-muted-foreground block text-xs">An item can ask for more in Masters → Items.</span>
                  </label>
                  <label className="flex items-center gap-2 self-end text-sm">
                    <input type="checkbox" checked={t.logo} onChange={(e) => set({ logo: e.target.checked })} />
                    <span className="text-foreground">Company logo</span>
                    {!hasLogo && <span className="text-muted-foreground text-xs">(none uploaded yet — Settings → Company)</span>}
                  </label>
                </div>
                <fieldset className="space-y-1.5">
                  <legend className="text-foreground mb-1 text-sm font-medium">What it shows (the quantity always)</legend>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {FIELDS.map((f) => (
                      <label key={f.key} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={t.fields.includes(f.key)} onChange={(e) => toggleField(f.key, e.target.checked)} />
                        <span className="text-foreground">{f.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}
          </div>
        )}

        {error && templates && (
          <p className="px-5 pt-2 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 p-5">
          <span className="text-muted-foreground mr-auto flex items-center gap-1 text-xs">
            <Printer size={12} /> Each print can still change the size or codes for that print.
          </span>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !templates}>
            {busy && <Loader2 size={15} className="animate-spin" />} Save settings
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
