'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { QrCode } from '@/components/packages/QrCode'
import { packLabel, qtyText } from '@/components/packages/packageTypes'

interface Label {
  id: string
  code: string
  packType: string
  qty: number
  unit: string
  itemCode: string
  item: string
  category: string
  store: string
  lotNo: string | null
  owner: string | null
  grnNumber: string | null
  supplier: string | null
  date: string
}
interface Payload {
  company: string
  packages: Label[]
}

type Layout = 'sheet' | 'roll' | 'small'

const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })

/**
 * One sticker: the QR on the left, what is in the package on the right, and
 * the code in print under the QR so it can be typed when a scanner fails.
 */
function Sticker({ p, company, layout }: { p: Label; company: string; layout: Layout }) {
  const small = layout === 'small'
  const big = layout === 'roll'
  const clip = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const
  return (
    <div className="sticker" style={{ display: 'flex', gap: small ? '1.5mm' : '2.5mm', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <QrCode text={p.code} size={small ? '19mm' : big ? '38mm' : '27mm'} />
        <div style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: small ? '6.5pt' : big ? '9pt' : '7.5pt', letterSpacing: '.03em' }}>{p.code}</div>
      </div>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        {!small && <div style={{ fontSize: big ? '7pt' : '5.8pt', color: '#333', ...clip }}>{company}</div>}
        <div
          style={{
            fontSize: small ? '7pt' : big ? '11pt' : '8pt',
            fontWeight: 700,
            lineHeight: 1.15,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {p.item}
        </div>
        <div style={{ fontSize: small ? '6pt' : big ? '8pt' : '6.5pt', fontFamily: 'ui-monospace, monospace', ...clip }}>
          {p.itemCode}
          {p.lotNo ? ` · Lot ${p.lotNo}` : ''}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.5mm' }}>
          <span style={{ fontSize: small ? '11pt' : big ? '20pt' : '14pt', fontWeight: 800 }}>{qtyText(p.qty)}</span>
          <span style={{ fontSize: small ? '7pt' : big ? '10pt' : '8pt', fontWeight: 600 }}>{p.unit}</span>
          <span style={{ fontSize: small ? '6pt' : big ? '8pt' : '6.5pt', color: '#333', marginLeft: 'auto' }}>{packLabel(p.packType)}</span>
        </div>
        {!small && (
          <div style={{ fontSize: big ? '7pt' : '5.8pt', color: '#333', ...clip }}>
            {p.store}
            {p.owner ? ` · ${p.owner}` : ''}
          </div>
        )}
        {!small && (
          <div style={{ fontSize: big ? '7pt' : '5.8pt', color: '#333', ...clip }}>
            {p.grnNumber ? `${p.grnNumber} · ` : ''}
            {day(p.date)}
            {p.supplier && big ? ` · ${p.supplier}` : ''}
          </div>
        )}
      </div>
    </div>
  )
}

const SIZES: Record<Layout, { label: string; page: string }> = {
  sheet: { label: 'A4 sheet, 24 a page (70 × 37 mm)', page: 'A4' },
  roll: { label: 'Label printer, 75 × 50 mm', page: '75mm 50mm' },
  small: { label: 'Label printer, 50 × 25 mm', page: '50mm 25mm' },
}

/**
 * The QR stickers for labelled packages: on an A4 sheet of 24, or one a page
 * on a label printer, large (75 × 50) or small (50 × 25). The choice is
 * remembered on this computer, since each desk has the printer it has.
 */
function Stickers() {
  const params = useSearchParams()
  const ids = params.get('ids') ?? ''
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [layout, setLayout] = useState<Layout>('sheet')
  const [copies, setCopies] = useState(1)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('package-label-layout') as Layout | null
      if (saved && saved in SIZES) setLayout(saved)
    } catch {
      /* no storage: keep the sheet */
    }
  }, [])

  useEffect(() => {
    if (!ids) {
      setError('Open the stickers from Packages & Stickers.')
      return
    }
    api
      .get<{ data: Payload }>(`/packages/labels?ids=${ids}`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the packages.'))
  }, [ids])

  const pick = (l: Layout) => {
    setLayout(l)
    try {
      localStorage.setItem('package-label-layout', l)
    } catch {
      /* fine without it */
    }
  }

  if (error) return <p style={{ padding: 48, color: '#fff' }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: '#ddd' }}>Opening the stickers…</p>
  if (!data.packages.length) return <p style={{ padding: 48, color: '#fff' }}>No packages to print.</p>

  const all = data.packages.flatMap((p) => Array.from({ length: copies }, (_, i) => ({ p, key: `${p.id}-${i}` })))
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
        .sticker { box-sizing: border-box; overflow: hidden; color: #000; background: #fff; font-family: Inter, system-ui, sans-serif; }
        .sheet { width: 210mm; height: 296mm; margin: 0 auto 12px; background: #fff; display: grid;
                 grid-template-columns: repeat(3, 70mm); grid-auto-rows: 37mm; }
        .sheet .sticker { padding: 2mm 2.5mm; border: 0.2mm dashed #bbb; }
        .roll { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .roll .sticker { width: 75mm; height: 50mm; padding: 2.5mm 3mm; border: 0.2mm dashed #bbb; }
        .small { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .small .sticker { width: 50mm; height: 25mm; padding: 1.5mm 2mm; border: 0.2mm dashed #bbb; }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
          .sheet { margin: 0; break-after: page; }
          .sheet .sticker { border: 0; }
          .roll, .small { gap: 0; }
          .roll .sticker, .small .sticker { border: 0; break-after: page; }
          .sticker, .sticker * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        @page { size: ${SIZES[layout].page}; margin: 0; }
      `}</style>
      <PrintToolbar backHref="/inventory/packages" backLabel="Packages" copies={1} fileName={`Stickers ${data.packages[0].code}`} />
      <div className="no-print sticker-options">
        <label>
          Stickers on
          <select value={layout} onChange={(e) => pick(e.target.value as Layout)}>
            {(Object.keys(SIZES) as Layout[]).map((l) => (
              <option key={l} value={l}>
                {SIZES[l].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Per package
          <select value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
            <option value={1}>One</option>
            <option value={2}>Two</option>
          </select>
        </label>
        <span style={{ color: '#5a6880', fontSize: 12 }}>
          {data.packages.length} {data.packages.length === 1 ? 'package' : 'packages'} · {all.length} {all.length === 1 ? 'sticker' : 'stickers'}
        </span>
      </div>
      {layout === 'sheet' ? (
        sheets.map((page, i) => (
          <div key={i} className="sheet">
            {page.map(({ p, key }) => (
              <Sticker key={key} p={p} company={data.company} layout={layout} />
            ))}
          </div>
        ))
      ) : (
        <div className={layout}>
          {all.map(({ p, key }) => (
            <Sticker key={key} p={p} company={data.company} layout={layout} />
          ))}
        </div>
      )}
    </>
  )
}

export default function PrintPackages() {
  return (
    <Suspense fallback={<p style={{ padding: 48, color: '#ddd' }}>Opening the stickers…</p>}>
      <Stickers />
    </Suspense>
  )
}
