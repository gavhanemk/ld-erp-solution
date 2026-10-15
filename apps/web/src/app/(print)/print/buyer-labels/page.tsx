'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { BARCODE_STICKER_CSS, BarcodeSticker, type StickerFace } from '@/components/print/BarcodeSticker'
import { buyerBarcode, mfdText, parseCounts, type BuyerLabelData } from '@/components/inventory/buyerLabels'

/** Buyer stickers for an order, nine to an A4 sheet, as many of each size as the setup window asked for. */
function Sheets() {
  const params = useSearchParams()
  const moId = params.get('moId')
  const [data, setData] = useState<BuyerLabelData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!moId) {
      setError('Open the buyer stickers from Inventory → Garment Tags.')
      return
    }
    api
      .get<{ data: BuyerLabelData }>(`/garments/buyer-labels/${moId}`)
      .then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the order.'))
  }, [moId])

  if (error) return <p style={{ padding: 48, color: '#fff' }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: '#ddd' }}>Opening the stickers…</p>

  const counts = parseCounts(params.get('c'))
  const mfd = new Date(data.mfd)
  const p = data.profile
  const refNo = p.refSource === 'PO' ? data.so.poRef : p.refSource === 'FIXED' ? p.refValue || null : null
  const stickers: StickerFace[] = []
  for (const l of data.lines) {
    for (const z of l.sizes) {
      const n = counts[`${l.soLineId}~${z.sizeId}`] ?? 0
      const one: Omit<StickerFace, 'key'> = {
        code: buyerBarcode(p.barcodePattern, { position: z.position, code: z.code, article: l.info.article, colour: l.info.colour, mfd }),
        brand: p.brand || data.customer.name,
        articleColour: [l.info.article, l.info.colour].filter(Boolean).join('-'),
        product: l.info.product,
        mfd: mfdText(mfd),
        netQty: l.info.packQty,
        mrp: l.info.mrp,
        sizeText: p.sizes[z.sizeId]?.text || z.text,
        refLabel: 'Brand Ref.',
        refValue: p.sizes[z.sizeId]?.ref ?? z.ref,
        marketedBy: p.marketedBy.split('\n').map((x) => x.trim()).filter(Boolean),
        complaints: p.complaints,
        phoneLabel: 'Toll Free no.',
        phone: p.tollFree,
        email: p.email,
        website: p.website,
        refNo,
      }
      for (let i = 0; i < n; i++) stickers.push({ ...one, key: `${l.soLineId}-${z.sizeId}-${i}` })
    }
  }
  if (!stickers.length) return <p style={{ padding: 48, color: '#fff' }}>No stickers asked for. Set how many of each size in the buyer stickers window.</p>
  const pages: StickerFace[][] = []
  for (let i = 0; i < stickers.length; i += 9) pages.push(stickers.slice(i, i + 9))

  return (
    <>
      <style>{`
        .print-toolbar {
          display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
          max-width: 297mm; margin: 0 auto 12px; padding: 8px 12px;
          background: #fff; border-radius: 6px; font: 13px Inter, system-ui, sans-serif; color: #1f2b3d;
        }
        .print-toolbar .tb-hint { color: #5a6880; font-size: 12px; margin-right: auto; }
        .print-toolbar .tb-btn {
          display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
          border: 1px solid #aebfd6; border-radius: 6px; background: #fff; color: #173a6c;
          font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer;
        }
        .print-toolbar .tb-primary { background: #173a6c; border-color: #173a6c; color: #fff; }
        ${BARCODE_STICKER_CSS}
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
        }
        @page { size: A4 landscape; margin: 0; }
      `}</style>
      <PrintToolbar backHref="/inventory/garment-tags" backLabel="Garment Tags" copies={1} fileName={`Buyer stickers ${data.mo.moNumber}`} />
      <p className="no-print" style={{ maxWidth: '297mm', margin: '0 auto 12px', color: '#ddd', font: '12px Inter, system-ui, sans-serif' }}>
        {stickers.length} {stickers.length === 1 ? 'sticker' : 'stickers'} for {data.mo.moNumber} ({data.customer.name}) on {pages.length} A4 {pages.length === 1 ? 'sheet' : 'sheets'}, 9 to a sheet.
      </p>
      {pages.map((page, i) => (
        <div key={i} className="bl-sheet">
          {page.map((s) => (
            <BarcodeSticker key={s.key} s={s} />
          ))}
        </div>
      ))}
    </>
  )
}

export default function PrintBuyerLabels() {
  return (
    <Suspense fallback={<p style={{ padding: 48, color: '#ddd' }}>Opening the stickers…</p>}>
      <Sheets />
    </Suspense>
  )
}
