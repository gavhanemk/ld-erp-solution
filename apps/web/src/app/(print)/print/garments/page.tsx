'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { QrCode } from '@/components/packages/QrCode'
import { Code128 } from '@/components/packages/Code128'
import { Ean13 } from '@/components/packages/Ean13'
import { WashCareIcons } from '@/components/packages/WashCare'

interface Label {
  id: string
  code: string
  brand: string
  style: string
  description: string
  size: string
  color: string
  grade: string
  sku: string
  moNumber: string
  soNumber: string | null
  poRef: string | null
  buyer: string | null
  lot: string | null
  challan: string | null
  printed: boolean
  /** The retail tag's lines, sent when the retail tag is chosen. */
  retail?: { logoUrl: string | null; ean: string | null; mrp: number | null; composition: string | null; washCare: string[]; mfd: string }
}

/** Who made and sells it: the retail tag's legal lines. */
interface Maker {
  name: string
  address: string
  care: string
  origin: string
}

type Layout = 'tag' | 'poly' | 'sheet' | 'retail'
type TrackingLayout = Exclude<Layout, 'retail'>
/** What a piece's own code is printed as: a QR for a phone camera, a barcode for a handheld scanner, or both. */
type Codes = 'both' | 'qr' | 'bar'
const CODES: Record<Codes, string> = { both: 'QR code and barcode', qr: 'QR code only', bar: 'Barcode only' }

const SIZES: Record<Layout, { label: string; page: string }> = {
  retail: { label: 'Retail tag with MRP and barcode, 50 × 75 mm', page: '50mm 75mm' },
  tag: { label: 'Hang tag / sticker, 50 × 25 mm', page: '50mm 25mm' },
  poly: { label: 'Polybag sticker, 75 × 50 mm', page: '75mm 50mm' },
  sheet: { label: 'A4 sheet, 24 a page (70 × 37 mm)', page: 'A4' },
}

const clip = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const

// `qrBoth` is the QR's size with a barcode under it; `bar` the barcode's height
// beside a QR, `barOnly` without one.
const GDIM: Record<
  TrackingLayout,
  { qr: string; qrBoth: string; bar: string; barOnly: string; id: string; brand: string; style: string; size: string; line: string; desc: string; gap: string; rowGap: string }
> = {
  tag: { qr: '15.5mm', qrBoth: '11.5mm', bar: '4.5mm', barOnly: '4.8mm', id: '8pt', brand: '5pt', style: '6.8pt', size: '11pt', line: '5.3pt', desc: '0', gap: '1.5mm', rowGap: '0.1mm' },
  sheet: { qr: '23mm', qrBoth: '18mm', bar: '5.5mm', barOnly: '7mm', id: '10pt', brand: '5.8pt', style: '7pt', size: '12pt', line: '5.6pt', desc: '6.4pt', gap: '2mm', rowGap: '0.15mm' },
  poly: { qr: '31mm', qrBoth: '23mm', bar: '7.5mm', barOnly: '10mm', id: '12.5pt', brand: '7pt', style: '8.6pt', size: '16pt', line: '6.5pt', desc: '7.8pt', gap: '2.5mm', rowGap: '0.1mm' },
}

/** A named field on a label: "Customer Rajmandir Garments", the name small and grey. */
function Field({ k, v, size, bold = false }: { k: string; v: string; size: string; bold?: boolean }) {
  return (
    <div style={{ fontSize: size, lineHeight: 1.2, ...clip }}>
      <span style={{ fontSize: '0.8em', fontWeight: 600, color: '#555', letterSpacing: '.02em' }}>{k} </span>
      <span style={{ fontWeight: bold ? 800 : 500 }}>{v}</span>
    </div>
  )
}

/**
 * One garment's label, in the same shape as the package stickers: its own ID
 * large in the header (printed in full, so it can be typed if nothing will
 * scan), the QR at the left, a barcode of the same ID along the bottom — or
 * either alone — and beside them every field named: style, size, colour and
 * grade, customer, order, lot and MO, and the delivery challan once the piece
 * is scanned onto one. The larger labels add the description and the SKU.
 */
