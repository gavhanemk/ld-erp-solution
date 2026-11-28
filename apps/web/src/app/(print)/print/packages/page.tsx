'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { PrintToolbar } from '@/components/print/PrintSheet'
import { QrCode } from '@/components/packages/QrCode'
import { Code128 } from '@/components/packages/Code128'
import { packLabel, qtyText } from '@/components/packages/packageTypes'
import { itemShade, type ShadeFields } from '@/lib/items'

interface Label extends ShadeFields {
  id: string
  code: string
  packType: string
  qty: number
  unit: string
  /** What is inside, when the item says: 288 pcs in 2 box. */
  content: { qty: number; unit: string } | null
  itemCode: string
  item: string
  category: string
  store: string
  lotNo: string | null
  /** The receipt's note on this package: "torn bag". */
  note?: string | null
  owner: string | null
  grnNumber: string | null
  supplier: string | null
  date: string
  /** Rejected at receipt and held: printed HOLD so nobody takes it to the floor. */
  held?: boolean
  /** The supplier's challan and our order it came against. */
  challanNo?: string | null
  poNumber?: string | null
  /** The style the goods were bought for. */
  styleNo?: string | null
  /** Bundle 2 of 5, when a receipt line came in more than one. */
  seq?: { n: number; of: number } | null
  rack?: string | null
  /** Its item's own number of copies, when not its kind's usual. */
  copies?: number | null
}
/** How a kind of package's sticker looks, from Stickers → Sticker settings. */
interface Template {
  size: 'sheet' | 'roll' | 'small' | 'custom'
  width?: number | null
  height?: number | null
  codes: 'both' | 'qr' | 'barcode'
  fields: string[]
  font: 'S' | 'M' | 'L'
  logo: boolean
  copies: number
}
interface Payload {
  company: string
  logo?: string | null
  templates?: Record<string, Template>
  packages: Label[]
}
/** A label for stock going out: what left, on which document, to whom. */
interface OutLabel extends ShadeFields {
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

type Layout = 'sheet' | 'roll' | 'small' | 'custom'
/** What a sticker is scanned by: a QR for a phone camera, a barcode for a handheld scanner, or both — or as each kind is set. */
type Codes = 'kind' | 'both' | 'qr' | 'bar'
const CODES: Record<Codes, string> = { kind: 'As set for each kind', both: 'QR code and barcode', qr: 'QR code only', bar: 'Barcode only' }
const FROM_TEMPLATE: Record<Template['codes'], Exclude<Codes, 'kind'>> = { both: 'both', qr: 'qr', barcode: 'bar' }
const FONT: Record<Template['font'], number> = { S: 0.85, M: 1, L: 1.15 }
/** A sticker's template: its kind's, else "Any package", else everything shown. */
const templateOf = (t: Payload['templates'], packType: string): Template | null => t?.[packType] ?? t?.DEFAULT ?? null
const shows = (t: Template | null, field: string) => !t || t.fields.includes(field)

const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })

