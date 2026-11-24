'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { QrCode } from '@/components/packages/QrCode'
import { Code128 } from '@/components/packages/Code128'
import type { Carton } from '@/components/inventory/cartons/cartonTypes'

/*
 * Carton stickers: the carton's number as a QR and a barcode (scanned onto a
 * delivery challan), the buyer and order it is packed for, and what is in it —
 * how many pieces of which style and item, in which size.
 */

interface Payload {
  company: string
  logo: string | null
  cartons: Carton[]
}
type Layout = 'label' | 'sheet'
const LAYOUTS: Record<Layout, { label: string; page: string }> = {
  label: { label: 'Label printer, 100 × 150 mm', page: '100mm 150mm' },
  sheet: { label: 'A4 sheet, two to a page', page: 'A4' },
}
const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })

export default function CartonStickersPage() {
  return (
    <Suspense fallback={null}>
      <CartonStickers />
    </Suspense>
  )
}

function CartonStickers() {
  const params = useSearchParams()
  const ids = params.get('ids') ?? ''
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [layout, setLayout] = useState<Layout>('label')
  const marked = useRef(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('carton-label-layout') as Layout | null
      if (saved && saved in LAYOUTS) setLayout(saved)
    } catch {
      /* the label printer size, then */
    }
  }, [])
  useEffect(() => {
    if (!ids) return setError('Choose the cartons to print.')
    api
      .get<{ data: Payload }>(`/fg-cartons/labels?ids=${ids}`)
      .then((r) => setData(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the cartons.'))
  }, [ids])
  // Counted once, when the print box opens.
  useEffect(() => {
    if (!data?.cartons.length) return
    const mark = () => {
      if (marked.current) return
      marked.current = true
      void api.post('/fg-cartons/printed', { ids: data.cartons.map((c) => c.id) }).catch(() => {})
    }
    window.addEventListener('beforeprint', mark)
    return () => window.removeEventListener('beforeprint', mark)
  }, [data])

  if (error) return <p style={{ padding: 48, color: '#fff' }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: '#ddd' }}>Opening the carton stickers…</p>
  if (!data.cartons.length) return <p style={{ padding: 48, color: '#fff' }}>No carton to print: they have been dispatched or opened.</p>

  const pick = (l: Layout) => {
    setLayout(l)
    try {
      localStorage.setItem('carton-label-layout', l)
    } catch {
      /* fine without it */
    }
  }

  return (
    <>
      <style>{`
        .print-toolbar, .sticker-options { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; max-width: 210mm; margin: 0 auto 12px; padding: 8px 12px;
          background: #fff; border-radius: 6px; font: 13px Inter, system-ui, sans-serif; color: #1f2b3d; }
        .print-toolbar .tb-hint { color: #5a6880; font-size: 12px; margin-right: auto; }
        .print-toolbar .tb-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid #aebfd6; border-radius: 6px;
          background: #fff; color: #173a6c; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; }
        .print-toolbar .tb-primary { background: #173a6c; border-color: #173a6c; color: #fff; }
        .sticker-options select { padding: 5px 8px; border: 1px solid #aebfd6; border-radius: 6px; font: inherit; }
        .ct { box-sizing: border-box; overflow: hidden; background: #fff; color: #000; font-family: Inter, system-ui, sans-serif;
              display: flex; flex-direction: column; padding: 4mm; border: 0.2mm dashed #bbb; }
        .label .ct { width: 100mm; height: 150mm; margin: 0 auto 8px; }
        .sheet { width: 210mm; margin: 0 auto 12px; background: #fff; display: grid; grid-template-columns: repeat(2, 100mm); gap: 4mm; padding: 4mm 3mm; }
        .sheet .ct { width: 100mm; height: 140mm; }
        .ct-head { display: flex; align-items: center; justify-content: space-between; gap: 2mm; border-bottom: 0.4mm solid #000; padding-bottom: 1.5mm; }
        .ct-company { font-size: 9pt; font-weight: 700; }
        .ct-code { font-family: ui-monospace, Consolas, monospace; font-weight: 800; font-size: 20pt; letter-spacing: .02em; }
        .ct-codes { display: flex; gap: 3mm; align-items: center; margin: 2mm 0; }
        .ct-qr { width: 26mm; flex-shrink: 0; }
        .ct-bar { flex: 1; height: 16mm; }
        .ct-buyer { font-size: 9pt; line-height: 1.35; border-bottom: 0.2mm solid #999; padding-bottom: 1.5mm; }
        .ct-buyer b { font-size: 10pt; }
        .ct-table { width: 100%; border-collapse: collapse; font-size: 8pt; margin-top: 1.5mm; }
        .ct-table th { text-align: left; font-size: 7pt; text-transform: uppercase; letter-spacing: .04em; border-bottom: 0.3mm solid #000; padding: 0.8mm 0.5mm; }
        .ct-table td { border-bottom: 0.2mm solid #ccc; padding: 0.8mm 0.5mm; vertical-align: top; }
        .ct-table .n { text-align: right; font-weight: 700; }
        .ct-sizes { font-family: ui-monospace, Consolas, monospace; }
        .ct-foot { margin-top: auto; display: flex; justify-content: space-between; align-items: baseline; border-top: 0.4mm solid #000; padding-top: 1.5mm; font-size: 8pt; }
        .ct-total { font-size: 14pt; font-weight: 800; }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
          .ct { border: 0; }
          .label .ct { margin: 0; break-after: page; }
          .sheet { margin: 0; break-after: page; }
          .ct, .ct * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        @page { size: ${LAYOUTS[layout].page}; margin: 0; }
      `}</style>
      <PrintToolbar backHref="/inventory/cartons" backLabel="Cartons" copies={1} fileName={`Cartons ${data.cartons[0]?.code ?? ''}`} />
      <div className="no-print sticker-options">
        <label>
          Stickers on{' '}
          <select value={layout} onChange={(e) => pick(e.target.value as Layout)}>
            {(Object.keys(LAYOUTS) as Layout[]).map((l) => (
              <option key={l} value={l}>
                {LAYOUTS[l].label}
              </option>
            ))}
          </select>
        </label>
        <span style={{ color: '#5a6880', fontSize: 12 }}>
          {data.cartons.length} {data.cartons.length === 1 ? 'carton' : 'cartons'}
        </span>
      </div>
      {layout === 'label' ? (
        <div className="label">
          {data.cartons.map((c) => (
            <CartonSticker key={c.id} c={c} company={data.company} logo={data.logo} />
          ))}
        </div>
      ) : (
        Array.from({ length: Math.ceil(data.cartons.length / 2) }, (_, i) => (
          <div key={i} className="sheet">
            {data.cartons.slice(i * 2, i * 2 + 2).map((c) => (
              <CartonSticker key={c.id} c={c} company={data.company} logo={data.logo} />
            ))}
          </div>
        ))
      )}
    </>
  )
}

