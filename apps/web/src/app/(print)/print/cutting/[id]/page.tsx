'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  CODE,
  Dash,
  Eyebrow,
  Note,
  PartyLine,
  TotalsBox,
  WordsAndTotals,
  qty,
  longDate,
  shortDate,
  INK,
  MUTED,
  type SheetColumn,
} from '@/components/print/StoreSheet'
import { HAIR, LINE } from '@/components/print/doc'
import { moCustomer } from '@/components/production/moCustomer'
import { itemShadeCols, type ShadeFields } from '@/lib/items'

interface Payload {
  /** The own brand the order is made under, carried from start to end. */
  brand?: { name: string; type: string } | null
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  waitingAtCutting: number
  /** Bundles made later from this lay's, as another size at stitching: not cut here, so only named under the list. */
  madeAsOtherSize: Array<{ id: string; bundleNo: number; size: string; qty: number; fromBundleNo: number; fromSize: string; step: string }>
  cutting: {
    cutOrderNumber: string
    cutDate: string
    status: string
    fabricIssued: string | number | null
    fabricUsed: string | number | null
    wastage: string | number | null
    noOfLayers: number | string | null
    lotNo: string | null
    ratio: string | null
    cutterName: string | null
    bundleSize: number | null
    sizeBreakup: Record<string, number> | null
    plannedBreakup: Record<string, number> | null
    actualPieces: number
    notes: string | null
    createdBy: { name: string } | null
    /** With the fabric's own design no. and colour (the garment's are the order's). */
    fabricItem: ({ code: string; name: string; uom: { symbol: string } | null } & ShadeFields) | null
    moLine: { color: string; totalQty: number; style: { code: string; name: string }; sizes: Array<{ sizeId: string; qty: number; size: { code: string; sequence: number } }> } | null
    mo: { id: string; moNumber: string; totalPlannedQty: number; so: { soNumber: string; customerPORef: string | null; customer: { name: string } } | null }
    bundles: Array<{ id: string; code: string; bundleNo: number; qty: number; size: { code: string } | null }>
  }
}