/** Type sizes per layout, so the three stickers share one design at three scales. */
// `qrBoth` is the QR's size with a barcode under it; `bar` the barcode's height
// beside a QR, `barOnly` without one.
type Dim = { qr: string; qrBoth: string; bar: string; barOnly: string; id: string; tag: string; item: string; code: string; qty: string; unit: string; line: string; foot: string | null; gap: string }
const DIM: Record<Exclude<Layout, 'custom'>, Dim> = {
  sheet: { qr: '23mm', qrBoth: '18mm', bar: '5.5mm', barOnly: '7mm', id: '10.5pt', tag: '6pt', item: '8pt', code: '6.3pt', qty: '15pt', unit: '8pt', line: '6pt', foot: '5.5pt', gap: '2mm' },
  roll: { qr: '33mm', qrBoth: '22mm', bar: '7mm', barOnly: '11mm', id: '14pt', tag: '7.5pt', item: '10.5pt', code: '7.8pt', qty: '22pt', unit: '10pt', line: '7.4pt', foot: '7pt', gap: '3mm' },
  small: { qr: '15.5mm', qrBoth: '11.5mm', bar: '4.5mm', barOnly: '6mm', id: '8.5pt', tag: '5pt', item: '6.6pt', code: '5.4pt', qty: '11pt', unit: '6.4pt', line: '5.3pt', foot: null, gap: '1.5mm' },
}
/** A custom size takes the design of the nearest of the three. */
const nearest = (w: number, h: number): Exclude<Layout, 'custom'> => (w * h >= 2900 ? 'roll' : w * h >= 1600 ? 'sheet' : 'small')
/** The type in a size scaled for the kind's font setting; codes keep their size. */
const scaled = (d: Dim, f: number): Dim => {
  if (f === 1) return d
  const pt = (v: string) => `${(parseFloat(v) * f).toFixed(2)}pt`
  return { ...d, id: pt(d.id), tag: pt(d.tag), item: pt(d.item), code: pt(d.code), qty: pt(d.qty), unit: pt(d.unit), line: pt(d.line), foot: d.foot ? pt(d.foot) : null }
}

/**
 * One package sticker, read top to bottom in the order a storekeeper asks:
 * which package (the ID, large, with what kind it is — "BUNDLE 2/5"), what is
 * in it and how much, its lot and challan, and where it came from. The QR sits
 * at the left, the barcode along the bottom, or both; the ID is also printed
 * in full in the header, so a sticker the scanner cannot read can be typed.
 */