function GarmentLabel({ g, layout, codes }: { g: Label; layout: TrackingLayout; codes: Codes }) {
  const d = GDIM[layout]
  const qrSize = codes === 'both' ? d.qrBoth : d.qr
  const order = g.poRef ? ['PO', g.poRef] : ['Order', g.soNumber ?? 'For stock']
  // A barcode takes height: the hang tag folds its last lines into one.
  const folded = layout === 'tag' && codes !== 'qr'
  return (
    <div className="sticker gm">
      <div className="gm-head">
        <span className="gm-id" style={{ fontSize: d.id }}>{g.code}</span>
        <span style={{ fontSize: d.brand, fontWeight: 600, ...clip }}>{g.brand}</span>
      </div>
      <div className="gm-body" style={{ gap: d.gap }}>
        {codes !== 'bar' && (
          <div style={{ flexShrink: 0 }}>
            <QrCode text={g.code} size={qrSize} />
          </div>
        )}
        <div className="gm-info" style={{ gap: d.rowGap }}>
          {layout !== 'tag' && (
            <div className="gm-desc" style={{ fontSize: d.desc, WebkitLineClamp: layout === 'poly' && codes !== 'both' ? 2 : 1 }}>
              {g.description}
            </div>
          )}
          <Field k="Style" v={g.style} size={d.style} bold />
          <div className="gm-size">
            <span style={{ fontSize: d.line, fontWeight: 600, color: '#555' }}>Size</span>
            <span style={{ fontSize: d.size, fontWeight: 800, lineHeight: 1 }}>{g.size || '—'}</span>
            <span style={{ fontSize: d.line, fontWeight: 700, marginLeft: '1mm', ...clip }}>{g.color}</span>
            {g.grade === 'B' ? (
              <span className="gm-b" style={{ fontSize: d.line }}>B</span>
            ) : (
              layout !== 'tag' && <span style={{ fontSize: d.line, color: '#555', flexShrink: 0 }}>Grade {g.grade || 'A'}</span>
            )}
          </div>
          {g.buyer && <Field k="Customer" v={g.buyer} size={d.line} bold />}
          {layout === 'tag' ? (
            folded ? (
              // One line for the rest: the lot, and the challan or the order.
              <Field k="Lot" v={`${g.lot ?? '—'} · ${g.challan ? `Challan ${g.challan}` : `${order[0]} ${order[1]}`}`} size={d.line} />
            ) : (
              // The hang tag has room for one more line after the lot: the
              // challan once the piece is on one, the order until then.
              <>
                <Field k="Lot" v={g.lot ?? '—'} size={d.line} />
                {g.challan ? <Field k="Challan" v={g.challan} size={d.line} bold /> : <Field k={order[0]} v={order[1]} size={d.line} />}
              </>
            )
          ) : (
            <>
              <Field k={order[0]} v={g.poRef && g.soNumber ? `${order[1]} · ${g.soNumber}` : order[1]} size={d.line} />
              <Field k="Lot" v={`${g.lot ?? '—'} · ${g.moNumber}`} size={d.line} />
              {g.challan && <Field k="Challan" v={g.challan} size={d.line} bold />}
              {layout === 'poly' && <Field k="SKU" v={g.sku} size={d.line} />}
            </>
          )}
        </div>
      </div>
      {codes !== 'qr' && (
        <div className="gm-bar" style={{ height: codes === 'bar' ? d.barOnly : d.bar }}>
          <Code128 text={g.code} />
        </div>
      )}
    </div>
  )
}

const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The retail tag a customer reads in the shop: brand, style, colour and size,
 * the MRP inclusive of all taxes, the EAN-13 the billing counter scans, the
 * piece's own QR for the warehouse, and the lines the law asks for — month
 * and year of manufacture, country of origin, net quantity, who made and sells
 * it, and where to complain — with the wash-care symbols.
 */
