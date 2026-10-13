'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
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
/** A label for stock going out: what left, on which document, to whom. */
interface OutLabel {
  key: string
  tag: string
  docNumber: string
  item: string
  itemCode: string
  qty: number
  unit: string
  to: string
  from: string
  owner: string | null
  date: string
}

type Layout = 'sheet' | 'roll' | 'small'

const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })

/** Type sizes per layout, so the three stickers share one design at three scales. */
const DIM: Record<Layout, { qr: string; id: string; tag: string; item: string; code: string; qty: string; unit: string; line: string; foot: string | null; gap: string }> = {
  sheet: { qr: '23mm', id: '10.5pt', tag: '6pt', item: '8pt', code: '6.3pt', qty: '15pt', unit: '8pt', line: '6pt', foot: '5.5pt', gap: '2mm' },
  roll: { qr: '33mm', id: '14pt', tag: '7.5pt', item: '10.5pt', code: '7.8pt', qty: '22pt', unit: '10pt', line: '7.4pt', foot: '7pt', gap: '3mm' },
  small: { qr: '15.5mm', id: '8.5pt', tag: '5pt', item: '6.6pt', code: '5.4pt', qty: '11pt', unit: '6.4pt', line: '5.3pt', foot: null, gap: '1.5mm' },
}

/**
 * One package sticker, read top to bottom in the order a storekeeper asks:
 * which package (the ID, large, with what kind it is), what is in it and how
 * much, where it came from. The QR sits at the left at the largest size the
 * sticker allows; the ID is also printed in full in the header, so a sticker
 * the scanner cannot read can still be typed.
 *
 * A roll of fabric reads differently from a box of trims: its metres are the
 * figure people look for, with the lot and the supplier, so it has a layout
 * of its own.
 */