function CartonSticker({ c, company, logo }: { c: Carton; company: string; logo: string | null }) {
  return (
    <div className="ct" data-carton={c.code}>
      <div className="ct-head">
        <span className="ct-company">
          {logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" style={{ height: '6mm', marginRight: '2mm', verticalAlign: 'middle' }} />
          )}
          {company}
        </span>
        <span className="ct-code">{c.code}</span>
      </div>
      <div className="ct-codes">
        <div className="ct-qr">
          <QrCode text={c.code} />
        </div>
        <div className="ct-bar">
          <Code128 text={c.code} />
        </div>
      </div>
      <div className="ct-buyer">
        {c.order ? (
          <>
            Buyer: <b>{c.order.customer ?? '—'}</b>
            <br />
            Order: <b>{c.order.soNumber}</b>
            {c.order.poRef ? ` · PO ${c.order.poRef}` : ''}
          </>
        ) : (
          <>For any buyer</>
        )}
      </div>
      <table className="ct-table">
        <thead>
          <tr>
            <th>Style</th>
            <th>Item</th>
            <th>Sizes × pcs</th>
            <th style={{ textAlign: 'right' }}>Pcs</th>
          </tr>
        </thead>
        <tbody>
          {c.items.map((it) => (
            <tr key={`${it.itemId}|${it.grade}`}>
              <td>{it.style ?? '—'}</td>
              <td>
                <b>{it.code}</b> {it.colour ?? ''}
                {it.grade === 'B' ? ' · B-grade' : ''}
                <div style={{ fontSize: '6.5pt', color: '#333' }}>{it.name}</div>
                {it.description && <div style={{ fontSize: '6.5pt', color: '#555' }}>{it.description}</div>}
              </td>
              <td className="ct-sizes">
                {it.sizes.map((s) => (
                  <div key={s.sizeId}>
                    {s.code} × {s.qty}
                  </div>
                ))}
              </td>
              <td className="n">{it.pieces}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ct-foot">
        <span>
          {c.store.name} · packed {day(c.createdAt)}
          {c.notes ? ` · ${c.notes}` : ''}
        </span>
        <span className="ct-total">{c.pieces} pcs</span>
      </div>
    </div>
  )
}
