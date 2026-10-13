'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { QrCode } from '@/components/packages/QrCode'

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
}

type Layout = 'tag' | 'poly' | 'sheet'

const SIZES: Record<Layout, { label: string; page: string }> = {
  tag: { label: 'Hang tag / sticker, 50 × 25 mm', page: '50mm 25mm' },
  poly: { label: 'Polybag sticker, 75 × 50 mm', page: '75mm 50mm' },
  sheet: { label: 'A4 sheet, 24 a page (70 × 37 mm)', page: 'A4' },
}

const clip = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const

const GDIM: Record<Layout, { qr: string; id: string; brand: string; style: string; size: string; line: string; desc: string; gap: string; rowGap: string }> = {
  tag: { qr: '15.5mm', id: '8pt', brand: '5pt', style: '6.8pt', size: '11pt', line: '5.3pt', desc: '0', gap: '1.5mm', rowGap: '0.1mm' },
  sheet: { qr: '23mm', id: '10pt', brand: '5.8pt', style: '7pt', size: '12pt', line: '5.6pt', desc: '6.4pt', gap: '2mm', rowGap: '0.15mm' },
  poly: { qr: '31mm', id: '12.5pt', brand: '7pt', style: '8.6pt', size: '16pt', line: '6.5pt', desc: '7.8pt', gap: '2.5mm', rowGap: '0.1mm' },
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
 * One garment's label, in the same shape as the package stickers: its ID
 * large in the header (printed in full, so it can be typed if the QR will not
 * read), the QR at the left, and beside it every field named — style, size
 * and colour, customer, order, lot, and the delivery challan once the piece
 * is scanned onto one. The larger labels add the description, MO and SKU.
 */
function GarmentLabel({ g, layout }: { g: Label; layout: Layout }) {
  const d = GDIM[layout]
  const order = g.poRef ? ['PO', g.poRef] : ['Order', g.soNumber ?? 'For stock']
  return (
    <div className="sticker gm">
      <div className="gm-head">
        <span className="gm-id" style={{ fontSize: d.id }}>{g.code}</span>
        <span style={{ fontSize: d.brand, fontWeight: 600, ...clip }}>{g.brand}</span>
      </div>
      <div className="gm-body" style={{ gap: d.gap }}>
        <div style={{ flexShrink: 0 }}>
          <QrCode text={g.code} size={d.qr} />
        </div>
        <div className="gm-info" style={{ gap: d.rowGap }}>
          {layout !== 'tag' && (
            <div className="gm-desc" style={{ fontSize: d.desc, WebkitLineClamp: layout === 'poly' ? 2 : 1 }}>
              {g.description}
            </div>
          )}
          <Field k="Style" v={g.style} size={d.style} bold />
          <div className="gm-size">
            <span style={{ fontSize: d.line, fontWeight: 600, color: '#555' }}>Size</span>
            <span style={{ fontSize: d.size, fontWeight: 800, lineHeight: 1 }}>{g.size || '—'}</span>
            <span style={{ fontSize: d.line, fontWeight: 700, marginLeft: '1mm', ...clip }}>{g.color}</span>
            {g.grade === 'B' && <span className="gm-b" style={{ fontSize: d.line }}>B</span>}
          </div>
          {g.buyer && <Field k="Customer" v={g.buyer} size={d.line} bold />}
          {layout === 'tag' ? (
            // The hang tag has room for one more line after the lot: the
            // challan once the piece is on one, the order until then.
            <>
              <Field k="Lot" v={g.lot ?? '—'} size={d.line} />
              {g.challan ? <Field k="Challan" v={g.challan} size={d.line} bold /> : <Field k={order[0]} v={order[1]} size={d.line} />}
            </>
          ) : (
            <>
              <Field k={order[0]} v={order[1]} size={d.line} />
              <Field k="Lot" v={`${g.lot ?? '—'} · ${g.moNumber}`} size={d.line} />
              {g.challan && <Field k="Challan" v={g.challan} size={d.line} bold />}
            </>
          )}
          {layout === 'poly' && <Field k="SKU" v={g.sku} size={d.line} />}
        </div>
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
  const [data, setData] = useState<{ company: string; garments: Label[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [layout, setLayout] = useState<Layout>('tag')
  const marked = useRef(false)

  const qs = params.toString()
  useEffect(() => {
    if (!params.get('moId') && !params.get('ids')) {
      setError('Open the labels from Garment Tags.')
      return
    }
    api
      .get<{ data: { company: string; garments: Label[] } }>(`/garments/labels?${qs}`)
      .then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the garments.'))
    // The query string is the whole of what this page shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs])

  useEffect(() => {
    try {
      const saved = localStorage.getItem('garment-label-layout') as Layout | null
      if (saved && saved in SIZES) setLayout(saved)
    } catch {
      /* keep the hang tag */
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
        .gm-body { display: flex; flex: 1; min-height: 0; align-items: center; }
        .gm-info { min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 0.4mm; }
        .gm-desc { font-weight: 700; line-height: 1.15; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .gm-size { display: flex; align-items: baseline; gap: 1mm; }
        .gm-b { border: 0.25mm solid #000; padding: 0 0.6mm; font-weight: 800; }
        .sheet { width: 210mm; height: 296mm; margin: 0 auto 12px; background: #fff; display: grid;
                 grid-template-columns: repeat(3, 70mm); grid-auto-rows: 37mm; }
        .sheet .sticker { padding: 2mm 2.5mm; border: 0.2mm dashed #bbb; }
        .roll { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .roll.tag .sticker { width: 50mm; height: 25mm; padding: 1.5mm 2mm; border: 0.2mm dashed #bbb; }
        .roll.poly .sticker { width: 75mm; height: 50mm; padding: 2.5mm 3mm; border: 0.2mm dashed #bbb; }
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
        <span style={{ color: '#5a6880', fontSize: 12 }}>
          {data.garments.length} {data.garments.length === 1 ? 'label' : 'labels'}, {data.garments[0].code} to {data.garments[data.garments.length - 1].code}
          {reprints ? ` · ${reprints} printed before (same codes)` : ''}
        </span>
      </div>
      {layout === 'sheet' ? (
        sheets.map((page, i) => (
          <div key={i} className="sheet">
            {page.map((g) => (
              <GarmentLabel key={g.id} g={g} layout="sheet" />
            ))}
          </div>
        ))
      ) : (
        <div className={`roll ${layout}`}>
          {data.garments.map((g) => (
            <GarmentLabel key={g.id} g={g} layout={layout} />
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
