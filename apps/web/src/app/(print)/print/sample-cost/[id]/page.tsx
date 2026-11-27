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
import { rateFigure } from '@/components/sampling/specRules'
import { HAIR, SubLine, type DocRow } from '@/components/print/doc'
import { itemShade } from '@/lib/items'
import { SAMPLE_CHARGE_LABEL, SAMPLE_RATE_BASIS_LABEL, type SampleCostSheet } from '@ld-erp/shared'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null; termsText?: string | null }
  sheet: SampleCostSheet & { notes?: string }
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

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
  { key: 'desc', head: 'Description', width: '47%' },
  { key: 'qty', head: 'Qty', width: '14%', align: 'right' },
  { key: 'rate', head: 'Rate', width: '14%', align: 'right' },
  { key: 'amount', head: 'Amount (₹)', width: '20%', align: 'right' },
]

/**
 * Our own cost sheet of a sample, line by line: each round's material at
 * what the request paid for it, its steps' labour and outside units, its
 * charges and couriers, and the request's own charges. Not for the buyer:
 * the Sample charges statement is theirs.
 */
export default function PrintSampleCostSheet() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sampling/${id}/cost/print?kind=sheet`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open the cost sheet.'))
  }, [id])
  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: INK }}>Opening the cost sheet…</p>

  const { company, template, sheet, finalised, request } = data
  const buyer = request.customer
  // Where the buyer is billed, else where their samples went.
  const buyerAddress =
    [buyer?.billingAddress, buyer?.billingCity, buyer?.billingState, buyer?.billingPincode].filter(Boolean).join(', ') ||
    [buyer?.shippingAddress, buyer?.shippingCity, buyer?.shippingState, buyer?.shippingPincode].filter(Boolean).join(', ')
  let sn = 0
  const rows: DocRow[] = []
  // A round's (or the request's) heading row, in bold across the description.
  const head = (key: string, text: string) =>
    rows.push({ key, cells: { sn: '', desc: <strong>{text}</strong>, qty: '', rate: '', amount: '' } })
  for (const r of sheet.rounds) {
    head(
      `r-${r.roundId}`,
      `Round ${r.revision} · ${r.milestone || 'Sample'} · ${r.colours.map((c) => `${c.colour} ${c.pieces}`).join(', ') || 'nothing finished'} · ${r.pieces} pieces`
    )
    for (const m of r.materials)
      rows.push({
        key: `m-${r.roundId}-${++sn}`,
        cells: {
          sn,
          desc: (
            <>
              <div style={{ fontWeight: 700 }}>{m.item.name}</div>
              {/* The material's own design and colour, when its item has them. */}
              {itemShade(m.item) && <SubLine>{itemShade(m.item)}</SubLine>}
              <SubLine>{[m.component, m.colour, SAMPLE_RATE_BASIS_LABEL[m.basis]].filter(Boolean).join(' · ')}</SubLine>
            </>
          ),
          qty: `${m.consumed} ${m.item.unit}`,
          rate: m.basis === 'BUYER' ? '—' : rateFigure(m.rate),
          amount: money(m.amount),
        },
      })
    for (const l of r.labourLines)
      rows.push({
        key: `l-${r.roundId}-${++sn}`,
        cells: {
          sn,
          desc: `${l.sequence}. ${l.name} · ${l.kind === 'OUTSIDE' ? `outside unit${l.who ? ` (${l.who})` : ''}` : 'labour'}`,
          qty: '',
          rate: '',
          amount: money(l.amount),
        },
      })
    for (const c of r.miscLines)
      rows.push({
        key: `c-${r.roundId}-${++sn}`,
        cells: { sn, desc: `${SAMPLE_CHARGE_LABEL[c.kind]} · ${c.description}${c.billRef ? ` · ${c.billRef}` : ''}`, qty: '', rate: '', amount: money(c.amount) },
      })
    // The round's sub-total: bold and ruled above.
    rows.push({
      key: `t-${r.roundId}`,
      total: true,
      cells: {
        sn: '',
        desc: `Round ${r.revision}: material ${money(r.material)} · labour ${money(r.labour)} · other ${money(r.misc)}${r.perPiece === null ? '' : ` · ${money(r.perPiece)} a piece`}`,
        qty: '',
        rate: '',
        amount: money(r.total),
      },
    })
  }
  if (sheet.requestCharges.length) {
    head('req', 'For the request as a whole')
    for (const c of sheet.requestCharges)
      rows.push({
        key: `rc-${++sn}`,
        cells: { sn, desc: `${SAMPLE_CHARGE_LABEL[c.kind]} · ${c.description}${c.billRef ? ` · ${c.billRef}` : ''}`, qty: '', rate: '', amount: money(c.amount) },
      })
  }
  // Laid out like the purchase order (27 Nov 2026): the buyer the sample is
  // for in the "For," block with the sheet's facts beside it, then the lines.
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={request.number}
      dateLabel={finalised ? 'Finalised' : 'As on'}
      date={longDate(finalised?.at ?? sheet.computedAt) ?? ''}
      backHref="/sampling"
      backLabel="Sampling"
      banner={finalised ? null : 'PROVISIONAL — the costs are not finalised, and these figures may still change.'}
      party={{
        heading: 'For,',
        name: buyer?.name ?? 'Internal development',
        lines: (
          <>
            {buyer && <PartyLine label="Address-" value={buyerAddress || null} />}
            {buyer && <PartyLine label="Contact No" value={buyer.phone} mono />}
            <PartyLine label="Sample" value={request.title} />
            <PartyLine label="Style" value={sheet.style ? `${sheet.style.code} · ${sheet.style.name}` : null} />
          </>
        ),
        meta: [
          ['Sample No', request.number, true],
          [finalised ? 'Finalised' : 'As on', shortDate(finalised?.at ?? sheet.computedAt), true],
          ['Finalised by', finalised?.by ?? null],
          ['Buyer style', request.buyerStyleRef],
          ['Buyer ref.', request.buyerRef],
          ['Season', request.season],
          ['Pieces made', String(sheet.pieces)],
          ['Rounds', String(sheet.rounds.length)],
        ],
      }}
      columns={COLS}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            left={
              <Note title="Note">
                {sheet.notes || 'Material at what this request paid, after line discount and before GST. The buyer’s own material is free.'}
                {sheet.notCosted.length > 0 && (
                  <div style={{ marginTop: '4px' }}>
                    Still in the sample store, not costed:{' '}
                    {sheet.notCosted.map((n) => `${n.qty} ${n.unit} of ${n.item}${itemShade(n) ? ` (${itemShade(n)})` : ''}`).join(', ')}.
                  </div>
                )}
              </Note>
            }
            totals={
              <>
                <TotalsBox
                  style={{ flex: 1 }}
                  rows={[
                    { label: 'Material', value: money(sheet.material) },
                    { label: 'Labour and outside units', value: money(sheet.labour) },
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
        { role: 'Prepared by', who: finalised?.by ?? null },
        { role: 'Checked by', who: null },
        { role: 'Approved by', who: null },
      ]}
      footerNote={template.footerNote ?? 'Internal cost sheet of a sample. Not for the buyer, and not a tax document.'}
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