function RetailTag({ g, maker }: { g: Label; maker: Maker }) {
  const r = g.retail
  const tiny = { fontSize: '4.6pt', lineHeight: 1.25 } as const
  return (
    <div className="sticker rt">
      <div className="rt-brand">
        {r?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.logoUrl} alt={g.brand} style={{ maxHeight: '7mm', maxWidth: '32mm', objectFit: 'contain' }} />
        ) : (
          <span style={{ fontSize: '9pt', fontWeight: 800, letterSpacing: '.08em', ...clip }}>{g.brand.toUpperCase()}</span>
        )}
      </div>
      <div style={{ fontSize: '7.5pt', fontWeight: 700, lineHeight: 1.15, textAlign: 'center', ...clip }}>{g.description}</div>
      <div style={{ fontSize: '5.6pt', textAlign: 'center', color: '#333', ...clip }}>
        {g.style} · {g.color}
      </div>
      <div className="rt-size">
        <span style={{ fontSize: '5.6pt', fontWeight: 600 }}>SIZE</span>
        <span className="rt-size-box">{g.size || '—'}</span>
      </div>
      <div style={{ textAlign: 'center', lineHeight: 1.05 }}>
        <span style={{ fontSize: '6pt', fontWeight: 700 }}>MRP ₹ </span>
        <span style={{ fontSize: '12pt', fontWeight: 800 }}>{r?.mrp != null ? money(r.mrp) : '—'}</span>
        <div style={{ fontSize: '4.6pt' }}>(Inclusive of all taxes)</div>
      </div>
      <div className="rt-ean">
        {r?.ean ? (
          <Ean13 code={r.ean} width="38mm" height="13mm" />
        ) : (
          <div style={{ ...tiny, border: '0.2mm dashed #999', padding: '1.5mm', textAlign: 'center' }}>No barcode yet</div>
        )}
      </div>
      <div className="rt-foot">
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <QrCode text={g.code} size="12mm" />
          <div style={{ fontSize: '4.2pt', fontFamily: 'ui-monospace, Consolas, monospace', fontWeight: 700 }}>{g.code}</div>
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          {r?.composition && <div style={{ ...tiny, fontWeight: 700, ...clip }}>{r.composition}</div>}
          <div style={tiny}>
            <b>MFD:</b> {r?.mfd ?? '—'} · <b>Net qty:</b> 1 N
          </div>
          <div style={tiny}>
            <b>Country of origin:</b> {maker.origin}
          </div>
          <div style={{ marginTop: '0.6mm' }}>
            <WashCareIcons codes={r?.washCare ?? []} size="3.6mm" />
          </div>
        </div>
      </div>
      <div className="rt-legal" style={tiny}>
        {/* The full address and the care line: the law wants them whole, and the tag has the room. */}
        <div style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          <b>Mfd &amp; Mktd by:</b> {maker.name}
          {maker.address ? `, ${maker.address}` : ''}
        </div>
        {maker.care && (
          <div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }}>
            <b>Customer care:</b> {maker.care}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Garment labels for printing, one per piece. Opening the page prints
 * nothing; when the print box is opened the labels are counted as printed,
 * so the order screen can tell new labels from reprints.
 */
