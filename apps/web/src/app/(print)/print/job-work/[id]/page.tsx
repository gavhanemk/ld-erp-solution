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
  CODE,
  INK,
  MUTED,
  NUM,
  type SheetColumn,
} from '@/components/print/StoreSheet'
import { Box, SubLine } from '@/components/print/doc'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { itemShade, type ShadeFields } from '@/lib/items'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  challan: {
    challanNumber: string
    challanDate: string
    process: string
    expectedBackOn: string | null
    vehicleNo: string | null
    transporter: string | null
    lrNumber: string | null
    notes: string | null
    cancelledAt: string | null
    cancelReason: string | null
    jobWorker: {
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
    fromWarehouse: { name: string; address: string | null }
    sentBy: { name: string } | null
    cancelledBy: { name: string } | null
    lines: Array<{
      id: string
      qty: string
      hsnCode: string | null
      unitRate: string | null
      item: { code: string; name: string; hsnCode: string | null; uom: { symbol: string } | null } & ShadeFields
      ownership?: 'OWNED' | 'CUSTOMER_OWNED'
      ownerCustomer?: { name: string } | null
      size?: { code: string } | null
    }>
  }
}

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
  { key: 'code', head: 'Item Code', width: '14%' },
  { key: 'desc', head: 'Description of Goods', width: '33%' },
  { key: 'hsn', head: 'HSN', width: '9%', align: 'center' },
  { key: 'uom', head: 'UOM', width: '6%', align: 'center' },
  { key: 'qty', head: 'Quantity', width: '10%', align: 'right' },
  { key: 'rate', head: 'Rate', width: '10%', align: 'right' },
  { key: 'value', head: 'Value (₹)', width: '13%', align: 'right' },
]

/*
 * A GST challan for job work goes in three copies: the original travels with
 * the goods to the job worker, the duplicate with the transporter, and the
 * triplicate stays with us.
 */
const COPIES = ['Original for job worker', 'Duplicate for transporter', 'Triplicate for us']

/** One year from the challan date: inputs not back by then count as supplied (section 143). */
const yearOn = (d: string) => {
  const x = new Date(d)
  x.setFullYear(x.getFullYear() + 1)
  return x
}

/**
 * The delivery challan that goes with our goods to a job worker.
 *
 * Under rule 55 of the CGST Rules it names both parties with their GSTIN, and
 * each item with HSN, quantity and value. The goods are still ours, so no tax
 * is charged; the declaration says why, and by when they must come back.
 */
export default function PrintJobWorkChallan() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copy, setCopy] = useState(COPIES[0])

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/inventory/job-work/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that challan.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the challan…</p>

  const { company, template, challan } = data
  const w = challan.jobWorker
  const value = (l: Payload['challan']['lines'][number]) =>
    l.unitRate === null ? null : Number(l.qty) * Number(l.unitRate)
  const total = challan.lines.reduce((s, l) => s + (value(l) ?? 0), 0)
  const interState = Boolean(company.stateCode && w.stateCode && company.stateCode !== w.stateCode)
  const workerAddress = [w.address, w.city, w.state, w.pincode].filter(Boolean).join(', ')

  const rows = challan.lines.map((l, i) => ({
    key: l.id,
    cells: {
      sn: i + 1,
      code: <span style={CODE}>{l.item.code}</span>,
      desc: (
        <>
          <div style={{ fontWeight: 600 }}>{l.item.name}</div>
          {itemShade(l.item) && <SubLine>{itemShade(l.item)}</SubLine>}
        </>
      ),
      hsn: <span style={{ fontSize: '9px', ...NUM }}>{l.hsnCode ?? l.item.hsnCode ?? <Dash />}</span>,
      uom: <span style={{ fontSize: '9px' }}>{l.item.uom?.symbol ?? ''}</span>,
      qty: <strong>{qty(l.qty)}</strong>,
      rate: l.unitRate === null ? <Dash /> : money(l.unitRate),
      value: value(l) === null ? <Dash /> : money(value(l)!),
    },
  }))

  // Laid out like the purchase order (27 Nov 2026): the job worker in the
  // "To," block with the challan's facts beside it, then the store the goods
  // left from.
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={challan.challanNumber}
      copyLabel={copy}
      dateLabel="Challan date"
      date={longDate(challan.challanDate) ?? ''}
      backHref="/inventory/job-work"
      backLabel="Job work"
      banner={
        challan.cancelledAt
          ? `CANCELLED on ${longDate(challan.cancelledAt)}${challan.cancelledBy ? ` by ${challan.cancelledBy.name}` : ''}${challan.cancelReason ? ` — ${challan.cancelReason}` : ''}. The goods did not go out on this challan.`
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
        heading: 'To, the job worker (consignee)',
        name: w.name,
        lines: (
          <>
            <PartyLine label="Address-" value={workerAddress || null} />
            <PartyLine label="GST No" value={w.gstin ?? 'Unregistered'} mono={Boolean(w.gstin)} />
            <PartyLine label="Contact No" value={w.phone} mono />
            <PartyLine
              label="Place of supply"
              value={
                w.state
                  ? `${w.state}${w.stateCode ? ` (${w.stateCode})` : ''}${interState ? ', inter-state' : ''}`
                  : null
              }
            />
          </>
        ),
        meta: [
          ['Challan No', challan.challanNumber, true],
          ['Challan Date', shortDate(challan.challanDate), true],
          ['Process', challan.process],
          ['Due back', shortDate(challan.expectedBackOn), true],
          ['Vehicle No', challan.vehicleNo, true],
          ['Transporter', challan.transporter],
          ['LR No', challan.lrNumber, true],
          ['Sent by', challan.sentBy?.name ?? null],
        ],
      }}
      bands={[
        {
          icon: 'truck',
          label: 'Sent from',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{challan.fromWarehouse.name}</div>
              {challan.fromWarehouse.address && <div style={{ marginTop: '1px' }}>{challan.fromWarehouse.address}</div>}
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            left={<Note title="Note">{challan.notes || <Dash />}</Note>}
            totals={
              <TotalsBox
                rows={[{ label: 'Items', value: String(challan.lines.length) }]}
                totalLabel="Value of goods"
                total={`₹ ${money(total)}`}
              />
            }
          />
          <Box title="Declaration" style={{ marginTop: '7px' }}>
            {template.declaration ??
              `Goods sent for job work (${challan.process}) under section 143 of the CGST Act, 2017, and rule 55 of the CGST Rules, 2017. This is not a supply and no GST is charged. The goods remain the property of ${challan.lines.some((l) => l.ownership === 'CUSTOMER_OWNED') ? [...new Set(challan.lines.filter((l) => l.ownership === 'CUSTOMER_OWNED').map((l) => l.ownerCustomer?.name ?? 'our customer'))].join(', ') + ', held by ' + company.name + ' for job work,' : company.name} and are to be returned, as processed goods or as they are, by ${longDate(yearOn(challan.challanDate))} — one year from this challan.`}
          </Box>
        </>
      }
      signatures={[
        { role: `For ${company.name}`, who: challan.sentBy?.name },
        { role: 'Transporter', who: challan.transporter },
        { role: 'Received by job worker', who: null },
      ]}
      footerNote={template.footerNote ?? 'Delivery challan for job work. Not a tax invoice.'}
    />
  )
}
