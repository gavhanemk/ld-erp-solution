'use client'

import { Code128 } from '@/components/packages/Code128'

/*
 * The finished-goods barcode sticker, as the mill's buyers have it printed
 * (SleepZ for Raymond) and as our own garments now carry it too: the barcode
 * with its text at the top left, the brand and the article at the top right;
 * product, month and year made, MRP inclusive of taxes, size; net quantity
 * and who markets it on the right; the consumer-complaints lines along the
 * bottom. Nine to an A4 sheet, landscape.
 */

export interface StickerFace {
  key: string
  code: string
  brand: string
  articleColour: string
  product: string
  mfd: string
  netQty: number
  mrp: number | null
  sizeText: string
  /** The second line under the size: the brand's own size ("Brand Ref. : L"), or for ours the colour. */
  refLabel: string
  refValue: string
  marketedBy: string[]
  complaints: string
  /** "Toll Free no." on a buyer's sticker; ours names its customer-care number. */
  phoneLabel: string
  phone: string
  email: string
  website: string
  /** The number at the bottom right. */
  refNo: string | null
}

const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })

/** A long brand name is set smaller, so it never runs into the barcode. */
const brandSize = (brand: string) => (brand.length <= 9 ? '18pt' : brand.length <= 13 ? '14pt' : '11.5pt')

/** An address as at most `lines` short lines, broken at its commas: how a sticker sets it. */
export function addressLines(address: string, width = 34, lines = 3): string[] {
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (last !== undefined && (last + ', ' + p).length <= width) out[out.length - 1] = `${last}, ${p}`
    else out.push(p)
  }
  return out.slice(0, lines).map((l, i, a) => (i < a.length - 1 ? `${l},` : l))
}

export function BarcodeSticker({ s }: { s: StickerFace }) {
  return (
    <div className="bl">
      <div className="bl-top">
        <div className="bl-code">
          <Code128 text={s.code} height="9mm" />
          <div className="bl-codetext">{s.code}</div>
        </div>
        <div className="bl-brand">
          <div className="bl-brandname" style={{ fontSize: brandSize(s.brand) }}>
            {s.brand}
          </div>
          <div className="bl-article">{s.articleColour}</div>
        </div>
      </div>
      {/* Across the whole sticker: a product name can be longer than "Kurta". */}
      <div className="bl-product">
        PRODUCT :&nbsp; <span className="bl-val">{s.product}</span>
      </div>
      <div className="bl-mid">
        <div className="bl-left">
          <div>Mfg. Month &amp; Year : {s.mfd}</div>
          <div className="bl-mrp">MRP: ₹ {s.mrp != null ? money(s.mrp) : '—'}</div>
          <div className="bl-incl">(Incl. of all taxes)</div>
          <div>
            Size :&nbsp;&nbsp; <span className="bl-val">{s.sizeText}</span>
          </div>
          {s.refValue && (
            <div>
              {s.refLabel} :&nbsp;&nbsp; <span className="bl-val">{s.refValue}</span>
            </div>
          )}
        </div>
        <div className="bl-right">
          <div className="bl-net">NET QTY.:&nbsp;&nbsp;&nbsp; {s.netQty} N</div>
          <div className="bl-mkt">
            {s.marketedBy.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      </div>
      <div className="bl-foot">
        {s.complaints && <div className="bl-care">For Consumer Complaints: {s.complaints}</div>}
        {s.phone && (
          <div>
            {s.phoneLabel} : {s.phone}
          </div>
        )}
        <div className="bl-mailrow">
          <span>{s.email ? `E-Mail : ${s.email}` : ''}</span>
          {s.refNo && <span className="bl-ref">{s.refNo}</span>}
        </div>
        {s.website && <div>Website : {s.website}</div>}
      </div>
    </div>
  )
}

/** The sticker's look and the A4 sheet it sits on, nine to a page. */
export const BARCODE_STICKER_CSS = `
  .bl-sheet { width: 297mm; height: 210mm; margin: 0 auto 12px; background: #fff; display: grid;
              grid-template-columns: repeat(3, 99mm); grid-template-rows: repeat(3, 70mm); box-sizing: border-box; }
  .bl { box-sizing: border-box; width: 99mm; height: 70mm; padding: 4.5mm 4mm 3mm 4.5mm; overflow: hidden; color: #000; background: #fff;
        font-family: Arial, Helvetica, sans-serif; font-weight: 700; font-size: 7.8pt; line-height: 1.2; border: 0.2mm dashed #ccc;
        display: flex; flex-direction: column; }
  .bl-top { display: flex; align-items: flex-start; gap: 3mm; }
  .bl-code { width: 51mm; flex-shrink: 0; }
  .bl-codetext { text-align: center; font-size: 7pt; font-weight: 400; letter-spacing: .02em; margin-top: 0.3mm; }
  .bl-brand { flex: 1; min-width: 0; text-align: right; }
  .bl-brandname { line-height: 1; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bl-article { font-size: 10.5pt; margin-top: 1.2mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bl-product { margin-top: 1.4mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bl-mid { display: flex; gap: 2mm; }
  .bl-left { width: 44mm; flex-shrink: 0; }
  .bl-left > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bl-val { font-weight: 700; }
  .bl-mrp { font-size: 12pt; margin-top: 0.7mm; line-height: 1.05; }
  .bl-incl { font-size: 6.3pt; margin-bottom: 0.5mm; }
  .bl-right { flex: 1; min-width: 0; }
  .bl-net { font-size: 8pt; margin-top: 0.4mm; margin-bottom: 2.8mm; white-space: nowrap; }
  .bl-mkt { font-size: 6.9pt; line-height: 1.14; }
  .bl-mkt > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bl-mkt > div:first-child { font-size: 7.4pt; }
  .bl-foot { font-size: 6.6pt; line-height: 1.22; margin-top: 1.2mm; }
  .bl-care { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .bl-mailrow { display: flex; justify-content: space-between; gap: 2mm; }
  .bl-ref { font-size: 8pt; margin-right: 9mm; }
  @media print {
    .bl-sheet { margin: 0; break-after: page; }
    .bl { border: 0; }
    .bl, .bl * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`
