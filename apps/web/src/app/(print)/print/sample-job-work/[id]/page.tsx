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

interface Cell {
  colour: string
  sizeId: string
  qty: number
}
interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  sizes: Array<{ id: string; code: string; sequence: number }>
  job: {
    number: string
    sentOn: string
    expectedBack: string | null
    sentBy: string
    vehicleNo: string | null
    declaredValue: string | null
    notes: string | null
    cancelledAt: string | null
    cancelledBy: string | null
    cancelReason: string | null
    cells: Cell[]
    vendor: {
      name: string
      code: string | null
      gstin: string | null
      phone: string | null
      address: string | null
      city: string | null
      state: string | null
      stateCode: string | null
      pincode: string | null
    }
    stage: { name: string; sequence: number }
    round: {
      revision: number
      request: {
        number: string
        title: string
        buyerStyleRef: string | null
        customer: { name: string } | null
        style: { code: string; name: string } | null
      }
    }
    returns: Array<{
      id: string
      receivedOn: string
      theirChallanNo: string | null
      receivedBy: string
      cells: Array<{ colour: string; sizeId: string; accepted: number; rejected: number }>
    }>
  }
}

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '6%', align: 'center' },
  { key: 'desc', head: 'Description of goods', width: '46%' },
  { key: 'sizes', head: 'Sizes', width: '32%' },
  { key: 'qty', head: 'Pieces', width: '16%', align: 'right' },
]
const COPIES = ['Original for job worker', 'Duplicate for transporter', 'Triplicate for us']

/**
 * The challan that goes with sample pieces to an outside unit (embroidery,
 * print, wash): our number from the job-work series, the unit as consignee,
 * the pieces by colour and size, and — as rule 55 asks — what they are worth,
 * or that they have no commercial value. Sample pieces are not stock and are
 * not sold: nothing is charged on it.
 */
export default function PrintSampleJobWork() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copy, setCopy] = useState(COPIES[0])

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sampling/job-work/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that challan.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the challan…</p>

  const { company, template, job, sizes } = data
  const v = job.vendor
  const req = job.round.request
  const sizeOf = (id: string) => sizes.find((z) => z.id === id)
  // One row per colour: its sizes and pieces, sizes in the run's order.
  const colours = [...new Set(job.cells.map((c) => c.colour))]
  const rows = colours.map((colour, i) => {
    const cells = job.cells
      .filter((c) => c.colour === colour && c.qty > 0)
      .sort((a, b) => (sizeOf(a.sizeId)?.sequence ?? 0) - (sizeOf(b.sizeId)?.sequence ?? 0))
    const pieces = cells.reduce((s, c) => s + c.qty, 0)
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
              {colour} · for {job.stage.name.toLowerCase()} · {req.number} round {job.round.revision}
            </div>
          </div>
        ),
        sizes: (
          <span style={{ fontSize: '9px', color: GREY }}>
            {cells.map((c) => `${sizeOf(c.sizeId)?.code ?? '?'}:${c.qty}`).join('  ')}
          </span>
        ),
        qty: <strong>{qty(pieces)}</strong>,
      },
    }
  })
  const total = job.cells.reduce((s, c) => s + c.qty, 0)
  const interState = Boolean(company.stateCode && v.stateCode && company.stateCode !== v.stateCode)
  // Accounted for: back accepted, or rejected (spoilt or not returned).
  const settled = job.returns.flatMap((r) => r.cells).reduce((s, c) => s + c.accepted + c.rejected, 0)
  const declared = job.declaredValue === null ? null : Number(job.declaredValue)
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={job.number}
      copyLabel={copy}
      dateLabel="Challan date"
      date={longDate(job.sentOn) ?? ''}
      backHref="/sampling"
      backLabel="Sampling"
      banner={
        job.cancelledAt
          ? `CANCELLED on ${longDate(job.cancelledAt)}${job.cancelledBy ? ` by ${job.cancelledBy}` : ''}${job.cancelReason ? ` — ${job.cancelReason}` : ''}. The pieces did not go out on this challan.`
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
          title: 'Job worker (consignee)',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{v.name}</div>
              <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>
                {[v.address, v.city, v.state, v.pincode].filter(Boolean).join(', ')}
              </div>
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={v.gstin ?? 'Unregistered'} mono />
                <Fact label="State" value={v.state ? `${v.state}${v.stateCode ? ` (${v.stateCode})` : ''}` : null} />
                <Fact label="Phone" value={v.phone} />
              </div>
            </>
          ),
        },
        {
          title: 'The job',
          body: (
            <>
              <Fact label="Process" value={job.stage.name} />
              <Fact label="Sample" value={`${req.number} · round ${job.round.revision}`} mono />
              <Fact label="Buyer" value={req.customer?.name ?? null} />
              <Fact label="Buyer style" value={req.buyerStyleRef} />
              <Fact label="Due back" value={longDate(job.expectedBack)} />
            </>
          ),
        },
        {
          title: 'Dispatch',
          body: (
            <>
              <Fact label="Sent by" value={job.sentBy} />
              <Fact label="Vehicle No" value={job.vehicleNo} mono />
              <Fact label="Place of supply" value={v.state ? `${v.state}${interState ? ' (inter-state)' : ''}` : null} />
              <Fact label="Pieces" value={`${qty(total)}${settled ? ` · ${qty(settled)} accounted for` : ''}`} />
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
              <div style={{ fontSize: '10px', color: job.notes ? GREY : MUTED, marginTop: '3px', lineHeight: 1.55 }}>
                {job.notes ?? 'None.'}
              </div>
              {job.returns.length > 0 && (
                <div style={{ fontSize: '9px', color: GREY, marginTop: '5px', lineHeight: 1.55 }}>
                  {job.returns.map((r) => {
                    const ok = r.cells.reduce((s, c) => s + c.accepted, 0)
                    const bad = r.cells.reduce((s, c) => s + c.rejected, 0)
                    return (
                      <div key={r.id}>
                        Back {longDate(r.receivedOn)}: {ok} accepted{bad ? `, ${bad} rejected` : ''}
                        {r.theirChallanNo ? ` · their challan ${r.theirChallanNo}` : ''} · {r.receivedBy}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '7px 11px',
                background: NAVY,
                color: '#fff',
              }}
            >
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>
                Value of goods
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
                `Sample garments sent for job work (${job.stage.name.toLowerCase()}) under section 143 of the CGST Act, 2017, and rule 55 of the CGST Rules, 2017. They are samples, not for sale; this is not a supply and no GST is charged. They remain the property of ${company.name} and are to be returned after the work.`}
            </div>
          </div>
        </>
      }
      signatures={[
        { role: `For ${company.name}`, who: job.sentBy },
        { role: 'Transporter', who: null },
        { role: 'Received by job worker', who: null },
      ]}
      footerNote={template.footerNote ?? 'Delivery challan for job work on sample pieces. Not a tax invoice.'}
    />
  )
}