function Labels() {
  const params = useSearchParams()
  const [data, setData] = useState<{ company: string; maker: Maker | null; garments: Label[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [layout, setLayout] = useState<Layout>('tag')
  const [codes, setCodes] = useState<Codes>('both')
  const marked = useRef(false)

  const qs = params.toString()
  const retail = layout === 'retail'
  useEffect(() => {
    if (!params.get('moId') && !params.get('ids')) {
      setError('Open the labels from Garment Tags.')
      return
    }
    // The retail tag also brings each piece's MRP, barcode and care symbols.
    api
      .get<{ data: { company: string; maker: Maker | null; garments: Label[] } }>(`/garments/labels?${qs}${retail ? '&retail=1' : ''}`)
      .then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the garments.'))
    // The query string, and whether it is the retail tag, are the whole of what this page shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, retail])

  useEffect(() => {
    try {
      const saved = localStorage.getItem('garment-label-layout') as Layout | null
      if (saved && saved in SIZES) setLayout(saved)
      const savedCodes = localStorage.getItem('garment-label-codes') as Codes | null
      if (savedCodes && savedCodes in CODES) setCodes(savedCodes)
    } catch {
      /* keep the hang tag, with both codes */
    }
  }, [])

  // Counted once, when the print box opens: that is a print, opening the page is not.
  useEffect(() => {
    if (!data?.garments.length) return
    const mark = () => {
      if (marked.current) return
      marked.current = true
      void api.post('/garments/printed', { ids: data.garments.map((g) => g.id) }).catch(() => {})
    }
    window.addEventListener('beforeprint', mark)
    return () => window.removeEventListener('beforeprint', mark)
  }, [data])

  const pick = (l: Layout) => {
    setLayout(l)
    try {
      localStorage.setItem('garment-label-layout', l)
    } catch {
      /* fine without it */
    }
  }
  const pickCodes = (c: Codes) => {
    setCodes(c)
    try {
      localStorage.setItem('garment-label-codes', c)
    } catch {
      /* fine without it */
    }
  }

  if (error) return <p style={{ padding: 48, color: '#fff' }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: '#ddd' }}>Opening the labels…</p>
  if (!data.garments.length) {
    return (
      <p style={{ padding: 48, color: '#fff' }}>
        {params.get('only') === 'new' ? 'No new labels to print — every one of these is printed already.' : 'No tagged garments match this.'}
      </p>
    )
  }

  const reprints = data.garments.filter((g) => g.printed).length
  const sheets: Label[][] = []
  for (let i = 0; i < data.garments.length; i += 24) sheets.push(data.garments.slice(i, i + 24))

  return (
    <>
      <style>{`
        .print-toolbar, .sticker-options {
          display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
          max-width: 210mm; margin: 0 auto 12px; padding: 8px 12px;
          background: #fff; border-radius: 6px; font: 13px Inter, system-ui, sans-serif; color: #1f2b3d;
        }
        .print-toolbar .tb-hint { color: #5a6880; font-size: 12px; margin-right: auto; }
        .print-toolbar .tb-btn {
          display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
          border: 1px solid #aebfd6; border-radius: 6px; background: #fff; color: #173a6c;
          font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer;
        }
        .print-toolbar .tb-primary { background: #173a6c; border-color: #173a6c; color: #fff; }
        .sticker-options select { padding: 5px 8px; border: 1px solid #aebfd6; border-radius: 6px; font: inherit; }
        .sticker-options label { display: inline-flex; align-items: center; gap: 6px; }
        .sticker { box-sizing: border-box; overflow: hidden; color: #000; background: #fff; font-family: Inter, system-ui, sans-serif; }
        .gm { display: flex; flex-direction: column; }
        .gm-head { display: flex; align-items: center; justify-content: space-between; gap: 1.5mm;
                   border-bottom: 0.3mm solid #000; padding-bottom: 0.5mm; margin-bottom: 0.8mm; }
        .gm-id { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-weight: 800; letter-spacing: .02em; line-height: 1; flex-shrink: 0; }
        .gm-body { display: flex; flex: 1; min-height: 0; align-items: center; overflow: hidden; }
        .gm-info { min-width: 0; max-height: 100%; flex: 1; display: flex; flex-direction: column; justify-content: safe center; gap: 0.4mm; }
        .gm-info > * { flex-shrink: 0; }
        .gm-bar { flex-shrink: 0; margin-top: 0.7mm; }
        .gm-desc { font-weight: 700; line-height: 1.15; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .gm-size { display: flex; align-items: baseline; gap: 1mm; }
        .gm-b { border: 0.25mm solid #000; padding: 0 0.6mm; font-weight: 800; }
        .sheet { width: 210mm; height: 296mm; margin: 0 auto 12px; background: #fff; display: grid;
                 grid-template-columns: repeat(3, 70mm); grid-auto-rows: 37mm; }
        .sheet .sticker { padding: 2mm 2.5mm; border: 0.2mm dashed #bbb; }
        .roll { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .roll.tag .sticker { width: 50mm; height: 25mm; padding: 1.5mm 2mm; border: 0.2mm dashed #bbb; }
        .roll.poly .sticker { width: 75mm; height: 50mm; padding: 2.5mm 3mm; border: 0.2mm dashed #bbb; }
        .roll.retail .sticker { width: 50mm; height: 75mm; padding: 2.5mm 3mm; border: 0.2mm dashed #bbb; }
        .rt { display: flex; flex-direction: column; gap: 0.7mm; }
        .rt-brand { display: flex; align-items: center; justify-content: center; height: 8mm; border-bottom: 0.3mm solid #000; padding-bottom: 0.5mm; }
        .rt-size { display: flex; align-items: center; justify-content: center; gap: 1.5mm; }
        .rt-size-box { border: 0.4mm solid #000; padding: 0 2.2mm; font-size: 15pt; font-weight: 800; line-height: 1.15; }
        .rt-ean { display: flex; justify-content: center; }
        .rt-foot { display: flex; gap: 1.5mm; align-items: center; }
        .rt-legal { border-top: 0.2mm solid #999; padding-top: 0.6mm; margin-top: auto; }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
          .sheet { margin: 0; break-after: page; }
          .sheet .sticker { border: 0; }
          .roll { gap: 0; }
          .roll .sticker { border: 0 !important; break-after: page; }
          .sticker, .sticker * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        @page { size: ${SIZES[layout].page}; margin: 0; }
      `}</style>
      <PrintToolbar backHref="/inventory/garment-tags" backLabel="Garment Tags" copies={1} fileName={`Garment labels ${data.garments[0].code}`} />
      <div className="no-print sticker-options">
        <label>
          Labels on
          <select value={layout} onChange={(e) => pick(e.target.value as Layout)}>
            {(Object.keys(SIZES) as Layout[]).map((l) => (
              <option key={l} value={l}>
                {SIZES[l].label}
              </option>
            ))}
          </select>
        </label>
        {/* The retail tag has its own barcode, the EAN-13 the billing counter scans. */}
        {!retail && (
          <label>
            Codes
            <select value={codes} onChange={(e) => pickCodes(e.target.value as Codes)}>
              {(Object.keys(CODES) as Codes[]).map((c) => (
                <option key={c} value={c}>
                  {CODES[c]}
                </option>
              ))}
            </select>
          </label>
        )}
        <span style={{ color: '#5a6880', fontSize: 12 }}>
          {data.garments.length} {data.garments.length === 1 ? 'label' : 'labels'}, {data.garments[0].code} to {data.garments[data.garments.length - 1].code}
          {reprints ? ` · ${reprints} printed before (same codes)` : ''}
        </span>
        {retail && <RetailGaps garments={data.garments} />}
      </div>
      {layout === 'sheet' ? (
        sheets.map((page, i) => (
          <div key={i} className="sheet">
            {page.map((g) => (
              <GarmentLabel key={g.id} g={g} layout="sheet" codes={codes} />
            ))}
          </div>
        ))
      ) : layout === 'retail' ? (
        <div className="roll retail">
          {data.garments.map((g) => (
            <RetailTag key={g.id} g={g} maker={data.maker ?? { name: data.company, address: '', care: '', origin: 'India' }} />
          ))}
        </div>
      ) : (
        <div className={`roll ${layout}`}>
          {data.garments.map((g) => (
            <GarmentLabel key={g.id} g={g} layout={layout} codes={codes} />
          ))}
        </div>
      )}
    </>
  )
}

export default function PrintGarments() {
  return (
    <Suspense fallback={<p style={{ padding: 48, color: '#ddd' }}>Opening the labels…</p>}>
      <Labels />
    </Suspense>
  )
}

/** What a retail tag would print without: said before the print, so it can be put right first. */
function RetailGaps({ garments }: { garments: Label[] }) {
  const noMrp = garments.filter((g) => g.retail && g.retail.mrp == null).length
  const noEan = garments.filter((g) => g.retail && !g.retail.ean).length
  if (!noMrp && !noEan) return null
  return (
    <span style={{ color: '#b45309', fontSize: 12, fontWeight: 600 }}>
      {[noMrp ? `${noMrp} without MRP (Masters → Styles)` : null, noEan ? `${noEan} without a barcode (Masters → Styles → Barcodes)` : null]
        .filter(Boolean)
        .join(' · ')}
    </span>
  )
}
