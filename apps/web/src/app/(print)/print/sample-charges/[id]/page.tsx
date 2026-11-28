'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  Note,
  PartyLine,
  Terms,
  TotalsBox,
  WordsAndTotals,
  money,
  longDate,
  shortDate,
  INK,
  NUM,
  type SheetColumn,
} from '@/components/print/StoreSheet'
import { HAIR, SubLine } from '@/components/print/doc'
import type { SampleCostSheet } from '@ld-erp/shared'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null; termsText?: string | null }
  sheet: SampleCostSheet
  finalised: { at: string; by: string | null } | null
  request: {
    number: string
    title: string
    buyerRef: string | null
    buyerStyleRef: string | null
    season: string | null
    /** With the buyer's address and phone, as the request carries them. */
    customer: {
      name: string
      phone?: string | null
      billingAddress?: string | null
      billingCity?: string | null
      billingState?: string | null
      billingPincode?: string | null
      shippingAddress?: string | null
      shippingCity?: string | null
      shippingState?: string | null
      shippingPincode?: string | null
    } | null
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
  if (!data) return <p style={{ padding: 48, color: INK }}>Opening the statement…</p>

  const { company, template, sheet, finalised, request } = data
  const buyer = request.customer
  // Where the buyer is billed, else where their samples went.
  const buyerAddress =
    [buyer?.billingAddress, buyer?.billingCity, buyer?.billingState, buyer?.billingPincode].filter(Boolean).join(', ') ||
    [buyer?.shippingAddress, buyer?.shippingCity, buyer?.shippingState, buyer?.shippingPincode].filter(Boolean).join(', ')
  const requestMisc = sheet.requestCharges.reduce((t, c) => t + c.amount, 0)
  const rows = [
    ...sheet.rounds.map((r) => ({
      key: r.roundId,
      cells: {
        round: (
          <>
            <div style={{ fontWeight: 700 }}>
              Round {r.revision} · {r.milestone || 'Sample'}
            </div>
            <SubLine>{r.colours.map((c) => `${c.colour} ${c.pieces}`).join(' · ') || 'Nothing finished'}</SubLine>
          </>
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
              round: <div style={{ fontWeight: 700 }}>For the request as a whole</div>,
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
  // Laid out like the purchase order (27 Nov 2026): the buyer in the "To,"
  // block with the statement's facts beside it, the rounds, then the totals.
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
      party={{
        heading: 'To,',
        name: buyer?.name ?? 'Internal development',
        lines: buyer ? (
          <>
            <PartyLine label="Address-" value={buyerAddress || null} />
            <PartyLine label="Contact No" value={buyer.phone} mono />
          </>
        ) : null,
        meta: [
          ['Sample No', request.number, true],
          ['Date', shortDate(finalised?.at ?? sheet.computedAt), true],
          ['Your style', request.buyerStyleRef],
          ['Your ref.', request.buyerRef],
          ['Style', sheet.style ? `${sheet.style.code} · ${sheet.style.name}` : null],
          ['Season', request.season],
        ],
      }}
      columns={COLS}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            left={
              <>
                <Note title="About these charges">
                  What making the samples cost: material used, labour and outside work, and other charges such as
                  testing, patterns and couriers. Material you supplied is not charged.
                </Note>
                <Note title="Note">
                  {NOT_AN_INVOICE}
                  {request.cancelledAt && (
                    <> The request was cancelled on {longDate(request.cancelledAt)}: these are the samples made until then.</>
                  )}
                </Note>
              </>
            }
            totals={
              <>
                <TotalsBox
                  style={{ flex: 1 }}
                  rows={[
                    { label: 'Material', value: money(sheet.material) },
                    { label: 'Labour', value: money(sheet.labour) },
                    { label: 'Other charges', value: money(sheet.misc) },
                  ]}
                  total={`₹ ${money(sheet.total)}`}
                />
                <PerPiece pieces={sheet.pieces} perPiece={sheet.perPiece} />
              </>
            }
          />
          <Terms text={template.termsText} />
          {template.declaration && <div style={{ fontSize: '9.5px', marginTop: '7px' }}>{template.declaration}</div>}
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

/** What a piece came to, under the total: worked out from it, not added to it. */
function PerPiece({ pieces, perPiece }: { pieces: number; perPiece: number | null }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 8px minmax(92px, auto)',
        alignItems: 'baseline',
        gap: '6px',
        padding: '3.5px 9px',
        fontSize: '10px',
        borderTop: HAIR,
      }}
    >
      <span>A piece ({pieces} made)</span>
      <span>:</span>
      <span style={{ textAlign: 'right', fontWeight: 600, ...NUM }}>{perPiece === null ? '—' : `₹ ${money(perPiece)}`}</span>
    </div>
  )
}
