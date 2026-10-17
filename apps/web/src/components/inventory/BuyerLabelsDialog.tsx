'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Barcode, Loader2, Printer, Save, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { StepInput } from '@/components/ui/StepInput'
import { useEscape } from '@/lib/useEscape'
import {
  PATTERN_PARTS,
  buyerBarcode,
  countsParam,
  defaultCount,
  mfdText,
  type BuyerLabelData,
  type LabelLineInfo,
  type LabelProfile,
} from './buyerLabels'

const key = (lineId: string, sizeId: string) => `${lineId}~${sizeId}`

/**
 * Setting up and printing one order's buyer stickers — the barcode sticker the
 * buyer's brand wants on each garment or pack (SleepZ for Raymond). The
 * customer's part is kept for every order; each line's part on the order. How
 * many to print starts at what is packed, a sticker a garment or a pack.
 */
export function BuyerLabelsDialog({ moId, onClose, onSaved }: { moId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [data, setData] = useState<BuyerLabelData | null>(null)
  const [profile, setProfile] = useState<LabelProfile | null>(null)
  const [infos, setInfos] = useState<Record<string, LabelLineInfo>>({})
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState<'save' | 'print' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const editor = can('inventory', 'edit')

  const take = (d: BuyerLabelData) => {
    setData(d)
    setProfile(d.profile)
    setInfos(Object.fromEntries(d.lines.map((l) => [l.soLineId, l.info])))
    setCounts(Object.fromEntries(d.lines.flatMap((l) => l.sizes.map((z) => [key(l.soLineId, z.sizeId), defaultCount(z.packed, l.info.packQty)]))))
  }
  useEffect(() => {
    api
      .get<{ data: BuyerLabelData }>(`/garments/buyer-labels/${moId}`)
      .then((r) => take(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open the buyer stickers.'))
  }, [moId])
  // Escape closes this window only — not the ones behind it.
  useEscape(() => {
    if (!busy) onClose()
  })

  const mfd = useMemo(() => (data ? new Date(data.mfd) : new Date()), [data])
  const setP = (patch: Partial<LabelProfile>) => setProfile((p) => (p ? { ...p, ...patch } : p))
  const setInfo = (lineId: string, patch: Partial<LabelLineInfo>) => {
    setInfos((x) => ({ ...x, [lineId]: { ...x[lineId], ...patch } }))
    // A new pack size: the counts start again from what is packed.
    if (patch.packQty && data) {
      const line = data.lines.find((l) => l.soLineId === lineId)
      if (line) setCounts((c) => ({ ...c, ...Object.fromEntries(line.sizes.map((z) => [key(lineId, z.sizeId), defaultCount(z.packed, patch.packQty!)])) }))
    }
  }
  const setSize = (sizeId: string, patch: Partial<{ text: string; ref: string }>) =>
    setProfile((p) => (p ? { ...p, sizes: { ...p.sizes, [sizeId]: { text: p.sizes[sizeId]?.text ?? '', ref: p.sizes[sizeId]?.ref ?? '', ...patch } } } : p))

  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  const sample = data?.lines[0]
  const sampleSize = sample?.sizes[0]
  const preview =
    profile && sample && sampleSize
      ? buyerBarcode(profile.barcodePattern, { position: sampleSize.position, code: sampleSize.code, article: infos[sample.soLineId]?.article ?? '', colour: infos[sample.soLineId]?.colour ?? '', mfd })
      : ''

  const save = async (andPrint: boolean) => {
    if (!data || !profile) return
    // The print tab opens on the click, or the browser blocks it as a pop-up.
    const tab = andPrint ? window.open('about:blank', '_blank') : null
    setBusy(andPrint ? 'print' : 'save')
    setError(null)
    try {
      // Every size's wording goes with the customer, filled from the screen.
      const sizes = { ...profile.sizes }
      for (const l of data.lines) for (const z of l.sizes) sizes[z.sizeId] = { text: profile.sizes[z.sizeId]?.text ?? z.text, ref: profile.sizes[z.sizeId]?.ref ?? z.ref }
      const res = editor
        ? await api.patch<{ message: string; data: BuyerLabelData }>(`/garments/buyer-labels/${moId}`, {
            profile: { ...profile, sizes },
            lines: data.lines.map((l) => ({ soLineId: l.soLineId, info: { ...infos[l.soLineId], mrp: infos[l.soLineId].mrp == null ? null : Number(infos[l.soLineId].mrp) } })),
          })
        : null
      if (andPrint) {
        const url = `/print/buyer-labels?moId=${moId}&c=${encodeURIComponent(countsParam(counts))}`
        if (tab && !tab.closed) tab.location.href = url
        else window.open(url, '_blank')
      }
      onSaved(res?.message ?? 'Buyer stickers opened.')
    } catch (err) {
      tab?.close()
      setError(err instanceof ApiError ? err.message : 'Could not save the sticker details.')
    } finally {
      setBusy(null)
    }
  }

  const field = (label: string, el: React.ReactNode, wide = false) => (
    <label className={`block min-w-0 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="form-label">{label}</span>
      {el}
    </label>
  )

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 backdrop-blur-sm sm:left-[var(--sidebar-current-width)] sm:p-3">
      <div className="glass-card po-form flex h-full max-h-full w-full max-w-5xl flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="buyer-labels-title">
        <div className="border-border flex shrink-0 items-start gap-3 border-b px-5 py-3.5">
          <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
            <Barcode size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="buyer-labels-title" className="text-foreground text-lg font-semibold">
              Buyer stickers{data ? ` · ${data.mo.moNumber}` : ''}
            </h2>
            <p className="text-muted-foreground text-sm">
              {data
                ? `${data.customer.name} · ${data.so.soNumber}${data.so.poRef ? ` · PO ${data.so.poRef}` : ''} · made ${mfdText(mfd)}`
                : 'The barcode sticker the buyer’s brand wants on each garment or pack'}
            </p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close" disabled={!!busy}>
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          {error && <p className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-500">{error}</p>}
          {!data || !profile ? (
            !error && (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 size={15} className="animate-spin" /> Opening the order…
              </p>
            )
          ) : (
            <>
              <section className="border-border rounded-xl border p-4">
                <h3 className="text-foreground text-sm font-semibold">{data.customer.name}&apos;s sticker</h3>
                <p className="text-muted-foreground mb-3 text-xs">Kept with the customer and used on every order of theirs.</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {field('Brand on the sticker', <input className="form-input" value={profile.brand} maxLength={60} placeholder="e.g. SleepZ" onChange={(e) => setP({ brand: e.target.value })} />)}
                  {field(
                    'Number at the bottom right',
                    <div className="flex gap-2">
                      <SmartSelect className="form-input" value={profile.refSource} onChange={(e) => setP({ refSource: e.target.value as LabelProfile['refSource'] })} aria-label="Number at the bottom right">
                        <option value="PO" data-sub={data.so.poRef ? `On this order: ${data.so.poRef}` : 'Not on this order yet'}>
                          Buyer&apos;s PO number
                        </option>
                        <option value="FIXED">A number I type</option>
                        <option value="NONE">Nothing</option>
                      </SmartSelect>
                      {profile.refSource === 'FIXED' && (
                        <input className="form-input" value={profile.refValue} maxLength={40} placeholder="e.g. 4700048205" onChange={(e) => setP({ refValue: e.target.value })} aria-label="The number" />
                      )}
                    </div>,
                  )}
                  {field(
                    'Marketed by — name and address',
                    <textarea className="form-input min-h-[72px]" value={profile.marketedBy} maxLength={400} placeholder={'RAYMOND LIFESTYLE LIMITED\nPlot No. G-35 & 36, MIDC Waluj…'} onChange={(e) => setP({ marketedBy: e.target.value })} />,
                  )}
                  {field(
                    'For consumer complaints',
                    <textarea className="form-input min-h-[72px]" value={profile.complaints} maxLength={600} placeholder="Raymond Lifestyle Limited, Consumer Care Cell Manager, …" onChange={(e) => setP({ complaints: e.target.value })} />,
                  )}
                  <div className="grid grid-cols-1 gap-3 sm:col-span-2 sm:grid-cols-3">
                    {field('Toll free no.', <input className="form-input" value={profile.tollFree} maxLength={60} placeholder="1800222001" onChange={(e) => setP({ tollFree: e.target.value })} />)}
                    {field('E-mail', <input className="form-input" value={profile.email} maxLength={120} onChange={(e) => setP({ email: e.target.value })} />)}
                    {field('Website', <input className="form-input" value={profile.website} maxLength={120} placeholder="www.raymondlifestyle.com" onChange={(e) => setP({ website: e.target.value })} />)}
                  </div>
                  {field(
                    'Barcode pattern',
                    <>
                      <input className="form-input font-mono" value={profile.barcodePattern} maxLength={80} onChange={(e) => setP({ barcodePattern: e.target.value })} />
                      <span className="text-muted-foreground mt-1 block text-[11px]">
                        {PATTERN_PARTS.map((p) => `${p.token} ${p.means}`).join(' · ')}. Anything else prints as typed.
                      </span>
                      {preview && (
                        <span className="text-foreground mt-1 block text-xs">
                          First size reads <span className="bg-secondary rounded px-1.5 py-0.5 font-mono font-semibold">{preview}</span>
                        </span>
                      )}
                    </>,
                    true,
                  )}
                </div>
              </section>

              {data.lines.map((l) => {
                const info = infos[l.soLineId]
                return (
                  <section key={l.soLineId} className="border-border rounded-xl border p-4">
                    <h3 className="text-foreground text-sm font-semibold">
                      <span className="font-mono text-xs">{l.itemCode}</span> — {l.itemName}
                    </h3>
                    <p className="text-muted-foreground mb-3 text-xs">
                      {l.style} · {l.color}
                      {l.sizeGroup ? ` · ${l.sizeGroup}` : ''}
                    </p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                      {field('Article code', <input className="form-input font-mono" value={info.article} maxLength={40} placeholder="AEAA00014" onChange={(e) => setInfo(l.soLineId, { article: e.target.value })} />)}
                      {field('Colour code', <input className="form-input font-mono" value={info.colour} maxLength={20} placeholder="M8" onChange={(e) => setInfo(l.soLineId, { colour: e.target.value })} />)}
                      {field('Product', <input className="form-input" value={info.product} maxLength={60} placeholder="Kurta" onChange={(e) => setInfo(l.soLineId, { product: e.target.value })} />)}
                      {field(
                        'MRP ₹',
                        <StepInput className="form-input text-right" value={info.mrp == null ? '' : String(info.mrp)} decimals onValueChange={(v) => setInfo(l.soLineId, { mrp: v === '' ? null : Number(v) })} aria-label={`MRP of ${l.itemCode}`} />,
                      )}
                      {field(
                        'Pieces to a sticker',
                        <StepInput className="form-input text-right" value={String(info.packQty)} onValueChange={(v) => setInfo(l.soLineId, { packQty: Math.max(1, Math.floor(Number(v) || 1)) })} aria-label={`Pieces to a sticker for ${l.itemCode}`} />,
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 text-[11px]">
                      {info.packQty > 1 ? `One sticker on each pack of ${info.packQty} — Net Qty ${info.packQty} N.` : 'One sticker on each garment — Net Qty 1 N.'}
                    </p>
                    <div className="border-border mt-3 overflow-x-auto rounded-lg border">
                      <table className="data-table table-compact w-full">
                        <thead>
                          <tr className="bg-secondary">
                            <th>Size</th>
                            <th>Printed as</th>
                            <th>Brand ref.</th>
                            <th style={{ textAlign: 'right' }}>Packed</th>
                            <th style={{ textAlign: 'right' }}>Stickers</th>
                            <th>Barcode</th>
                          </tr>
                        </thead>
                        <tbody>
                          {l.sizes.map((z) => {
                            const k = key(l.soLineId, z.sizeId)
                            return (
                              <tr key={z.sizeId}>
                                <td className="whitespace-nowrap font-semibold">{z.code}</td>
                                <td>
                                  <input className="form-input h-8 w-40 text-xs" value={profile.sizes[z.sizeId]?.text ?? z.text} maxLength={40} placeholder="42 cm (CHEST)" onChange={(e) => setSize(z.sizeId, { text: e.target.value })} aria-label={`Size ${z.code} printed as`} />
                                </td>
                                <td>
                                  <input className="form-input h-8 w-20 text-xs" value={profile.sizes[z.sizeId]?.ref ?? z.ref} maxLength={20} placeholder="L" onChange={(e) => setSize(z.sizeId, { ref: e.target.value })} aria-label={`Size ${z.code} brand ref`} />
                                </td>
                                <td className="text-right tabular-nums">{z.packed || <span className="text-muted-foreground">—</span>}</td>
                                <td className="text-right">
                                  <StepInput className="form-input ml-auto h-8 w-20 text-right text-xs" value={String(counts[k] ?? 0)} onValueChange={(v) => setCounts((c) => ({ ...c, [k]: Math.max(0, Math.floor(Number(v) || 0)) }))} aria-label={`Stickers for size ${z.code}`} />
                                </td>
                                <td className="whitespace-nowrap font-mono text-[11px]">
                                  {buyerBarcode(profile.barcodePattern, { position: z.position, code: z.code, article: info.article, colour: info.colour, mfd })}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )
              })}
            </>
          )}
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
          <span className="text-muted-foreground mr-auto text-xs">
            {total} {total === 1 ? 'sticker' : 'stickers'} · A4, 9 to a page{total ? ` · ${Math.ceil(total / 9)} ${Math.ceil(total / 9) === 1 ? 'page' : 'pages'}` : ''}
          </span>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          {editor && (
            <button type="button" className="btn-secondary" onClick={() => void save(false)} disabled={!data || !!busy}>
              {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
            </button>
          )}
          <button type="button" className="btn-primary" onClick={() => void save(true)} disabled={!data || !!busy || !total}>
            {busy === 'print' ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />} {editor ? 'Save & print' : 'Print'} {total || ''}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
