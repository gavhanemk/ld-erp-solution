'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { ChargeTaxTreatment } from '@ld-erp/shared'
import { saleChargeRow } from '@/components/print/saleChargeRow'
import {
  StoreSheet,
  Dash,
  Note,
  PartyLine,
  TaxByRate,
  Terms,
  TotalsBox,
  WordsAndTotals,
  qty,
  money,
  longDate,
  shortDate,
  INK,
  MUTED,
  type TotalLine,
} from '@/components/print/StoreSheet'
import { garmentTable } from '@/components/print/garmentLines'

interface Payload {
  company: Record<string, string | null>
  template: {
    title: string
    termsText: string | null
    declaration: string | null
    footerNote: string | null
    showHsn: boolean
    showAmountInWords: boolean
  }
  totalInWords: string
  taxMode: 'IGST' | 'CGST_SGST' | 'NONE'
  placeOfSupplyState: string | null
  order: {
    soNumber: string
    status: string
    version: number
    orderDate: string
    deliveryDate: string | null
    customerPORef: string | null
    customerPODate: string | null
    deliveryAddress: string | null
    billingAddress: string | null
    reference: string | null
    salesperson: string | null
    placeOfSupplyCode: string | null
    isJobWork: boolean
    notes: string | null
    terms: string | null
    otherCharges: string
    charges: Array<{ id: string; amount: string; netAmount?: string | null; taxTreatment?: ChargeTaxTreatment | null; gstRate: string; cgst: string; sgst: string; igst: string; chargeType: { name: string } }>
    subtotal: string
    discountAmount: string
    taxableAmount: string
    cgst: string
    sgst: string
    igst: string
    roundOff: string
    totalAmount: string
    sentForApprovalAt: string | null
    approvedAt: string | null
    cancelledAt: string | null
    cancelReason: string | null
    shortClosedAt: string | null
    shortCloseReason: string | null
    customer: {
      name: string
      gstin: string | null
      phone: string | null
      billingAddress: string | null
      billingCity: string | null
      billingState: string | null
      billingStateCode: string | null
      billingPincode: string | null
    }
    brand: { name: string }
    createdBy: { name: string } | null
    approvedBy: { name: string } | null
    cancelledBy: { name: string } | null
    shortClosedBy: { name: string } | null
    lines: Array<{
      id: string
      styleCode: string | null
      color: string | null
      totalQty: string
      unitPrice: string
      discount: string
      gstRate: string
      hsnCode: string | null
      amount: string
      gender: string | null
      fabric: string | null
      printName: string | null
      description: string | null
      taxExempt: boolean
      item: {
        code: string
        name: string
        color: string | null
        hsnCode: string | null
        uom: { symbol: string } | null
        style: { code: string; name: string } | null
      }
      sizes: Array<{ id: string; qty: string; size: { code: string; sequence?: number | null } }>
    }>
  }
}

/**
 * The order confirmation: what goes back to the buyer for their PO.
 *
 * Our word that we will make and deliver this — styles, colours, the size
 * breakup, rates, tax and the delivery date. It is not a tax invoice and says
 * so. Brokerage is internal and never printed. A draft, a cancelled or a
 * short-closed order prints with a band across the top saying so, so a sheet
 * that is not a live confirmation cannot be mistaken for one.
 */