function Sticker({
  p,
  company,
  layout,
  codes: chosen,
  template: t,
  logo,
  custom,
}: {
  p: Label
  company: string
  layout: Layout
  codes: Codes
  template: Template | null
  logo: string | null
  custom: { w: number; h: number }
}) {
  const base = layout === 'custom' ? nearest(custom.w, custom.h) : layout
  const d = scaled(DIM[base], FONT[t?.font ?? 'M'])
  const codes: Exclude<Codes, 'kind'> = chosen === 'kind' ? FROM_TEMPLATE[t?.codes ?? 'both'] : chosen
  const roll = p.packType === 'ROLL'
  const tight = base === 'small'
  const qrSize = codes === 'both' ? d.qrBoth : d.qr
  // A fabric's design and colour, a thread's colour: the store picks the roll
  // or box by them, and same-name fabrics differ only there (27 Nov 2026).
  const shade = itemShade(p)
  // Its own line under the name, made room for in the same text area: the name
  // keeps to one line and the small lines sit closer. Stickers without one are
  // unchanged. The small sticker has no room for a line, so it rides on the last.
  const fit = Boolean(shade) && !tight
  const lh = fit ? 1.2 : undefined
  // With a barcode along the bottom there is less height: one line of name
  // where the sticker is wide enough.
  const nameLines = fit || tight || codes === 'bar' || (layout === 'sheet' && codes === 'both') ? 1 : 2
  const foot = codes === 'qr' && d.foot
  // What the kind is set to show (Stickers → Sticker settings); everything when not set.
  const codeLine = [shows(t, 'itemCode') ? p.itemCode : null, shows(t, 'style') && p.styleNo ? `Style ${p.styleNo}` : null].filter(Boolean).join(' · ')
  const lotLine = [
    shows(t, 'lot') ? (p.lotNo ? `Lot ${p.lotNo}` : roll ? 'No lot' : null) : null,
    shows(t, 'challan') && p.challanNo ? `Challan ${p.challanNo}` : null,
    shows(t, 'rack') && p.rack ? `Rack ${p.rack}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const docLine = [shows(t, 'document') ? (p.grnNumber ?? 'Labelled') : null, shows(t, 'document') ? day(p.date) : null, shows(t, 'po') ? p.poNumber : null].filter(Boolean).join(' · ')
  const note = shows(t, 'notes') ? p.note : null
  // A customer's material says so across the top, so it is never taken for ours.
  const where = shows(t, 'store') ? p.store : ''
  return (
    <div className="sticker pk">
      {p.held && (
        <div className="pk-cust" style={{ fontSize: d.tag, fontWeight: 800, letterSpacing: '0.04em' }}>
          HOLD — REJECTED, DO NOT ISSUE
        </div>
      )}
      {p.owner && (
        <div className="pk-cust" style={{ fontSize: d.tag }}>
          Customer material · {p.owner}
        </div>
      )}
      <div className="pk-head">
        {t?.logo && logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" className="pk-logo" style={{ height: d.id }} />
        )}
        <span className="pk-id" style={{ fontSize: d.id }}>{p.code}</span>
        {!foot && !tight && (
          <span className="pk-where" style={{ fontSize: d.tag }}>
            {where}
          </span>
        )}
        <span className="pk-tag" style={{ fontSize: d.tag }}>
          {packLabel(p.packType).toUpperCase()}
          {p.seq && shows(t, 'packNo') ? ` ${p.seq.n}/${p.seq.of}` : ''}
        </span>
      </div>
      <div className="pk-body" style={{ gap: d.gap }}>
        {codes !== 'bar' && (
          <div className="pk-qr" style={{ width: qrSize }}>
            <QrCode text={p.code} size={qrSize} />
          </div>
        )}
        <div className="pk-info">
          {fit ? (
            <div>
              <div className="pk-item" style={{ fontSize: d.item, WebkitLineClamp: nameLines }}>{p.item}</div>
              <div style={{ fontSize: d.line, fontWeight: 600, lineHeight: lh, ...clip }}>{shade}</div>
            </div>
          ) : (
            <div className="pk-item" style={{ fontSize: d.item, WebkitLineClamp: nameLines }}>{p.item}</div>
          )}
          {!tight && <div style={{ fontSize: d.code, fontFamily: 'ui-monospace, monospace', lineHeight: lh, ...clip }}>{codeLine}</div>}
          <div className="pk-qty" style={fit ? { margin: 0 } : undefined}>
            <span style={{ fontSize: d.qty, fontWeight: 800, lineHeight: 1 }}>{roll ? p.qty.toFixed(2) : qtyText(p.qty)}</span>
            <span style={{ fontSize: d.unit, fontWeight: 700 }}>{p.unit}</span>
            {/* What is inside: "1 box · 144 pcs". */}
            {p.content && shows(t, 'contents') && (
              <span style={{ fontSize: d.unit, fontWeight: 700, whiteSpace: 'nowrap' }}>
                · {qtyText(p.content.qty)} {p.content.unit}
              </span>
            )}
          </div>
          {tight ? (
            // Room for one line: the lot first, as it is what a roll is picked by,
            // then its design and colour; the document gives way first.
            <div style={{ fontSize: d.line, ...clip }}>
              {p.lotNo && shows(t, 'lot') ? <b>Lot {p.lotNo} · </b> : null}
              {shade ? `${shade}${shows(t, 'document') ? ' · ' : ''}` : null}
              {shows(t, 'document') ? (p.grnNumber ?? day(p.date)) : null}
            </div>
          ) : (
            <>
              {/* The receipt's note on this package rides on the lot line, so no other line is pushed off. */}
              {(lotLine || note) && (
                <div style={{ fontSize: d.line, fontWeight: 700, lineHeight: lh, ...clip }}>
                  {lotLine}
                  {note && <i>{lotLine ? ' · ' : ''}{note}</i>}
                </div>
              )}
              {docLine && <div style={{ fontSize: d.line, lineHeight: lh, ...clip }}>{docLine}</div>}
            </>
          )}
        </div>
      </div>
      {codes !== 'qr' && (
        <div className="pk-bar" style={{ height: codes === 'bar' ? d.barOnly : d.bar }}>
          <Code128 text={p.code} />
        </div>
      )}
      {foot && (
        <div className="pk-foot" style={{ fontSize: foot }}>
          {/* Who sent it, when it came from a supplier: every sticker is ours anyway. */}
          <span style={clip}>{(shows(t, 'supplier') ? p.supplier : null) ?? company}</span>
          <span style={{ ...clip, textAlign: 'right' }}>{where}</span>
        </div>
      )}
    </div>
  )
}

const clip = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const

/**
 * The label stuck on stock as it leaves: the document number large, as its QR
 * too, then what it is, how much, and where it is going. Same sizes and lines
 * as a package sticker, so one sheet can carry both.
 */
function OutSticker({ o, company, layout, codes: chosen, custom }: { o: OutLabel; company: string; layout: Layout; codes: Codes; custom: { w: number; h: number } }) {
  const base = layout === 'custom' ? nearest(custom.w, custom.h) : layout
  const d = DIM[base]
  const codes: Exclude<Codes, 'kind'> = chosen === 'kind' ? 'both' : chosen
  const qrSize = codes === 'both' ? d.qrBoth : d.qr
  const foot = codes === 'qr' && d.foot
  // Its design and colour as on the package sticker: a line of its own, or on the code line of a small one.
  const shade = itemShade(o)
  const fit = Boolean(shade) && base !== 'small'
  const lh = fit ? 1.2 : undefined
  const nameLines = fit || base === 'small' || codes === 'bar' || (base === 'sheet' && codes === 'both') ? 1 : 2
  return (
    <div className="sticker pk">
      {o.owner && (
        <div className="pk-cust" style={{ fontSize: d.tag }}>
          Customer material · {o.owner}
        </div>
      )}
      <div className="pk-head">
        <span className="pk-id" style={{ fontSize: d.id }}>{o.docNumber}</span>
        <span className="pk-tag" style={{ fontSize: d.tag }}>
          {o.tag}
        </span>
      </div>
      <div className="pk-body" style={{ gap: d.gap }}>
        {codes !== 'bar' && (
          <div className="pk-qr" style={{ width: qrSize }}>
            <QrCode text={o.docNumber} size={qrSize} />
          </div>
        )}
        <div className="pk-info">
          {fit ? (
            <div>
              <div className="pk-item" style={{ fontSize: d.item, WebkitLineClamp: nameLines }}>{o.item}</div>
              <div style={{ fontSize: d.line, fontWeight: 600, lineHeight: lh, ...clip }}>{shade}</div>
            </div>
          ) : (
            <div className="pk-item" style={{ fontSize: d.item, WebkitLineClamp: nameLines }}>{o.item}</div>
          )}
          <div style={{ fontSize: d.code, fontFamily: 'ui-monospace, monospace', lineHeight: lh, ...clip }}>
            {o.itemCode}
            {shade && !fit && <span style={{ fontFamily: 'Inter, system-ui, sans-serif' }}> · {shade}</span>}
          </div>
          <div className="pk-qty" style={fit ? { margin: 0 } : undefined}>
            <span style={{ fontSize: d.qty, fontWeight: 800, lineHeight: 1 }}>{qtyText(o.qty)}</span>
            <span style={{ fontSize: d.unit, fontWeight: 700 }}>{o.unit}</span>
          </div>
          <div style={{ fontSize: d.line, fontWeight: 700, lineHeight: lh, ...clip }}>To {o.to}</div>
          {base !== 'small' && (
            <div style={{ fontSize: d.line, lineHeight: lh, ...clip }}>
              From {o.from} · {day(o.date)}
            </div>
          )}
        </div>
      </div>
      {codes !== 'qr' && (
        <div className="pk-bar" style={{ height: codes === 'bar' ? d.barOnly : d.bar }}>
          <Code128 text={o.docNumber} />
        </div>
      )}
      {foot && (
        <div className="pk-foot" style={{ fontSize: foot }}>
          <span style={clip}>{company}</span>
          <span style={{ ...clip, textAlign: 'right' }}>{o.from}</span>
        </div>
      )}
    </div>
  )
}

const SIZES: Record<Exclude<Layout, 'custom'>, { label: string; page: string }> = {
  sheet: { label: 'A4 sheet, 24 a page (70 × 37 mm)', page: 'A4' },
  roll: { label: 'Label printer, 75 × 50 mm', page: '75mm 50mm' },
  small: { label: 'Label printer, 50 × 25 mm', page: '50mm 25mm' },
}
/** The kind most of these packages are, whose settings choose the size. */
function usualTemplate(d: Payload): Template | null {
  const count = new Map<string, number>()
  for (const p of d.packages) count.set(p.packType, (count.get(p.packType) ?? 0) + 1)
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  return top ? templateOf(d.templates, top) : null
}

/**
 * The QR stickers for labelled packages: on an A4 sheet of 24, or one a page
 * on a label printer, large (75 × 50) or small (50 × 25). The choice is
 * remembered on this computer, since each desk has the printer it has.
 *
 * With `out=TYPE:id` it also prints the labels for stock going out on that
 * document — an issue, a challan, a return — ahead of the new stickers for
 * parts of rolls and boxes that moved to another store.
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
  const [codes, setCodes] = useState<Codes>('kind')
  // 0: as set for each kind (and each item's own number); else that many of every one.
  const [copies, setCopies] = useState(0)
  const [custom, setCustom] = useState({ w: 70, h: 37 })
  const savedLayout = useRef<Layout | null>(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('package-label-layout') as Layout | null
      if (saved && (saved in SIZES || saved === 'custom')) {
        savedLayout.current = saved
        setLayout(saved)
      }
      const savedCodes = localStorage.getItem('package-label-codes') as Codes | null
      if (savedCodes && savedCodes in CODES) setCodes(savedCodes)
    } catch {
      /* no storage: the sticker settings decide */
    }
  }, [])

  useEffect(() => {
    if (!ids && !out) {
      setError('Open the stickers from Inventory → Stickers & Scan.')
      return
    }
    const [type, id] = out.split(':')
    Promise.all([
      ids ? api.get<{ data: Payload }>(`/packages/labels?ids=${ids}`).then((r) => r.data) : null,
      out ? api.get<{ data: { company: string; labels: OutLabel[] } }>(`/packages/outward-labels?${new URLSearchParams({ type, id, q })}`).then((r) => r.data) : null,
    ])
      .then(([pk, ow]) => {
        setOutward(ow?.labels ?? [])
        const loaded: Payload = { company: pk?.company || ow?.company || '', logo: pk?.logo ?? null, templates: pk?.templates, packages: pk?.packages ?? [] }
        setData(loaded)
        // The size this computer picked before; else the one the usual kind is set to.
        const usual = usualTemplate(loaded)
        if (usual?.size === 'custom' && usual.width && usual.height) setCustom({ w: usual.width, h: usual.height })
        if (!savedLayout.current && usual) setLayout(usual.size === 'custom' && !(usual.width && usual.height) ? 'sheet' : usual.size)
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
  const pickCodes = (c: Codes) => {
    setCodes(c)
    try {
      localStorage.setItem('package-label-codes', c)
    } catch {
      /* fine without it */
    }
  }

  if (error) return <p style={{ padding: 48, color: '#fff' }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: '#ddd' }}>Opening the stickers…</p>
  if (!data.packages.length && !outward.length) return <p style={{ padding: 48, color: '#fff' }}>No packages to print.</p>

  // Labels for what went out first, then the new stickers for parts that moved.
  // Copies: as chosen, else each item's own number, else its kind's.
  const copiesOf = (p: Label) => copies || p.copies || templateOf(data.templates, p.packType)?.copies || 1
  const all = [
    ...outward.flatMap((o) => Array.from({ length: copies || 1 }, (_, i) => ({ o, p: null, key: `out-${o.key}-${i}` }))),
    ...data.packages.flatMap((p) => Array.from({ length: copiesOf(p) }, (_, i) => ({ o: null, p, key: `${p.id}-${i}` }))),
  ]
  const one = ({ o, p, key }: (typeof all)[number]) =>
    o ? (
      <OutSticker key={key} o={o} company={data.company} layout={layout} codes={codes} custom={custom} />
    ) : (
      <Sticker key={key} p={p!} company={data.company} layout={layout} codes={codes} template={templateOf(data.templates, p!.packType)} logo={data.logo ?? null} custom={custom} />
    )
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
        .pk-cust { flex-shrink: 0; background: #000; color: #fff; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
                   line-height: 1.3; padding: 0.2mm 1mm; margin-bottom: 0.7mm; border-radius: 0.5mm;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pk-tag { border: 0.25mm solid #000; border-radius: 0.6mm; padding: 0.2mm 0.8mm; font-weight: 700; letter-spacing: .06em; line-height: 1.2; }
        .pk-body { display: flex; flex: 1; min-height: 0; align-items: center; overflow: hidden; }
        .pk-qr { flex-shrink: 0; }
        .pk-info { min-width: 0; max-height: 100%; flex: 1; display: flex; flex-direction: column; justify-content: safe center; gap: 0.3mm; }
        .pk-info > * { flex-shrink: 0; }
        .pk-where { flex: 1; min-width: 0; text-align: right; color: #333; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pk-item { font-weight: 700; line-height: 1.22; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .pk-qty { display: flex; align-items: baseline; gap: 1mm; margin: 0.3mm 0; }
        .pk-bar { flex-shrink: 0; margin-top: 0.8mm; }
        .pk-foot { display: flex; justify-content: space-between; gap: 2mm; border-top: 0.2mm solid #999; padding-top: 0.5mm; margin-top: 0.8mm; color: #333; }
        .sheet { width: 210mm; height: 296mm; margin: 0 auto 12px; background: #fff; display: grid;
                 grid-template-columns: repeat(3, 70mm); grid-auto-rows: 37mm; }
        .sheet .sticker { padding: 2mm 2.5mm; border: 0.2mm dashed #bbb; }
        .roll { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .roll .sticker { width: 75mm; height: 50mm; padding: 2.5mm 3mm; border: 0.2mm dashed #bbb; }
        .small { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .small .sticker { width: 50mm; height: 25mm; padding: 1.5mm 2mm; border: 0.2mm dashed #bbb; }
        .custom { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .custom .sticker { width: ${custom.w}mm; height: ${custom.h}mm; padding: 2mm 2.5mm; border: 0.2mm dashed #bbb; }
        .pk-logo { width: auto; max-width: 18mm; object-fit: contain; flex-shrink: 0; }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
          .sheet { margin: 0; break-after: page; }
          .sheet .sticker { border: 0; }
          .roll, .small, .custom { gap: 0; }
          .roll .sticker, .small .sticker, .custom .sticker { border: 0; break-after: page; }
          .sticker, .sticker * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        @page { size: ${layout === 'custom' ? `${custom.w}mm ${custom.h}mm` : SIZES[layout].page}; margin: 0; }
      `}</style>
      <PrintToolbar backHref="/inventory/packages" backLabel="Packages" copies={1} fileName={`Stickers ${outward[0]?.docNumber ?? data.packages[0]?.code ?? ''}`} />
      <div className="no-print sticker-options">
        <label>
          Stickers on
          <select value={layout} onChange={(e) => pick(e.target.value as Layout)}>
            {(Object.keys(SIZES) as Array<keyof typeof SIZES>).map((l) => (
              <option key={l} value={l}>
                {SIZES[l].label}
              </option>
            ))}
            <option value="custom">
              Label printer, {custom.w} × {custom.h} mm
            </option>
          </select>
        </label>
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
        <label>
          {outward.length ? 'Copies' : 'Per package'}
          <select value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
            <option value={0}>As set</option>
            <option value={1}>One</option>
            <option value={2}>Two</option>
            <option value={3}>Three</option>
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
