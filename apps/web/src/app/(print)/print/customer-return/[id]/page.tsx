'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  Fact,
  Eyebrow,
  qty,
  longDate,
  CODE,
  GREY,
  INK,
  MUTED,
  NAVY,
  RULE,
  type SheetColumn,
} from '@/components/print/StoreSheet'
import { SmartSelect } from '@/components/ui/SmartSelect'

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null; declaration: string | null }
  doc: {
    returnNumber: string
    returnDate: string
    reason: string
    reasonLabel: string
    vehicleNo: string | null
    transporter: string | null
    lrNumber: string | null
    notes: string | null
    cancelledAt: string | null
    cancelReason: string | null
    customer: {
      name: string
      code: string | null
      gstin: string | null
      phone: string | null
      billingAddress: string | null
      billingCity: string | null
      billingState: string | null
      billingStateCode: string | null
      billingPincode: string | null
      shippingAddress: string | null
      shippingCity: string | null
      shippingState: string | null
      shippingStateCode: string | null
      shippingPincode: string | null
    }
    grn: { grnNumber: string; receiptDate: string; challanNumber: string | null; challanDate: string | null } | null
    warehouse: { name: string; address: string | null }
    createdBy: { name: string } | null
    cancelledBy: { name: string } | null
    lines: Array<{
      id: string
      qty: string
      hsnCode: string | null
      notes: string | null
      item: { code: string; name: string; hsnCode: string | null; uom: { symbol: string } | null }
    }>
  }
}

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
  { key: 'code', head: 'Item Code', width: '15%' },
  { key: 'desc', head: 'Description of Goods', width: '46%' },
  { key: 'hsn', head: 'HSN', width: '10%', align: 'center' },
  { key: 'uom', head: 'UOM', width: '8%', align: 'center' },
  { key: 'qty', head: 'Quantity', width: '16%', align: 'right' },
]

/** The original goes with the goods to the customer, the duplicate with the transporter, the triplicate stays. */
const COPIES = ['Original for customer', 'Duplicate for transporter', 'Triplicate for us']

/**
 * The delivery challan that goes with a customer's own material back to them.
 *
 * Their goods, going home: not a supply, so no value and no tax. Rule 55 still
 * wants a challan naming both parties with each item's HSN and quantity, and
 * the receipt it came in on is quoted where there is one, so both sides can
 * put the two documents side by side.
 */
export default function PrintCustomerReturn() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copy, setCopy] = useState(COPIES[0])

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/inventory/customer-return/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that return.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the challan…</p>

  const { company, template, doc } = data
  const c = doc.customer
  // Goods go to where the customer takes delivery, when that is recorded.
  const ship = c.shippingAddress
    ? { address: c.shippingAddress, city: c.shippingCity, state: c.shippingState, stateCode: c.shippingStateCode, pincode: c.shippingPincode }
    : { address: c.billingAddress, city: c.billingCity, state: c.billingState, stateCode: c.billingStateCode, pincode: c.billingPincode }
  const address = [ship.address, ship.city, ship.state, ship.pincode].filter(Boolean).join(', ')
  const interState = Boolean(company.stateCode && ship.stateCode && company.stateCode !== ship.stateCode)

  const rows = doc.lines.map((l, i) => ({
    key: l.id,
    cells: {
      sn: i + 1,
      code: <span style={CODE}>{l.item.code}</span>,
      desc: (
        <>
          <div style={{ fontWeight: 600 }}>{l.item.name}</div>
          {l.notes && <div style={{ fontSize: '9px', color: GREY }}>{l.notes}</div>}
        </>
      ),
      hsn: <span style={{ fontSize: '9px', color: GREY }}>{l.hsnCode ?? l.item.hsnCode ?? '—'}</span>,
      uom: <span style={{ fontSize: '9px', color: GREY }}>{l.item.uom?.symbol ?? ''}</span>,
      qty: <strong>{qty(l.qty)}</strong>,
    },
  }))

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={doc.returnNumber}
      copyLabel={copy}
      dateLabel="Challan date"
      date={longDate(doc.returnDate) ?? ''}
      backHref="/inventory/customer-material?view=returns"
      backLabel="Customer material"
      banner={
        doc.cancelledAt
          ? `CANCELLED on ${longDate(doc.cancelledAt)}${doc.cancelledBy ? ` by ${doc.cancelledBy.name}` : ''}${doc.cancelReason ? ` — ${doc.cancelReason}` : ''}. The goods did not go back on this challan.`
          : null
      }
      options={
        <label>
          Copy
          <SmartSelect value={copy} onChange={(e) => setCopy(e.target.value)}>
            {COPIES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </SmartSelect>
        </label>
      }
      panels={[
        {
          title: 'Customer (consignee)',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{c.name}</div>
              {address && <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{address}</div>}
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={c.gstin ?? 'Unregistered'} mono />
                <Fact label="State" value={ship.state ? `${ship.state}${ship.stateCode ? ` (${ship.stateCode})` : ''}` : null} />
                <Fact label="Phone" value={c.phone} />
              </div>
            </>
          ),
        },
        {
          title: 'Dispatch',
          body: (
            <>
              <Fact label="From store" value={doc.warehouse.name} />
              <Fact label="Vehicle No" value={doc.vehicleNo} mono />
              <Fact label="Transporter" value={doc.transporter} />
              <Fact label="LR No" value={doc.lrNumber} mono />
              <Fact label="Place of supply" value={ship.state ? `${ship.state}${interState ? ' (inter-state)' : ''}` : null} />
            </>
          ),
        },
        {
          title: 'The return',
          body: (
            <>
              <Fact label="Challan No" value={doc.returnNumber} mono />
              <Fact label="Reason" value={doc.reasonLabel} />
              <Fact label="Came in on" value={doc.grn ? `${doc.grn.grnNumber}, ${longDate(doc.grn.receiptDate)}` : null} />
              <Fact label="Their challan" value={doc.grn?.challanNumber ? `${doc.grn.challanNumber}${doc.grn.challanDate ? `, ${longDate(doc.grn.challanDate)}` : ''}` : null} />
              <Fact label="Items" value={String(doc.lines.length)} />
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      minRows={6}
      after={
        <>
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '8px' }}>
            <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
            <div style={{ fontSize: '10px', color: doc.notes ? GREY : MUTED, marginTop: '3px', lineHeight: 1.55 }}>{doc.notes ?? 'None.'}</div>
          </div>
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
            <Eyebrow style={{ color: GREY }}>Declaration</Eyebrow>
            <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.6 }}>
              {template.declaration ??
                `The goods above are the property of ${c.name}, received by ${company.name}${doc.grn ? ` on ${doc.grn.grnNumber}` : ''}, and are being returned to them unworked. This is not a supply under the CGST Act, 2017; the challan is issued under rule 55 of the CGST Rules, 2017, and carries no value and no tax.`}
            </div>
          </div>
        </>
      }
      signatures={[
        { role: `For ${company.name}`, who: doc.createdBy?.name },
        { role: 'Transporter', who: doc.transporter },
        { role: 'Received by customer', who: null },
      ]}
      footerNote={template.footerNote ?? 'Delivery challan for the return of customer material. Not a tax invoice.'}
    />
  )
}
