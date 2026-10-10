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
  CODE,
  GREY,
  INK,
  MUTED,
  NAVY,
  NUM,
  RULE,
  type SheetColumn,
} from '@/components/print/StoreSheet'
import { lineDetails } from '@/components/sales/OrderLinesView'

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
    charges: Array<{ id: string; amount: string; gstRate: string; chargeType: { name: string } }>
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
      sizes: Array<{ id: string; qty: string; size: { code: string } }>
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

  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: '4%', align: 'center' },
    { key: 'item', head: 'Style / Description', width: showHsn ? '28%' : '34%' },
    { key: 'sizes', head: 'Size breakup (pcs)', width: '24%' },
    ...(showHsn ? [{ key: 'hsn', head: 'HSN', width: '7%', align: 'center' as const }] : []),
    { key: 'qty', head: 'Pieces', width: '8%', align: 'right' },
    { key: 'rate', head: order.isJobWork ? 'Job charge' : 'Rate', width: '9%', align: 'right' },
    { key: 'disc', head: 'Disc', width: '5%', align: 'right' },
    { key: 'gst', head: 'GST', width: '5%', align: 'right' },
    { key: 'amount', head: 'Amount (₹)', width: '10%', align: 'right' },
  ]

  const rows = order.lines.map((l, i) => {
    const colour = l.color || l.item.color
    const style = l.styleCode || l.item.style?.code
    return {
      key: l.id,
      cells: {
        sn: i + 1,
        item: (
          <>
            <div style={{ fontWeight: 600 }}>
              {l.item.name}
              {colour ? ` · ${colour}` : ''}
            </div>
            <div style={{ fontSize: '8.5px', color: GREY, marginTop: '1px' }}>
              <span style={CODE}>{l.item.code}</span>
              {style ? ` · Style ${style}` : ''}
            </div>
            {lineDetails(l) && <div style={{ fontSize: '8.5px', color: GREY, marginTop: '1px' }}>{lineDetails(l)}</div>}
            {l.description && <div style={{ fontSize: '8.5px', color: INK, marginTop: '1px' }}>{l.description}</div>}
          </>
        ),
        sizes: l.sizes.length ? (
          <span style={{ fontSize: '9px', ...NUM }}>
            {l.sizes.map((s) => `${s.size.code} ${qty(s.qty)}`).join(' · ')}
          </span>
        ) : (
          <span style={{ color: MUTED }}>—</span>
        ),
        hsn: <span style={{ fontSize: '9px', color: GREY }}>{l.hsnCode ?? l.item.hsnCode ?? '—'}</span>,
        qty: <strong>{qty(l.totalQty)}</strong>,
        rate: money(l.unitPrice),
        disc: Number(l.discount) > 0 ? `${Number(l.discount)}%` : '—',
        gst: l.taxExempt ? 'Nil' : `${Number(l.gstRate)}%`,
        amount: money(l.amount),
      },
    }
  })

  const pieces = order.lines.reduce((s, l) => s + Number(l.totalQty), 0)

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
    ['Taxable value', money(order.taxableAmount)],
    ...order.charges.map((ch) => [`${ch.chargeType.name} @ ${Number(ch.gstRate)}%`, money(ch.amount)] as [string, string]),
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
      panels={[
        {
          title: 'Buyer',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{c.name}</div>
              {billing && <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{billing}</div>}
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={c.gstin ?? 'Unregistered'} mono />
                <Fact label="Phone" value={c.phone} />
              </div>
            </>
          ),
        },
        {
          title: 'Delivery',
          body: (
            <>
              <Fact label="Deliver by" value={longDate(order.deliveryDate)} />
              <Fact label="Deliver to" value={order.deliveryAddress} />
              <Fact
                label="Place of supply"
                value={
                  order.placeOfSupplyCode
                    ? `${data.placeOfSupplyState ?? ''} (${order.placeOfSupplyCode})${taxMode === 'IGST' ? ', inter-state' : ''}`
                    : null
                }
              />
            </>
          ),
        },
        {
          title: 'Order',
          body: (
            <>
              <Fact label="Order No" value={order.version > 1 ? `${order.soNumber} (version ${order.version})` : order.soNumber} mono />
              <Fact
                label="Your PO"
                value={
                  order.customerPORef
                    ? `${order.customerPORef}${order.customerPODate ? `, ${longDate(order.customerPODate)}` : ''}`
                    : null
                }
              />
              <Fact label="Reference" value={order.reference} />
              <Fact label="Brand" value={order.brand.name} />
              <Fact label="Type" value={order.isJobWork ? 'Job work (your fabric)' : null} />
              <Fact label="Salesperson" value={order.salesperson} />
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      minRows={6}
      after={
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 250px', gap: '7px', marginTop: '8px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {template.showAmountInWords !== false && (
                <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                  <Eyebrow style={{ color: GREY }}>Amount in words</Eyebrow>
                  <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.55 }}>{data.totalInWords}</div>
                </div>
              )}
              <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
                <div style={{ fontSize: '10px', color: order.notes ? GREY : MUTED, marginTop: '3px', lineHeight: 1.55 }}>
                  {order.notes ?? 'None.'}
                </div>
              </div>
            </div>
            <div style={{ border: `1px solid ${RULE}`, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '6px 11px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: GREY }}>
                  <span>Pieces</span>
                  <span style={NUM}>{qty(pieces)}</span>
                </div>
                {totalRows.map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: INK }}>
                    <span>{label}</span>
                    <span style={NUM}>{value}</span>
                  </div>
                ))}
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '7px 11px',
                  background: NAVY,
                  color: '#fff',
                  marginTop: 'auto',
                }}
              >
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>
                  Order total
                </span>
                <span style={{ fontSize: '13px', fontWeight: 700, ...NUM }}>₹{money(order.totalAmount)}</span>
              </div>
            </div>
          </div>
          {termsText && (
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
              <Eyebrow style={{ color: GREY }}>Terms</Eyebrow>
              <div style={{ fontSize: '9.5px', color: INK, marginTop: '3px', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                {termsText}
              </div>
            </div>
          )}
          {template.declaration && (
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
              <Eyebrow style={{ color: GREY }}>Declaration</Eyebrow>
              <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.6 }}>{template.declaration}</div>
            </div>
          )}
        </>
      }
      signatures={[
        { role: `For ${company.name}`, who: order.approvedBy?.name ?? order.createdBy?.name },
        { role: 'Accepted by the buyer', who: null },
      ]}
      footerNote={template.footerNote ?? 'Order confirmation against your purchase order. Not a tax invoice.'}
    />
  )
}
