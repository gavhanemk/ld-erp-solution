'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, qty, longDate, CODE, GREY, INK, MUTED, NAVY, RULE, TINT, type SheetColumn } from '@/components/print/StoreSheet'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  waitingAtCutting: number
  cutting: {
    cutOrderNumber: string
    cutDate: string
    status: string
    fabricIssued: string | number | null
    fabricUsed: string | number | null
    wastage: string | number | null
    noOfLayers: number | null
    lotNo: string | null
    ratio: string | null
    cutterName: string | null
    bundleSize: number | null
    sizeBreakup: Record<string, number> | null
    plannedBreakup: Record<string, number> | null
    actualPieces: number
    notes: string | null
    createdBy: { name: string } | null
    fabricItem: { code: string; name: string; uom: { symbol: string } | null } | null
    moLine: { color: string; totalQty: number; style: { code: string; name: string }; sizes: Array<{ sizeId: string; qty: number; size: { code: string; sequence: number } }> } | null
    mo: { id: string; moNumber: string; totalPlannedQty: number; so: { soNumber: string; customerPORef: string | null; customer: { name: string } } | null }
    bundles: Array<{ id: string; code: string; bundleNo: number; qty: number; size: { code: string } | null }>
  }
}

/**
 * The cutting document: what the cutting room was given and what it cut, for
 * one lay of one line of the order. Order, fabric and the lay above; the
 * pieces by size — on the order, planned for this lay, actually cut — and the
 * bundles tied from them below. Signed by whoever prepared it, the cutting
 * master, and whoever issued the fabric.
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

  // Sizes run across the page, as on the floor's own sheet.
  const columns: SheetColumn[] = [
    { key: 'what', head: 'Sizes', width: `${sizes.length ? 22 : 60}%` },
    ...sizes.map((z) => ({ key: z.sizeId, head: z.size.code, width: `${Math.floor(66 / Math.max(1, sizes.length))}%`, align: 'center' as const })),
    { key: 'total', head: 'Total', width: '12%', align: 'right' },
  ]
  const row = (key: string, label: string, get: (sizeId: string) => number | null, total: number | null, strong = false) => ({
    key,
    cells: {
      what: <span style={{ fontWeight: strong ? 700 : 500 }}>{label}</span>,
      ...Object.fromEntries(sizes.map((z) => [z.sizeId, get(z.sizeId) ? (strong ? <strong>{qty(get(z.sizeId)!)}</strong> : qty(get(z.sizeId)!)) : ''])),
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
      panels={[
        {
          title: 'Order',
          body: (
            <>
              <Fact label="Mfg. order" value={c.mo.moNumber} mono />
              <Fact label="Order no." value={c.mo.so ? `${c.mo.so.soNumber}${c.mo.so.customerPORef ? ` · PO ${c.mo.so.customerPORef}` : ''}` : null} />
              <Fact label="Customer" value={c.mo.so?.customer.name ?? null} />
              <Fact label="Description" value={c.moLine?.style.name ?? null} />
            </>
          ),
        },
        {
          title: 'Fabric',
          body: (
            <>
              <Fact label="Quality" value={c.fabricItem ? `${c.fabricItem.name}` : null} />
              <Fact label="Colour" value={c.moLine?.color ?? null} />
              <Fact label="Design no." value={c.moLine?.style.code ?? null} mono />
              <Fact label="Lot / shade" value={c.lotNo} />
            </>
          ),
        },
        {
          title: 'The lay',
          body: (
            <>
              <Fact label="Metres used" value={`${qty(used)} ${uom}${Number(c.wastage ?? 0) ? ` + ${qty(c.wastage!)} waste` : ''}`} />
              <Fact label="Average" value={average ? `${qty(Math.round(average * 1000) / 1000)} ${uom} a piece` : null} />
              <Fact label="Ratio" value={c.ratio} />
              <Fact label="Layers" value={c.noOfLayers ? String(c.noOfLayers) : null} />
              <Fact label="Cut by" value={c.cutterName} />
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      after={
        c.bundles.length ? (
          <div style={{ border: `1px solid ${RULE}`, marginTop: '8px' }}>
            <div style={{ background: TINT, borderBottom: `1px solid ${RULE}`, padding: '5px 10px', display: 'flex', justifyContent: 'space-between' }}>
              <Eyebrow>
                Bundles — {c.bundles.length}
                {c.bundleSize ? ` of up to ${c.bundleSize}` : ''}
              </Eyebrow>
              <span style={{ fontSize: '9px', color: GREY }}>{data.waitingAtCutting ? `${qty(data.waitingAtCutting)} pieces still at cutting` : 'All sent on'}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0', padding: '6px 10px' }}>
              {c.bundles.map((b) => (
                <div key={b.id} style={{ fontSize: '9.5px', color: INK, lineHeight: 1.7, ...CODE }}>
                  <span style={{ color: NAVY, fontWeight: 700 }}>B{String(b.bundleNo).padStart(3, '0')}</span> {b.size ? `${b.size.code} · ` : ''}
                  {b.qty} pcs
                </div>
              ))}
            </div>
          </div>
        ) : c.notes ? (
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '8px', fontSize: '10px', color: GREY }}>{c.notes}</div>
        ) : null
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
