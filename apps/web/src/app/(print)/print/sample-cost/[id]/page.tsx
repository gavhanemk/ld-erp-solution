'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { StoreSheet, Fact, Eyebrow, money, longDate, GREY, INK, MUTED, NAVY, NUM, RULE, type SheetColumn } from '@/components/print/StoreSheet'
import { rateFigure } from '@/components/sampling/specRules'
import { SAMPLE_CHARGE_LABEL, SAMPLE_RATE_BASIS_LABEL, type SampleCostSheet } from '@ld-erp/shared'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  sheet: SampleCostSheet & { notes?: string }
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
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the cost sheet…</p>

  const { company, template, sheet, finalised, request } = data
  let sn = 0
  const rows: Array<{ key: string; cells: Record<string, React.ReactNode>; muted?: boolean }> = []
  const head = (key: string, text: string) =>
    rows.push({ key, muted: true, cells: { sn: '', desc: <strong style={{ color: NAVY }}>{text}</strong>, qty: '', rate: '', amount: '' } })
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
            <div>
              <div style={{ fontWeight: 600 }}>{m.item.name}</div>
              <div style={{ fontSize: '9px', color: GREY }}>
                {[m.component, m.colour, SAMPLE_RATE_BASIS_LABEL[m.basis]].filter(Boolean).join(' · ')}
              </div>
            </div>
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
    rows.push({
      key: `t-${r.roundId}`,
      muted: true,
      cells: {
        sn: '',
        desc: `Round ${r.revision}: material ${money(r.material)} · labour ${money(r.labour)} · other ${money(r.misc)}${r.perPiece === null ? '' : ` · ${money(r.perPiece)} a piece`}`,
        qty: '',
        rate: '',
        amount: <strong>{money(r.total)}</strong>,
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
      panels={[
        {
          title: 'The sample',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{request.title}</div>
              <Fact label="Request" value={request.number} mono />
              <Fact label="Style" value={sheet.style ? `${sheet.style.code} · ${sheet.style.name}` : null} />
              <Fact label="Season" value={request.season} />
            </>
          ),
        },
        {
          title: 'The buyer',
          body: (
            <>
              <Fact label="Buyer" value={request.customer?.name ?? null} />
              <Fact label="Buyer style" value={request.buyerStyleRef} />
              <Fact label="Buyer ref." value={request.buyerRef} />
            </>
          ),
        },
        {
          title: 'Costs',
          body: (
            <>
              <Fact label="Finalised by" value={finalised?.by ?? null} />
              <Fact label="Pieces made" value={String(sheet.pieces)} />
              <Fact label="Rounds" value={String(sheet.rounds.length)} />
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      after={
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: '7px', marginTop: '8px' }}>
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
            <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
            <div style={{ fontSize: '10px', color: GREY, marginTop: '3px', lineHeight: 1.55 }}>
              {sheet.notes || 'Material at what this request paid, after line discount and before GST. The buyer’s own material is free.'}
              {sheet.notCosted.length > 0 && (
                <div style={{ marginTop: '4px' }}>
                  Still in the sample store, not costed: {sheet.notCosted.map((n) => `${n.qty} ${n.unit} of ${n.item}`).join(', ')}.
                </div>
              )}
            </div>
          </div>
          <div style={{ border: `1px solid ${RULE}` }}>
            {[
              ['Material', sheet.material],
              ['Labour and outside units', sheet.labour],
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
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 10px', fontSize: '10px', color: INK }}>
              <span>A piece ({sheet.pieces} made)</span>
              <span style={NUM}>{sheet.perPiece === null ? '—' : `₹${money(sheet.perPiece)}`}</span>
            </div>
          </div>
        </div>
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
