'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  Dash,
  Note,
  PartyLine,
  TotalsBox,
  WordsAndTotals,
  qty,
  money,
  longDate,
  shortDate,
  INK,
  MUTED,
  NUM,
  type SheetColumn,
} from '@/components/print/StoreSheet'
import { Box, SubLine } from '@/components/print/doc'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { SAMPLE_DISPATCH_MODE_LABEL, type SampleDispatchMode } from '@ld-erp/shared'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  sizes: Array<{ id: string; code: string; sequence: number }>
  dispatch: {
    number: string
    cells: Array<{ colour: string; sizeId: string; qty: number }>
    recipient: string
    address: string | null
    mode: SampleDispatchMode
    courier: string | null
    awb: string | null
    sentOn: string
    returnable: boolean
    expectedBack: string | null
    declaredValue: string | null
    notes: string | null
    cancelledAt: string | null
    cancelledBy: string | null
    cancelReason: string | null
    round: {
      revision: number
      milestone: string
      request: {
        number: string
        title: string
        buyerRef: string | null
        buyerStyleRef: string | null
        season: string | null
        customer: { name: string; gstin: string | null; phone: string | null } | null
        style: { code: string; name: string } | null
      }
    }
  }
}

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '6%', align: 'center' },
  { key: 'desc', head: 'Description', width: '46%' },
  { key: 'sizes', head: 'Sizes', width: '32%' },
  { key: 'qty', head: 'Pieces', width: '16%', align: 'right' },
]
const COPIES = ['Original for the buyer', 'Duplicate for the courier', 'Triplicate for us']

/**
 * The Sample Delivery Challan that goes with samples to the buyer: who they
 * are for, the samples by colour and size, how they went, and — samples not
 * being for sale — that they carry no commercial value unless a value was
 * declared. Not a tax invoice, and not the sales delivery challan: nothing
 * leaves stock and nothing is billed.
 */
export default function PrintSampleDispatch() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copy, setCopy] = useState(COPIES[0])

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sampling/dispatch/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that challan.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the challan…</p>

  const { company, template, dispatch: d, sizes } = data
  const req = d.round.request
  const buyer = req.customer
  const sizeOf = (sid: string) => sizes.find((z) => z.id === sid)
  const colours = [...new Set(d.cells.map((c) => c.colour))]
  const rows = colours.map((colour, i) => {
    const cells = d.cells
      .filter((c) => c.colour === colour && c.qty > 0)
      .sort((a, b) => (sizeOf(a.sizeId)?.sequence ?? 0) - (sizeOf(b.sizeId)?.sequence ?? 0))
    return {
      key: colour,
      cells: {
        sn: i + 1,
        desc: (
          <>
            <div style={{ fontWeight: 600 }}>
              Sample garments{req.style ? ` · ${req.style.code} ${req.style.name}` : ''}
            </div>
            <SubLine>
              {colour} · {d.round.milestone || 'Sample'} · {req.number} round {d.round.revision}
            </SubLine>
          </>
        ),
        sizes: (
          <span style={{ fontSize: '9px', ...NUM }}>
            {cells.map((c) => `${sizeOf(c.sizeId)?.code ?? '?'}:${c.qty}`).join('  ')}
          </span>
        ),
        qty: <strong>{qty(cells.reduce((s, c) => s + c.qty, 0))}</strong>,
      },
    }
  })
  const total = d.cells.reduce((s, c) => s + c.qty, 0)
  const declared = d.declaredValue === null ? null : Number(d.declaredValue)
  const recipientBody = (
    <>
      <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{d.recipient}</div>
      <div style={{ marginTop: '1px', whiteSpace: 'pre-wrap' }}>{d.address || <Dash />}</div>
    </>
  )

  // Laid out like the purchase order (27 Nov 2026): the buyer in the "To,"
  // block with the challan's facts and how it went beside it, then who
  // receives the samples and where.
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={d.number}
      copyLabel={copy}
      dateLabel="Challan date"
      date={longDate(d.sentOn) ?? ''}
      backHref="/sampling"
      backLabel="Sampling"
      banner={
        d.cancelledAt
          ? `CANCELLED on ${longDate(d.cancelledAt)}${d.cancelledBy ? ` by ${d.cancelledBy}` : ''}${d.cancelReason ? ` — ${d.cancelReason}` : ''}. The samples did not go on this challan.`
          : null
      }
      options={
        <label>
          Copy
          <SmartSelect value={copy} onChange={(e) => setCopy(e.target.value)}>
            {COPIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </SmartSelect>
        </label>
      }
      party={{
        // The buyer the samples are for; with no buyer on the request, the recipient.
        name: buyer?.name ?? d.recipient,
        lines: buyer ? (
          <>
            <PartyLine label="GST No" value={buyer.gstin} mono />
            <PartyLine label="Contact No" value={buyer.phone} mono />
          </>
        ) : (
          <PartyLine label="Address-" value={d.address} />
        ),
        meta: [
          ['Challan No', d.number, true],
          ['Challan Date', shortDate(d.sentOn), true],
          ['Sample', `${req.number} · round ${d.round.revision}`, true],
          !!req.buyerStyleRef && ['Buyer style', req.buyerStyleRef],
          !!req.buyerRef && ['Buyer ref.', req.buyerRef],
          !!req.season && ['Season', req.season],
          ['To come back', d.returnable ? (shortDate(d.expectedBack) ?? 'Yes') : 'No', d.returnable && Boolean(d.expectedBack)],
          ['How', SAMPLE_DISPATCH_MODE_LABEL[d.mode]],
          [d.mode === 'COURIER' ? 'Courier' : 'Carried by', d.courier],
          [d.mode === 'COURIER' ? 'AWB / docket' : 'Reference', d.awb, true],
        ],
      }}
      bands={[buyer && { icon: 'truck', label: 'Deliver to', body: recipientBody }]}
      columns={COLS}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            left={<Note title="Note">{d.notes || <Dash />}</Note>}
            totals={
              <TotalsBox
                rows={[{ label: 'Pieces', value: qty(total) }]}
                totalLabel="Value"
                total={declared === null ? 'No commercial value' : `₹ ${money(declared)}`}
              />
            }
          />
          <Box title="Declaration" style={{ marginTop: '7px' }}>
            {template.declaration ??
              `Samples sent for the buyer's approval only. They are not for sale and are not a supply; no GST is charged and this is not a tax invoice.${d.returnable ? ' The samples are to be returned to us.' : ''}`}
          </Box>
        </>
      }
      signatures={[
        { role: `For ${company.name}`, who: null },
        { role: d.mode === 'COURIER' ? 'Courier' : 'Carried by', who: d.courier },
        { role: 'Received by', who: null },
      ]}
      footerNote={template.footerNote ?? 'Sample delivery challan. Samples only, not for sale. Not a tax invoice.'}
    />
  )
}
