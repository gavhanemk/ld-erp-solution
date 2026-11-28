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
  longDate,
  shortDate,
  CODE,
  INK,
  MUTED,
  type SheetColumn,
  type TotalLine,
} from '@/components/print/StoreSheet'
import { Box, SubLine } from '@/components/print/doc'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { itemShade, type ShadeFields } from '@/lib/items'

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
      item: { code: string; name: string; hsnCode: string | null; uom: { symbol: string } | null } & ShadeFields
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

/** A figure per unit — metres and pieces are never added together: "20 mtr · 12 pcs". */
function perUnit<T>(lines: T[], unitOf: (l: T) => string, figure: (l: T) => number): string {
  const sums = new Map<string, number>()
  for (const l of lines) sums.set(unitOf(l), (sums.get(unitOf(l)) ?? 0) + figure(l))
  return [...sums.entries()].map(([unit, n]) => `${qty(n)} ${unit}`.trim()).join(' · ') || '0'
}

/**
 * The delivery challan that goes with a customer's own material back to them.
 *
 * Their goods, going home: not a supply, so no value and no tax. Rule 55 still
 * wants a challan naming both parties with each item's HSN and quantity, and
 * the receipt it came in on is quoted where there is one, so both sides can
 * put the two documents side by side.
 *
 * Laid out like the purchase order (27 Nov 2026): the customer in the "To,"
 * block with the challan's facts beside it, the store the goods leave in a band.
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
          {itemShade(l.item) && <SubLine>{itemShade(l.item)}</SubLine>}
          {l.notes && <SubLine>{l.notes}</SubLine>}
        </>
      ),
      hsn: l.hsnCode ?? l.item.hsnCode ?? '—',
      uom: l.item.uom?.symbol ?? '',
      qty: <strong>{qty(l.qty)}</strong>,
    },
  }))

  const totals: TotalLine[] = [{ label: 'Items', value: doc.lines.length }]

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
      party={{
        heading: 'To, the customer (consignee)',
        name: c.name,
        code: c.code,
        lines: (
          <>
            <PartyLine label="Address-" value={address || null} />
            <PartyLine label="GST No" value={c.gstin ?? 'Unregistered'} mono={Boolean(c.gstin)} />
            <PartyLine label="Contact No" value={c.phone} mono />
            <PartyLine
              label="Place of supply"
              value={
                ship.state
                  ? `${ship.state}${ship.stateCode ? ` (${ship.stateCode})` : ''}${interState ? ', inter-state' : ''}`
                  : null
              }
            />
          </>
        ),
        meta: [
          ['Challan No', doc.returnNumber, true],
          ['Challan Date', shortDate(doc.returnDate), true],
          ['Reason', doc.reasonLabel],
          ['Came in on', doc.grn ? `${doc.grn.grnNumber}, ${shortDate(doc.grn.receiptDate)}` : null, true],
          [
            'Their challan',
            doc.grn?.challanNumber ? `${doc.grn.challanNumber}${doc.grn.challanDate ? `, ${shortDate(doc.grn.challanDate)}` : ''}` : null,
            true,
          ],
          ['Vehicle No', doc.vehicleNo, true],
          ['Transporter', doc.transporter],
          ['LR No', doc.lrNumber, true],
        ],
      }}
      bands={[
        {
          icon: 'truck',
          label: 'From store',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{doc.warehouse.name}</div>
              {doc.warehouse.address && <div style={{ marginTop: '1px' }}>{doc.warehouse.address}</div>}
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            words={null}
            left={<Note title="Note">{doc.notes || <Dash />}</Note>}
            totals={
              <TotalsBox
                rows={totals}
                totalLabel="Quantity"
                total={perUnit(doc.lines, (l) => l.item.uom?.symbol ?? '', (l) => Number(l.qty))}
              />
            }
          />
          <Box title="Declaration" style={{ marginTop: '7px' }}>
            {template.declaration ??
              `The goods above are the property of ${c.name}, received by ${company.name}${doc.grn ? ` on ${doc.grn.grnNumber}` : ''}, and are being returned to them unworked. This is not a supply under the CGST Act, 2017; the challan is issued under rule 55 of the CGST Rules, 2017, and carries no value and no tax.`}
          </Box>
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
