'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { code128Bars } from '@/lib/code128'

interface Payload {
  company: string
  mo: { moNumber: string; so: { soNumber: string; customerPORef: string | null; customer: { name: string } } | null }
  bundles: Array<{
    id: string
    code: string
    bundleNo: number
    qty: number
    size: { code: string } | null
    moLine: { color: string; style: { code: string; name: string } }
    cuttingOrder: { cutOrderNumber: string; cutDate: string; lotNo: string | null }
  }>
}

type Layout = 'sheet' | 'roll'

/** The bundle's number as bars a scanner reads, stretched to the sticker's width. */
function Barcode({ text, height }: { text: string; height: string }) {
  const { bars, width } = code128Bars(text)
  return (
    <svg viewBox={`0 0 ${width} 40`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }} aria-label={text} role="img">
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={40} fill="#000" />
      ))}
    </svg>
  )
}

const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

function Sticker({ b, data, layout }: { b: Payload['bundles'][number]; data: Payload; layout: Layout }) {
  const big = layout === 'roll'
  return (
    <div className="sticker">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '2mm' }}>
        <span style={{ fontSize: big ? '7.5pt' : '6pt', color: '#333', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{data.company}</span>
        <span style={{ fontSize: big ? '15pt' : '12pt', fontWeight: 800, letterSpacing: '.02em' }}>B{String(b.bundleNo).padStart(3, '0')}</span>
      </div>
      <Barcode text={b.code} height={big ? '13mm' : '8.5mm'} />
      <div style={{ fontSize: big ? '7.5pt' : '6pt', textAlign: 'center', fontFamily: 'ui-monospace, monospace', letterSpacing: '.04em' }}>{b.code}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '.6mm' }}>
        <span style={{ fontSize: big ? '16pt' : '12pt', fontWeight: 800 }}>{b.size ? `Size ${b.size.code}` : 'No size'}</span>
        <span style={{ fontSize: big ? '14pt' : '11pt', fontWeight: 800 }}>{b.qty} pcs</span>
      </div>
      <div style={{ fontSize: big ? '8pt' : '6.5pt', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {b.moLine.style.code} · {b.moLine.color}
      </div>
      <div style={{ fontSize: big ? '7pt' : '5.8pt', color: '#333', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {data.mo.moNumber} · {b.cuttingOrder.cutOrderNumber.split('-').pop()} {day(b.cuttingOrder.cutDate)}
        {b.cuttingOrder.lotNo ? ` · lot ${b.cuttingOrder.lotNo}` : ''}
        {data.mo.so ? ` · ${data.mo.so.customer.name}` : ''}
      </div>
    </div>
  )
}

/**
 * The bundle stickers: one per bundle (or two), each with its number as a
 * barcode — scanned or typed at every desk the bundle passes — and what is in
 * it: size, pieces, style and colour, the order and the cutting it came from.
 * On an A4 sticker sheet of 24 (3 × 8, 70 × 37 mm) or on a label printer,
 * one 75 × 50 mm label a page.
 */
function Stickers() {
  const params = useSearchParams()
  const moId = params.get('mo') ?? ''
  const cutting = params.get('cutting') ?? ''
  const ids = params.get('ids') ?? ''
  const line = params.get('line') ?? ''
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [layout, setLayout] = useState<Layout>('sheet')
  const [copies, setCopies] = useState(1)

  useEffect(() => {
    if (!moId) {
      setError('Open the stickers from a manufacturing order.')
      return
    }
    const qs = new URLSearchParams()
    if (cutting) qs.set('cutting', cutting)
    if (ids) qs.set('ids', ids)
    if (line) qs.set('line', line)
    api
      .get<{ data: Payload }>(`/production/orders/${moId}/stickers?${qs}`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the bundles.'))
  }, [moId, cutting, ids, line])

  if (error) return <p style={{ padding: 48, color: '#fff' }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: '#ddd' }}>Opening the bundles…</p>
  if (!data.bundles.length) return <p style={{ padding: 48, color: '#fff' }}>No bundles to print.</p>

  const all = data.bundles.flatMap((b) => Array.from({ length: copies }, (_, i) => ({ b, key: `${b.id}-${i}` })))
  const sheets: Array<typeof all> = []
  for (let i = 0; i < all.length; i += 24) sheets.push(all.slice(i, i + 24))

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
        .sticker { box-sizing: border-box; overflow: hidden; color: #000; background: #fff; font-family: Inter, system-ui, sans-serif;
                   display: flex; flex-direction: column; justify-content: space-between; }
        .sheet { width: 210mm; height: 296mm; margin: 0 auto 12px; background: #fff; display: grid;
                 grid-template-columns: repeat(3, 70mm); grid-auto-rows: 37mm; }
        .sheet .sticker { padding: 2mm 3mm; border: 0.2mm dashed #bbb; }
        .roll { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .roll .sticker { width: 75mm; height: 50mm; padding: 2.5mm 3.5mm; border: 0.2mm dashed #bbb; }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
          .sheet { margin: 0; break-after: page; }
          .sheet .sticker { border: 0; }
          .roll { gap: 0; }
          .roll .sticker { border: 0; break-after: page; }
          .sticker, .sticker * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        @page { size: ${layout === 'roll' ? '75mm 50mm' : 'A4'}; margin: 0; }
      `}</style>
      <PrintToolbar backHref="/production/orders" backLabel="Production" copies={1} fileName={`${data.mo.moNumber} bundles`} />
      <div className="no-print sticker-options">
        <label>
          Stickers on
          <select value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
            <option value="sheet">A4 sheet, 24 a page (70 × 37 mm)</option>
            <option value="roll">Label printer, 75 × 50 mm</option>
          </select>
        </label>
        <label>
          Per bundle
          <select value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
            <option value={1}>One</option>
            <option value={2}>Two</option>
          </select>
        </label>
        <span style={{ color: '#5a6880', fontSize: 12 }}>
          {data.bundles.length} bundles of {data.mo.moNumber} · {all.length} stickers
        </span>
      </div>
      {layout === 'sheet' ? (
        sheets.map((page, i) => (
          <div key={i} className="sheet">
            {page.map(({ b, key }) => (
              <Sticker key={key} b={b} data={data} layout={layout} />
            ))}
          </div>
        ))
      ) : (
        <div className="roll">
          {all.map(({ b, key }) => (
            <Sticker key={key} b={b} data={data} layout={layout} />
          ))}
        </div>
      )}
    </>
  )
}

export default function PrintBundles() {
  return (
    <Suspense fallback={<p style={{ padding: 48, color: '#ddd' }}>Opening the bundles…</p>}>
      <Stickers />
    </Suspense>
  )
}
