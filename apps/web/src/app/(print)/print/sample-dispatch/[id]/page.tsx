'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  Fact,
  Eyebrow,
  qty,
  money,
  longDate,
  GREY,
  INK,
  MUTED,
  NAVY,
  NUM,
  RULE,
  type SheetColumn,
} from '@/components/print/StoreSheet'
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
          <div>
            <div style={{ fontWeight: 600 }}>
              Sample garments{req.style ? ` · ${req.style.code} ${req.style.name}` : ''}
            </div>
            <div style={{ fontSize: '9px', color: GREY }}>
              {colour} · {d.round.milestone || 'Sample'} · {req.number} round {d.round.revision}
            </div>
          </div>
        ),
        sizes: (
          <span style={{ fontSize: '9px', color: GREY }}>
            {cells.map((c) => `${sizeOf(c.sizeId)?.code ?? '?'}:${c.qty}`).join('  ')}
          </span>
        ),
        qty: <strong>{qty(cells.reduce((s, c) => s + c.qty, 0))}</strong>,
      },
    }
  })
  const total = d.cells.reduce((s, c) => s + c.qty, 0)
  const declared = d.declaredValue === null ? null : Number(d.declaredValue)
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
      panels={[
        {
          title: 'Deliver to',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{d.recipient}</div>
              {d.address && (
                <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px', whiteSpace: 'pre-wrap' }}>
                  {d.address}
                </div>
              )}
              <div style={{ marginTop: '4px' }}>
                <Fact label="Buyer" value={req.customer?.name ?? null} />
                <Fact label="GSTIN" value={req.customer?.gstin ?? null} mono />
                <Fact label="Phone" value={req.customer?.phone ?? null} />
              </div>
            </>
          ),
        },
        {
          title: 'The samples',
          body: (
            <>
              <Fact label="Sample" value={`${req.number} · round ${d.round.revision}`} mono />
              <Fact label="Buyer style" value={req.buyerStyleRef} />
              <Fact label="Buyer ref." value={req.buyerRef} />
              <Fact label="Season" value={req.season} />
              <Fact label="To come back" value={d.returnable ? (longDate(d.expectedBack) ?? 'Yes') : 'No'} />
            </>
          ),
        },
        {
          title: 'Dispatch',
          body: (
            <>
              <Fact label="How" value={SAMPLE_DISPATCH_MODE_LABEL[d.mode]} />
              <Fact label={d.mode === 'COURIER' ? 'Courier' : 'Carried by'} value={d.courier} />
              <Fact label={d.mode === 'COURIER' ? 'AWB / docket' : 'Reference'} value={d.awb} mono />
              <Fact label="Pieces" value={qty(total)} />
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      minRows={Math.max(0, 4 - rows.length)}
      after={
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 250px', gap: '7px', marginTop: '8px' }}>
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
              <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
              <div style={{ fontSize: '10px', color: d.notes ? GREY : MUTED, marginTop: '3px', lineHeight: 1.55 }}>
                {d.notes ?? 'None.'}
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '7px 11px',
                borderTop: '1.5pt solid #000',
                color: '#fff',
              }}
            >
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>
                Value
              </span>
              <span style={{ fontSize: declared === null ? '10px' : '13px', fontWeight: 700, ...NUM }}>
                {declared === null ? 'No commercial value' : `₹${money(declared)}`}
              </span>
            </div>
          </div>
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
            <Eyebrow style={{ color: GREY }}>Declaration</Eyebrow>
            <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.6 }}>
              {template.declaration ??
                `Samples sent for the buyer's approval only. They are not for sale and are not a supply; no GST is charged and this is not a tax invoice.${d.returnable ? ' The samples are to be returned to us.' : ''}`}
            </div>
          </div>
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
