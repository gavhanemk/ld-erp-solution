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
  printed: boolean
}

type Layout = 'tag' | 'poly' | 'sheet'

const SIZES: Record<Layout, { label: string; page: string }> = {
  tag: { label: 'Hang tag / sticker, 50 × 25 mm', page: '50mm 25mm' },
  poly: { label: 'Polybag sticker, 75 × 50 mm', page: '75mm 50mm' },
  sheet: { label: 'A4 sheet, 24 a page (70 × 37 mm)', page: 'A4' },
}

const clip = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const

/**
 * One garment's label. The small one carries what a packer reads — style,
 * size, colour — and the QR; everything else is a scan away. The large one
 * adds the buyer, order, MO, lot and SKU.
 */
function GarmentLabel({ g, layout }: { g: Label; layout: Layout }) {
  if (layout === 'tag') {
    return (
      <div className="sticker" style={{ display: 'flex', gap: '1.5mm', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
          <QrCode text={g.code} size="19mm" />
          <div style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: '6pt' }}>{g.code}</div>
        </div>
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '0.4mm' }}>
          <div style={{ fontSize: '5.5pt', color: '#333', ...clip }}>{g.brand}</div>
          <div style={{ fontSize: '8pt', fontWeight: 800, ...clip }}>{g.style}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.5mm' }}>
            <span style={{ fontSize: '6pt' }}>Size</span>
            <span style={{ fontSize: '13pt', fontWeight: 800, lineHeight: 1 }}>{g.size || '—'}</span>
            {g.grade === 'B' && <span style={{ fontSize: '6pt', fontWeight: 800, border: '0.2mm solid #000', padding: '0 0.6mm' }}>B</span>}
          </div>
          <div style={{ fontSize: '6.5pt', fontWeight: 600, ...clip }}>{g.color}</div>
          {g.lot && <div style={{ fontSize: '5.5pt', color: '#333', ...clip }}>Lot {g.lot}</div>}
        </div>
      </div>
    )
  }
  const big = layout === 'poly'
  const f = (a: string, b: string) => (big ? a : b)
  return (
    <div className="sticker" style={{ display: 'flex', gap: f('2.5mm', '2mm'), alignItems: 'stretch' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <QrCode text={g.code} size={f('34mm', '25mm')} />
        <div style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: f('8.5pt', '7pt') }}>{g.code}</div>
      </div>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div style={{ fontSize: f('7pt', '5.8pt'), color: '#333', ...clip }}>{g.brand}</div>
        <div style={{ fontSize: f('9pt', '7pt'), fontWeight: 700, lineHeight: 1.15, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {g.description}
        </div>
        <div style={{ fontSize: f('8pt', '6.5pt'), fontWeight: 700, ...clip }}>Style {g.style}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '2mm' }}>
          <span style={{ fontSize: f('7pt', '6pt') }}>Size</span>
          <span style={{ fontSize: f('18pt', '13pt'), fontWeight: 800, lineHeight: 1 }}>{g.size || '—'}</span>
          {g.grade === 'B' && <span style={{ fontSize: f('8pt', '6pt'), fontWeight: 800, border: '0.25mm solid #000', padding: '0 0.8mm' }}>B-grade</span>}
        </div>
        <div style={{ fontSize: f('8pt', '6.5pt'), fontWeight: 600, ...clip }}>{g.color}</div>
        {g.buyer && <div style={{ fontSize: f('7pt', '5.8pt'), ...clip }}>{g.buyer}</div>}
        <div style={{ fontSize: f('6.5pt', '5.5pt'), color: '#333', ...clip }}>
          {g.poRef ? `PO ${g.poRef}` : g.soNumber ?? ''}
          {big ? ` · ${g.moNumber}` : ''}
        </div>
        <div style={{ fontSize: f('6.5pt', '5.5pt'), color: '#333', ...clip }}>
          {g.lot ? `Lot ${g.lot} · ` : ''}SKU {g.sku}
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
