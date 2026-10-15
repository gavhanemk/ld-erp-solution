'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { Code128 } from '@/components/packages/Code128'
import { buyerBarcode, mfdText, parseCounts, type BuyerLabelData } from '@/components/inventory/buyerLabels'

interface Sticker {
  key: string
  code: string
  brand: string
  articleColour: string
  product: string
  mfd: string
  netQty: number
  mrp: number | null
  sizeText: string
  sizeRef: string
  marketedBy: string[]
  complaints: string
  tollFree: string
  email: string
  website: string
  refNo: string | null
}

const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })

/**
 * One buyer sticker, laid out as the buyer's own: the barcode with its text
 * under it at the top left, the brand and the article-colour at the top
 * right; product, month and year made, MRP inclusive of taxes, size and the
 * brand's own size; net quantity and who markets it on the right; the
 * consumer-complaints lines along the bottom.
 */
function BuyerSticker({ s }: { s: Sticker }) {
  return (
    <div className="bl">
      <div className="bl-top">
        <div className="bl-code">
          <Code128 text={s.code} height="9mm" />
          <div className="bl-codetext">{s.code}</div>
        </div>
        <div className="bl-brand">
          <div className="bl-brandname">{s.brand}</div>
          <div className="bl-article">{s.articleColour}</div>
        </div>
      </div>
      <div className="bl-mid">
        <div className="bl-left">
          <div>
            PRODUCT :&nbsp; <span className="bl-val">{s.product}</span>
          </div>
          <div>Mfg. Month &amp; Year : {s.mfd}</div>
          <div className="bl-mrp">MRP: ₹ {s.mrp != null ? money(s.mrp) : '—'}</div>
          <div className="bl-incl">(Incl. of all taxes)</div>
          <div>
            Size :&nbsp;&nbsp; <span className="bl-val">{s.sizeText}</span>
          </div>
          <div>
            Brand Ref. :&nbsp;&nbsp; <span className="bl-val">{s.sizeRef}</span>
          </div>
        </div>
        <div className="bl-right">
          <div className="bl-net">
            NET QTY.:&nbsp;&nbsp;&nbsp; {s.netQty} N
          </div>
          <div className="bl-mkt">
            {s.marketedBy.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      </div>
      <div className="bl-foot">
        {s.complaints && <div>For Consumer Complaints: {s.complaints}</div>}
        {s.tollFree && <div>Toll Free no. : {s.tollFree}</div>}
        <div className="bl-mailrow">
          <span>{s.email ? `E-Mail : ${s.email}` : ''}</span>
          {s.refNo && <span className="bl-ref">{s.refNo}</span>}
        </div>
        {s.website && <div>Website : {s.website}</div>}
      </div>
    </div>
  )
}

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
  const stickers: Sticker[] = []
  for (const l of data.lines) {
    for (const z of l.sizes) {
      const n = counts[`${l.soLineId}~${z.sizeId}`] ?? 0
      const one: Omit<Sticker, 'key'> = {
        code: buyerBarcode(p.barcodePattern, { position: z.position, code: z.code, article: l.info.article, colour: l.info.colour, mfd }),
        brand: p.brand || data.customer.name,
        articleColour: [l.info.article, l.info.colour].filter(Boolean).join('-'),
        product: l.info.product,
        mfd: mfdText(mfd),
        netQty: l.info.packQty,
        mrp: l.info.mrp,
        sizeText: p.sizes[z.sizeId]?.text || z.text,
        sizeRef: p.sizes[z.sizeId]?.ref ?? z.ref,
        marketedBy: p.marketedBy.split('\n').map((x) => x.trim()).filter(Boolean),
        complaints: p.complaints,
        tollFree: p.tollFree,
        email: p.email,
        website: p.website,
        refNo,
      }
      for (let i = 0; i < n; i++) stickers.push({ ...one, key: `${l.soLineId}-${z.sizeId}-${i}` })
    }
  }
  if (!stickers.length) return <p style={{ padding: 48, color: '#fff' }}>No stickers asked for. Set how many of each size in the buyer stickers window.</p>
  const pages: Sticker[][] = []
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
        .bl-sheet { width: 297mm; height: 210mm; margin: 0 auto 12px; background: #fff; display: grid;
                    grid-template-columns: repeat(3, 99mm); grid-template-rows: repeat(3, 70mm); box-sizing: border-box; }
        .bl { box-sizing: border-box; width: 99mm; height: 70mm; padding: 4.5mm 4mm 3mm 4.5mm; overflow: hidden; color: #000; background: #fff;
              font-family: Arial, Helvetica, sans-serif; font-weight: 700; font-size: 7.8pt; line-height: 1.2; border: 0.2mm dashed #ccc;
              display: flex; flex-direction: column; }
        .bl-top { display: flex; align-items: flex-start; gap: 3mm; }
        .bl-code { width: 51mm; flex-shrink: 0; }
        .bl-codetext { text-align: center; font-size: 7pt; font-weight: 400; letter-spacing: .02em; margin-top: 0.3mm; }
        .bl-brand { flex: 1; min-width: 0; text-align: right; }
        .bl-brandname { font-size: 18pt; line-height: 1; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bl-article { font-size: 10.5pt; margin-top: 1.2mm; white-space: nowrap; }
        .bl-mid { display: flex; gap: 2mm; margin-top: 1.4mm; }
        .bl-left { width: 44mm; flex-shrink: 0; }
        .bl-left > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bl-val { font-weight: 700; }
        .bl-mrp { font-size: 12pt; margin-top: 0.7mm; line-height: 1.05; }
        .bl-incl { font-size: 6.3pt; margin-bottom: 0.5mm; }
        .bl-right { flex: 1; min-width: 0; }
        .bl-net { font-size: 8pt; margin-top: 3.8mm; margin-bottom: 2.8mm; white-space: nowrap; }
        .bl-mkt { font-size: 6.9pt; line-height: 1.14; }
        .bl-mkt > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bl-mkt > div:first-child { font-size: 7.4pt; }
        .bl-foot { font-size: 6.6pt; line-height: 1.22; margin-top: 1.2mm; }
        .bl-mailrow { display: flex; justify-content: space-between; gap: 2mm; }
        .bl-ref { font-size: 8pt; margin-right: 9mm; }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
          .bl-sheet { margin: 0; break-after: page; }
          .bl { border: 0; }
          .bl, .bl * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
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
            <BuyerSticker key={s.key} s={s} />
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