function Sticker({ p, company, layout }: { p: Label; company: string; layout: Layout }) {
  const d = DIM[layout]
  const roll = p.packType === 'ROLL'
  const clip = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const
  const inward = p.grnNumber ? `${p.grnNumber} · ${day(p.date)}` : `Labelled ${day(p.date)}`
  return (
    <div className="sticker pk">
      <div className="pk-head">
        <span className="pk-id" style={{ fontSize: d.id }}>{p.code}</span>
        <span className="pk-tag" style={{ fontSize: d.tag }}>
          {packLabel(p.packType).toUpperCase()}
        </span>
      </div>
      <div className="pk-body" style={{ gap: d.gap }}>
        <div className="pk-qr" style={{ width: d.qr }}>
          <QrCode text={p.code} size={d.qr} />
        </div>
        <div className="pk-info">
          <div className="pk-item" style={{ fontSize: d.item, WebkitLineClamp: layout === 'small' ? 1 : 2 }}>{p.item}</div>
          <div style={{ fontSize: d.code, fontFamily: 'ui-monospace, monospace', ...clip }}>{p.itemCode}</div>
          <div className="pk-qty">
            <span style={{ fontSize: d.qty, fontWeight: 800, lineHeight: 1 }}>{roll ? p.qty.toFixed(2) : qtyText(p.qty)}</span>
            <span style={{ fontSize: d.unit, fontWeight: 700 }}>{p.unit}</span>
          </div>
          {layout === 'small' ? (
            // Room for one line: the lot first, as it is what a roll is picked by.
            <div style={{ fontSize: d.line, ...clip }}>
              {p.lotNo ? <b>Lot {p.lotNo} · </b> : null}
              {p.grnNumber ?? day(p.date)}
            </div>
          ) : roll ? (
            <>
              <div style={{ fontSize: d.line, fontWeight: 700, ...clip }}>{p.lotNo ? `Lot ${p.lotNo}` : 'No lot'}</div>
              <div style={{ fontSize: d.line, ...clip }}>{inward}</div>
              {p.supplier && <div style={{ fontSize: d.line, color: '#333', ...clip }}>{p.supplier}</div>}
            </>
          ) : (
            <>
              <div style={{ fontSize: d.line, ...clip }}>{inward}</div>
              {p.lotNo && <div style={{ fontSize: d.line, fontWeight: 700, ...clip }}>Lot {p.lotNo}</div>}
            </>
          )}
        </div>
      </div>
      {d.foot && (
        <div className="pk-foot" style={{ fontSize: d.foot }}>
          <span style={clip}>{company}</span>
          <span style={{ ...clip, textAlign: 'right' }}>
            {p.store}
            {p.owner ? ` · ${p.owner}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The label stuck on stock as it leaves: the document number large, as its QR
 * too, then what it is, how much, and where it is going. Same sizes and lines
 * as a package sticker, so one sheet can carry both.
 */
function OutSticker({ o, company, layout }: { o: OutLabel; company: string; layout: Layout }) {
  const d = DIM[layout]
  const clip = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const
  return (
    <div className="sticker pk">
      <div className="pk-head">
        <span className="pk-id" style={{ fontSize: d.id }}>{o.docNumber}</span>
        <span className="pk-tag" style={{ fontSize: d.tag }}>
          {o.tag}
        </span>
      </div>
      <div className="pk-body" style={{ gap: d.gap }}>
        <div className="pk-qr" style={{ width: d.qr }}>
          <QrCode text={o.docNumber} size={d.qr} />
        </div>
        <div className="pk-info">
          <div className="pk-item" style={{ fontSize: d.item, WebkitLineClamp: layout === 'small' ? 1 : 2 }}>{o.item}</div>
          <div style={{ fontSize: d.code, fontFamily: 'ui-monospace, monospace', ...clip }}>{o.itemCode}</div>
          <div className="pk-qty">
            <span style={{ fontSize: d.qty, fontWeight: 800, lineHeight: 1 }}>{qtyText(o.qty)}</span>
            <span style={{ fontSize: d.unit, fontWeight: 700 }}>{o.unit}</span>
          </div>
          <div style={{ fontSize: d.line, fontWeight: 700, ...clip }}>To {o.to}</div>
          {layout !== 'small' && (
            <div style={{ fontSize: d.line, ...clip }}>
              From {o.from} · {day(o.date)}
            </div>
          )}
        </div>
      </div>
      {d.foot && (
        <div className="pk-foot" style={{ fontSize: d.foot }}>
          <span style={clip}>{company}</span>
          <span style={{ ...clip, textAlign: 'right' }}>{o.owner ? `${o.owner}'s` : ''}</span>
        </div>
      )}
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
 *
 * With `out=TYPE:id` it also prints the labels for stock going out on that
 * document — an issue, a challan, a return — ahead of the fresh stickers for
 * what was left in the rolls and boxes it came from.
 */
function Stickers() {
  const params = useSearchParams()
  const ids = params.get('ids') ?? ''
  const out = params.get('out') ?? ''
  const q = params.get('q') ?? ''
  const [data, setData] = useState<Payload | null>(null)
  const [outward, setOutward] = useState<OutLabel[]>([])
  const marked = useRef(false)
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
    if (!ids && !out) {
      setError('Open the stickers from Packages & Stickers.')
      return
    }
    const [type, id] = out.split(':')
    Promise.all([
      ids ? api.get<{ data: Payload }>(`/packages/labels?ids=${ids}`).then((r) => r.data) : null,
      out ? api.get<{ data: { company: string; labels: OutLabel[] } }>(`/packages/outward-labels?${new URLSearchParams({ type, id, q })}`).then((r) => r.data) : null,
    ])
      .then(([pk, ow]) => {
        setOutward(ow?.labels ?? [])
        setData({ company: pk?.company || ow?.company || '', packages: pk?.packages ?? [] })
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the stickers.'))
  }, [ids, out, q])

  // Counted once, when the print box opens: that is a print, opening the page
  // is not. Printed stickers leave "Ready to print".
  useEffect(() => {
    if (!data?.packages.length) return
    const mark = () => {
      if (marked.current) return
      marked.current = true
      void api.post('/packages/printed', { ids: data.packages.map((p) => p.id) }).catch(() => {})
    }
    window.addEventListener('beforeprint', mark)
    return () => window.removeEventListener('beforeprint', mark)
  }, [data])

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
  if (!data.packages.length && !outward.length) return <p style={{ padding: 48, color: '#fff' }}>No packages to print.</p>

  // Labels for what went out first, then the fresh stickers for what is left.
  const all = [
    ...outward.flatMap((o) => Array.from({ length: copies }, (_, i) => ({ o, p: null, key: `out-${o.key}-${i}` }))),
    ...data.packages.flatMap((p) => Array.from({ length: copies }, (_, i) => ({ o: null, p, key: `${p.id}-${i}` }))),
  ]
  const one = ({ o, p, key }: (typeof all)[number]) =>
    o ? <OutSticker key={key} o={o} company={data.company} layout={layout} /> : <Sticker key={key} p={p!} company={data.company} layout={layout} />
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
        .pk { display: flex; flex-direction: column; }
        .pk-head { display: flex; align-items: center; justify-content: space-between; gap: 1.5mm;
                   border-bottom: 0.3mm solid #000; padding-bottom: 0.6mm; margin-bottom: 0.9mm; }
        .pk-id { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-weight: 800; letter-spacing: .02em; line-height: 1; }
        .pk-tag { border: 0.25mm solid #000; border-radius: 0.6mm; padding: 0.2mm 0.8mm; font-weight: 700; letter-spacing: .06em; line-height: 1.2; }
        .pk-body { display: flex; flex: 1; min-height: 0; align-items: center; }
        .pk-qr { flex-shrink: 0; }
        .pk-info { min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 0.5mm; }
        .pk-item { font-weight: 700; line-height: 1.15; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .pk-qty { display: flex; align-items: baseline; gap: 1mm; margin: 0.3mm 0; }
        .pk-foot { display: flex; justify-content: space-between; gap: 2mm; border-top: 0.2mm solid #999; padding-top: 0.5mm; margin-top: 0.8mm; color: #333; }
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
      <PrintToolbar backHref="/inventory/packages" backLabel="Packages" copies={1} fileName={`Stickers ${outward[0]?.docNumber ?? data.packages[0]?.code ?? ''}`} />
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
          {outward.length ? 'Copies' : 'Per package'}
          <select value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
            <option value={1}>One</option>
            <option value={2}>Two</option>
          </select>
        </label>
        <span style={{ color: '#5a6880', fontSize: 12 }}>
          {outward.length > 0 && `${outward.length} going out · `}
          {data.packages.length > 0 && `${data.packages.length} ${data.packages.length === 1 ? 'package' : 'packages'} · `}
          {all.length} {all.length === 1 ? 'sticker' : 'stickers'}
        </span>
      </div>
      {layout === 'sheet' ? (
        sheets.map((page, i) => (
          <div key={i} className="sheet">
            {page.map(one)}
          </div>
        ))
      ) : (
        <div className={layout}>
          {all.map(one)}
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
