'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, money, longDate, GREY, INK, MUTED, NAVY, NUM, RULE, type SheetColumn } from '@/components/print/StoreSheet'
import type { SampleCostSheet } from '@ld-erp/shared'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  sheet: SampleCostSheet
  finalised: { at: string; by: string | null } | null
  request: {
    number: string
    title: string
    buyerRef: string | null
    buyerStyleRef: string | null
    season: string | null
    customer: { name: string } | null
    cancelledAt: string | null
  }
}

/** Always printed, whatever the template adds: nothing is billed on this sheet. */
const NOT_AN_INVOICE =
  'This is a statement for information, not a tax invoice. Any amount billed for these samples will be on a separate tax invoice.'

const COLS: SheetColumn[] = [
  { key: 'round', head: 'Sample', width: '34%' },
  { key: 'pieces', head: 'Pieces', width: '8%', align: 'right' },
  { key: 'material', head: 'Material', width: '14%', align: 'right' },
  { key: 'labour', head: 'Labour', width: '14%', align: 'right' },
  { key: 'misc', head: 'Other', width: '14%', align: 'right' },
  { key: 'total', head: 'Total (₹)', width: '16%', align: 'right' },
]

/**
 * The Sample charges statement for the buyer: what their samples cost to
 * make, round by round — material, labour and other charges, the total and a
 * piece. A statement, not a tax invoice: nothing is billed on it.
 */
export default function PrintSampleCharges() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sampling/${id}/cost/print?kind=charges`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open the statement.'))
  }, [id])
  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the statement…</p>

  const { company, template, sheet, finalised, request } = data
  const requestMisc = sheet.requestCharges.reduce((t, c) => t + c.amount, 0)
  const rows = [
    ...sheet.rounds.map((r) => ({
      key: r.roundId,
      cells: {
        round: (
          <div>
            <div style={{ fontWeight: 600 }}>
              Round {r.revision} · {r.milestone || 'Sample'}
            </div>
            <div style={{ fontSize: '9px', color: GREY }}>
              {r.colours.map((c) => `${c.colour} ${c.pieces}`).join(' · ') || 'Nothing finished'}
            </div>
          </div>
        ),
        pieces: r.pieces,
        material: money(r.material),
        labour: money(r.labour),
        misc: money(r.misc),
        total: <strong>{money(r.total)}</strong>,
      },
    })),
    ...(requestMisc > 0
      ? [
          {
            key: 'request',
            cells: {
              round: <div style={{ fontWeight: 600 }}>For the request as a whole</div>,
              pieces: '',
              material: '',
              labour: '',
              misc: money(requestMisc),
              total: <strong>{money(requestMisc)}</strong>,
            },
          },
        ]
      : []),
  ]
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={request.number}
      dateLabel="Date"
      date={longDate(finalised?.at ?? sheet.computedAt) ?? ''}
      backHref="/sampling"
      backLabel="Sampling"
      banner={finalised ? null : 'PROVISIONAL — these charges are not finalised and may still change.'}
      panels={[
        {
          title: 'To',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>
                {request.customer?.name ?? 'Internal development'}
              </div>
              <Fact label="Your style" value={request.buyerStyleRef} />
              <Fact label="Your ref." value={request.buyerRef} />
            </>
          ),
        },
        {
          title: 'The samples',
          body: (
            <>
              <Fact label="Request" value={request.number} mono />
              <Fact label="Style" value={sheet.style ? `${sheet.style.code} · ${sheet.style.name}` : null} />
              <Fact label="Season" value={request.season} />
            </>
          ),
        },
        {
          title: 'In all',
          body: (
            <>
              <Fact label="Pieces made" value={String(sheet.pieces)} />
              <Fact label="A piece" value={sheet.perPiece === null ? null : `₹${money(sheet.perPiece)}`} />
              <Fact label="Total" value={`₹${money(sheet.total)}`} />
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      minRows={3}
      after={
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: '7px', marginTop: '8px' }}>
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
              <Eyebrow style={{ color: GREY }}>About these charges</Eyebrow>
              <div style={{ fontSize: '10px', color: GREY, marginTop: '3px', lineHeight: 1.55 }}>
                What making the samples cost: material used, labour and outside work, and other charges such as
                testing, patterns and couriers. Material you supplied is not charged.
              </div>
            </div>
            <div style={{ border: `1px solid ${RULE}` }}>
              {[
                ['Material', sheet.material],
                ['Labour', sheet.labour],
                ['Other charges', sheet.misc],
              ].map(([label, v]) => (
                <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 10px', fontSize: '10px', color: INK }}>
                  <span>{label}</span>
                  <span style={NUM}>₹{money(Number(v))}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 11px', borderTop: '1.5pt solid #000', color: '#fff' }}>
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>Total</span>
                <span style={{ fontSize: '13px', fontWeight: 700, ...NUM }}>₹{money(sheet.total)}</span>
              </div>
            </div>
          </div>
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
            <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
            <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.6 }}>
              {NOT_AN_INVOICE}
              {request.cancelledAt && (
                <> The request was cancelled on {longDate(request.cancelledAt)}: these are the samples made until then.</>
              )}
              {template.declaration && <div style={{ marginTop: '3px' }}>{template.declaration}</div>}
            </div>
          </div>
        </>
      }
      signatures={[
        { role: `For ${company.name}`, who: null },
        { role: 'Received by', who: null },
      ]}
      footerNote={template.footerNote ? `${template.footerNote} · Not a tax invoice.` : 'Statement of sample charges. Not a tax invoice.'}
    />
  )
}