export default function PrintSalesOrder() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sales/orders/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that order.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the order…</p>

  const { company, template, order, taxMode } = data
  const c = order.customer
  // The order's own bill-to when it was changed for this order, else the customer's.
  const billing =
    order.billingAddress || [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')
  const termsText = order.terms || template.termsText
  const showHsn = template.showHsn !== false

  // The lines as the old ERP printed them: code, description, colour, fabric,
  // gender, print name, then every size with its pieces (28 Nov 2026).
  const { columns, rows } = garmentTable(
    order.lines.map((l) => ({ ...l, qty: l.totalQty })),
    { showHsn, rateHead: order.isJobWork ? 'Job charge' : 'Rate', allColumns: true },
  )

  const pieces = order.lines.reduce((s, l) => s + Number(l.totalQty), 0)

  // GST at each rate: the goods (after the order discount, spread across the
  // lines as it was when priced) and the charges.
  const subtotal = Number(order.subtotal)
  const factor = subtotal > 0 ? Number(order.taxableAmount) / subtotal : 1
  const byRate = new Map<number, { taxable: number; tax: number }>()
  const addRate = (rate: number, base: number, tax: number) => {
    const r = byRate.get(rate) ?? { taxable: 0, tax: 0 }
    r.taxable += base
    r.tax += tax
    byRate.set(rate, r)
  }
  for (const l of order.lines) {
    const rate = l.taxExempt ? 0 : Number(l.gstRate)
    const base = Number(l.amount) * factor
    addRate(rate, base, (base * rate) / 100)
  }
  // A charge's value without GST (its GST included or added); one with no GST is outside the taxable value.
  for (const ch of order.charges) {
    if (ch.taxTreatment === 'NON_TAXABLE') continue
    addRate(Number(ch.gstRate), Number(ch.netAmount ?? ch.amount), Number(ch.cgst) + Number(ch.sgst) + Number(ch.igst))
  }
  const gstSummary = [...byRate.entries()]
    .map(([rate, r]) => ({ rate, taxable: r.taxable, tax: r.tax }))
    .filter((r) => r.taxable > 0)
    .sort((a, b) => a.rate - b.rate)
  // GST at each rate, one line per rate, as the purchase order prints it.
  const taxRows = gstSummary.map((r) => ({ gstRate: r.rate, taxable: r.taxable, cgst: r.tax / 2, sgst: r.tax / 2, igst: r.tax }))

  const banner =
    order.status === 'CANCELLED'
      ? `${order.approvedAt ? 'CANCELLED' : 'NOT CONFIRMED — REJECTED'} on ${longDate(order.cancelledAt)}${
          order.cancelledBy ? ` by ${order.cancelledBy.name}` : ''
        }${order.cancelReason ? ` — ${order.cancelReason}` : ''}. This order is not to be made.`
      : order.status === 'DRAFT'
        ? order.sentForApprovalAt
          ? 'ON CREDIT HOLD — waiting for a manager. Not a confirmation: do not send this to the buyer yet.'
          : 'DRAFT — not yet confirmed. Not a confirmation: do not send this to the buyer.'
        : order.shortClosedAt
          ? `SHORT-CLOSED on ${longDate(order.shortClosedAt)}${
              order.shortCloseReason ? ` — ${order.shortCloseReason}` : ''
            }. The order ended at what was delivered.`
          : null

  const totalRows: Array<[string, string]> = [
    ['Value', money(order.subtotal)],
    ...(Number(order.discountAmount) > 0 ? ([['Discount', `− ${money(order.discountAmount)}`]] as Array<[string, string]>) : []),
    [order.charges.length ? 'Taxable value of the goods' : 'Taxable value', money(order.taxableAmount)],
    // Each charge at its value without GST; its GST is in the CGST/SGST or IGST rows.
    ...order.charges.map(saleChargeRow),
    ...(taxMode === 'CGST_SGST'
      ? ([
          ['CGST', money(order.cgst)],
          ['SGST', money(order.sgst)],
        ] as Array<[string, string]>)
      : taxMode === 'IGST'
        ? ([['IGST', money(order.igst)]] as Array<[string, string]>)
        : []),
    ...(Number(order.otherCharges) > 0 ? ([['Other charges', money(order.otherCharges)]] as Array<[string, string]>) : []),
    ...(Math.abs(Number(order.roundOff)) >= 0.005 ? ([['Rounding', money(order.roundOff)]] as Array<[string, string]>) : []),
  ]
  const totals: TotalLine[] = [{ label: 'Pieces', value: qty(pieces) }, ...totalRows.map(([label, value]) => ({ label, value }))]

  // Laid out like the purchase order (27 Nov 2026): the buyer in the "To,"
  // block with the order's facts beside it, then where it goes.
  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={order.soNumber}
      dateLabel="Order date"
      date={longDate(order.orderDate) ?? ''}
      backHref="/sales/orders"
      backLabel="Sales orders"
      banner={banner}
      party={{
        name: c.name,
        lines: (
          <>
            <PartyLine label="Address-" value={billing || null} />
            <PartyLine label="GST No" value={c.gstin ?? 'Unregistered'} mono={Boolean(c.gstin)} />
            <PartyLine label="Contact No" value={c.phone} mono />
            <PartyLine
              label="Place of supply"
              value={
                order.placeOfSupplyCode
                  ? `${data.placeOfSupplyState ?? ''} (${order.placeOfSupplyCode})${taxMode === 'IGST' ? ', inter-state' : ''}`
                  : null
              }
            />
          </>
        ),
        meta: [
          ['Order No', order.version > 1 ? `${order.soNumber} (v${order.version})` : order.soNumber, true],
          ['Order Date', shortDate(order.orderDate), true],
          !!order.deliveryDate && ['Ship by', shortDate(order.deliveryDate), true],
          !!order.customerPORef && [
            'Your PO',
            `${order.customerPORef}${order.customerPODate ? `, ${shortDate(order.customerPODate)}` : ''}`,
          ],
          !!order.reference && ['Reference', order.reference],
          ['Brand', order.brand.name],
          order.isJobWork && ['Type', 'Job work (your fabric)'],
          !!order.salesperson && ['Salesperson', order.salesperson],
        ],
      }}
      bands={[
        {
          icon: 'truck',
          label: 'Deliver to',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{c.name}</div>
              <div style={{ marginTop: '1px' }}>{order.deliveryAddress || billing || '—'}</div>
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      after={
        <>
          <WordsAndTotals
            words={template.showAmountInWords !== false ? data.totalInWords : null}
            left={<Note title="Special notes">{order.notes || <Dash />}</Note>}
            totals={<TotalsBox rows={totals} totalLabel="Order total" total={`₹ ${money(order.totalAmount)}`} />}
          />
          <TaxByRate rows={taxRows} split={taxMode} />
          <Terms text={termsText} />
          {template.declaration && <div style={{ fontSize: '9.5px', marginTop: '7px' }}>{template.declaration}</div>}
        </>
      }
      signatures={[
        { role: `For ${company.name}`, who: order.approvedBy?.name ?? order.createdBy?.name },
        { role: 'Accepted by the buyer', who: null },
      ]}
      footerNote={template.footerNote ?? 'Sales order against your purchase order. Not a tax invoice.'}
    />
  )
}