/** Facts run on across a band: a bold label, its value, then the next — wrapping, never squeezed. */
function Facts({ items }: { items: Array<[string, React.ReactNode, boolean?] | null | false> }) {
  const shown = items.filter(Boolean) as Array<[string, React.ReactNode, boolean?]>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '18px', rowGap: '1px' }}>
      {shown.map(([label, value, mono]) => (
        <span key={label}>
          <span style={{ fontWeight: 700 }}>{label}</span>
          <span style={{ marginLeft: '5px', ...(mono && value ? CODE : {}) }}>{value || value === 0 ? value : <Dash />}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * The cutting document: what the cutting room was given and what it cut, for
 * one lay of one line of the order. Order, fabric and the lay above; the
 * pieces by size — on the order, planned for this lay, actually cut — and the
 * bundles tied from them below (any made from them later as another size at
 * stitching are named under the list, not as cut). Signed by whoever
 * prepared it, the cutting master, and whoever issued the fabric.
 *
 * Laid out like the purchase order (27 Nov 2026): the cutting master in the
 * "To," block with the order's facts under the name and the cutting's number,
 * date and references beside it; the fabric and the lay in bands; the fabric
 * given, used and left over beside the pieces cut.
 */
export default function PrintCutting() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/production/cutting/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that cutting.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the cutting…</p>

  const { company, template, cutting: c } = data
  const sizes = c.moLine ? [...c.moLine.sizes].sort((a, b) => a.size.sequence - b.size.sequence) : []
  const used = Number(c.fabricUsed ?? 0)
  const average = c.actualPieces > 0 ? used / c.actualPieces : 0
  const uom = c.fabricItem?.uom?.symbol ?? ''
  const planned = c.plannedBreakup ?? {}
  const cut = c.sizeBreakup ?? {}
  const bNo = (n: number) => `B${String(n).padStart(3, '0')}`
  const later = data.madeAsOtherSize ?? []
  // The fabric's own design no. and colour, from its item. "Colour" and "Style" above them are
  // the garment's (the order line's colour and the style code; "Style" was "Design no." before 27 Nov 2026).
  const fabricShade = itemShadeCols(c.fabricItem)

  // Sizes run across the page, as on the floor's own sheet. Past ten, the
  // label and total give up some room and the figures drop a point, so every
  // size keeps a column of its own.
  const many = sizes.length > 10
  const labelW = sizes.length ? (many ? 14 : 22) : 60
  const totalW = many ? 10 : 12
  const columns: SheetColumn[] = [
    { key: 'what', head: 'Sizes', width: `${labelW}%` },
    ...sizes.map((z) => ({
      key: z.sizeId,
      head: z.size.code,
      width: `${((100 - labelW - totalW) / Math.max(1, sizes.length)).toFixed(3)}%`,
      align: 'center' as const,
    })),
    { key: 'total', head: 'Total', width: `${totalW}%`, align: 'right' },
  ]
  const fig = (v: React.ReactNode) => (many ? <span style={{ fontSize: '8.5px' }}>{v}</span> : v)
  const row = (key: string, label: string, get: (sizeId: string) => number | null, total: number | null, strong = false) => ({
    key,
    cells: {
      what: <span style={{ fontWeight: strong ? 700 : 500 }}>{label}</span>,
      ...Object.fromEntries(sizes.map((z) => [z.sizeId, get(z.sizeId) ? fig(strong ? <strong>{qty(get(z.sizeId)!)}</strong> : qty(get(z.sizeId)!)) : ''])),
      total: total ? (strong ? <strong>{qty(total)}</strong> : qty(total)) : '',
    },
  })
  const rows = sizes.length
    ? [
        row('order', 'On the order (count)', (s) => sizes.find((z) => z.sizeId === s)?.qty ?? null, c.moLine?.totalQty ?? null),
        row('lay', 'This lay, planned', (s) => planned[s] ?? null, Object.values(planned).reduce((a, b) => a + b, 0) || null),
        row('cut', 'Actual cutting', (s) => cut[s] ?? null, c.actualPieces, true),
      ]
    : [{ key: 'cut', cells: { what: 'Actual cutting', total: <strong>{qty(c.actualPieces)}</strong> } }]

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={c.cutOrderNumber}
      dateLabel="Cut on"
      date={longDate(c.cutDate) ?? ''}
      backHref="/production/orders"
      backLabel="Production"
      banner={c.status === 'CANCELLED' ? `CANCELLED${c.notes ? ` — ${c.notes}` : ''}.` : null}
      party={{
        heading: 'To,',
        // The cutting master the lay was given to ("Cut by").
        name: c.cutterName || 'Cutting department',
        lines: (
          <>
            <PartyLine label="Customer" value={moCustomer(c.mo)} />
            <PartyLine label="Description" value={c.moLine?.style.name ?? null} />
            <PartyLine label="Colour" value={c.moLine?.color ?? null} />
            <PartyLine label="Style" value={c.moLine?.style.code ?? null} mono />
            <PartyLine label="Brand" value={data.brand?.name ?? null} />
          </>
        ),
        meta: [
          ['Cutting No', c.cutOrderNumber, true],
          ['Cut on', shortDate(c.cutDate), true],
          ['Mfg. order', c.mo.moNumber, true],
          ['Order no.', c.mo.so?.soNumber ?? null, true],
          !!c.mo.so?.customerPORef && ['Buyer PO', c.mo.so.customerPORef],
        ],
      }}
      bands={[
        {
          label: 'Fabric',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{c.fabricItem?.name || <Dash />}</div>
              <Facts
                items={[
                  ['Lot / shade', c.lotNo],
                  !!fabricShade.designNo && ['Fabric design no.', fabricShade.designNo, true],
                  !!fabricShade.colour && ['Fabric colour', fabricShade.colour],
                ]}
              />
            </>
          ),
        },
        {
          label: 'The lay',
          body: (
            <Facts
              items={[
                ['Ratio', c.ratio],
                ['Layers', Number(c.noOfLayers) > 0 ? String(Number(c.noOfLayers)) : null],
              ]}
            />
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            words={null}
            left={<Note title="Notes">{c.notes || <Dash />}</Note>}
            totals={
              <TotalsBox
                rows={[
                  { label: 'Fabric given', value: c.fabricIssued != null ? `${qty(c.fabricIssued)} ${uom}` : <Dash /> },
                  { label: 'Metres used', value: `${qty(used)} ${uom}${Number(c.wastage ?? 0) ? ` + ${qty(c.wastage!)} waste` : ''}` },
                  {
                    label: 'Left over',
                    value: c.fabricIssued != null ? `${qty(Math.round((Number(c.fabricIssued) - used - Number(c.wastage ?? 0)) * 1000) / 1000)} ${uom}` : <Dash />,
                  },
                  { label: 'Average', value: average ? `${qty(Math.round(average * 1000) / 1000)} ${uom} a piece` : <Dash /> },
                ]}
                totalLabel="Pieces cut"
                total={qty(c.actualPieces)}
              />
            }
          />

          {c.bundles.length ? (
            // Not kept whole on one page: a long list of bundles runs on to the next.
            <div style={{ border: LINE, marginTop: '7px' }}>
              <div style={{ borderBottom: HAIR, padding: '4px 9px', display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline' }}>
                <Eyebrow>
                  Bundles — {c.bundles.length}
                  {c.bundleSize ? ` of up to ${c.bundleSize}` : ''}
                </Eyebrow>
                <span style={{ fontSize: '9px' }}>{data.waitingAtCutting ? `${qty(data.waitingAtCutting)} pieces still at cutting` : 'All sent on'}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', columnGap: '10px', padding: '5px 9px' }}>
                {c.bundles.map((b) => (
                  <div key={b.id} style={{ fontSize: '9.5px', lineHeight: 1.7, breakInside: 'avoid', ...CODE }}>
                    <span style={{ fontWeight: 700 }}>{bNo(b.bundleNo)}</span> {b.size ? `${b.size.code} · ` : ''}
                    {b.qty} pcs
                  </div>
                ))}
              </div>
              {later.length ? (
                <div style={{ borderTop: HAIR, padding: '4px 9px', fontSize: '9px', lineHeight: 1.6 }}>
                  Later made as another size at {[...new Set(later.map((l) => l.step))].join(', ')}:{' '}
                  {later.map((l) => `${bNo(l.bundleNo)} (${l.size}, ${qty(l.qty)} pcs from ${bNo(l.fromBundleNo)})`).join(', ')}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      }
      signatures={[
        { role: 'Prepared by', who: c.createdBy?.name ?? null },
        { role: 'Cutting master', who: c.cutterName },
        { role: 'Issued by (authorised signatory)', who: null },
      ]}
      footerNote={template.footerNote ?? 'Cutting department. Bundles carry their own stickers; count them on to the next step against a transfer card.'}
    />
  )
}
