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
  value: number
  gst: number
  valueInWords: string
  challan: {
    dcNumber: string
    dcDate: string
    status: string
    deliveryAddress: string | null
    transporter: string | null
    vehicleNumber: string | null
    lrNumber: string | null
    eWayBillNumber: string | null
    cartons: number | null
    packingNote: string | null
    notes: string | null
    dispatchedAt: string | null
    cancelledAt: string | null
    cancelReason: string | null
    so: {
      soNumber: string
      orderDate: string
      customerPORef: string | null
      customerPODate: string | null
      isJobWork: boolean
    }
    customer: {
      name: string
      gstin: string | null
      phone: string | null
      billingAddress: string | null
      billingCity: string | null
      billingState: string | null
      billingPincode: string | null
    }
    warehouse: { name: string } | null
    createdBy: { name: string } | null
    dispatchedBy: { name: string } | null
    cancelledBy: { name: string } | null
    lines: Array<{
      id: string
      qty: string
      overNote: string | null
      item: { code: string; name: string; color: string | null; hsnCode: string | null }
      sizes: Array<{ id: string; qty: string; size: { code: string; sequence: number } }>
    }>
  }
}

/**
 * The delivery challan that travels with the goods.
 *
 * What is in the cartons — garment, colour, size breakup, pieces — and how it
 * travels. No rates per line: the value of the consignment is printed once,
 * as the e-way bill and the transporter need it. It is not a tax invoice and
 * says so. A draft or a cancelled challan prints with a band across the top.
 */
export default function PrintDeliveryChallan() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/sales/challans/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that challan.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the challan…</p>

  const { company, template, challan: dc } = data
  const c = dc.customer
  const billing = [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')
  const showHsn = template.showHsn !== false

  const columns: SheetColumn[] = [
    { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
    { key: 'item', head: 'Description', width: showHsn ? '37%' : '45%' },
    { key: 'sizes', head: 'Size breakup (pcs)', width: '38%' },
    ...(showHsn ? [{ key: 'hsn', head: 'HSN', width: '8%', align: 'center' as const }] : []),
    { key: 'qty', head: 'Pieces', width: '12%', align: 'right' },
  ]

  const rows = dc.lines.map((l, i) => ({
    key: l.id,
    cells: {
      sn: i + 1,
      item: (
        <>
          <div style={{ fontWeight: 600 }}>
            {l.item.name}
            {l.item.color ? ` · ${l.item.color}` : ''}
          </div>
          <div style={{ fontSize: '8.5px', color: GREY, marginTop: '1px' }}>
            <span style={CODE}>{l.item.code}</span>
            {l.overNote ? ` · ${l.overNote}` : ''}
          </div>
        </>
      ),
      sizes: l.sizes.length ? (
        <span style={{ fontSize: '9px', ...NUM }}>
          {[...l.sizes]
            .sort((a, b) => a.size.sequence - b.size.sequence)
            .map((s) => `${s.size.code} ${qty(s.qty)}`)
            .join(' · ')}
        </span>
      ) : (
        <span style={{ color: MUTED }}>—</span>
      ),
      hsn: <span style={{ fontSize: '9px', color: GREY }}>{l.item.hsnCode ?? '—'}</span>,
      qty: <strong>{qty(l.qty)}</strong>,
    },
  }))

  const pieces = dc.lines.reduce((s, l) => s + Number(l.qty), 0)

  const banner =
    dc.status === 'CANCELLED'
      ? `CANCELLED on ${longDate(dc.cancelledAt)}${dc.cancelledBy ? ` by ${dc.cancelledBy.name}` : ''}${
          dc.cancelReason ? ` — ${dc.cancelReason}` : ''
        }. These goods are not to travel on this challan.`
      : dc.status === 'DRAFT'
        ? 'DRAFT — not yet dispatched. The goods have not left the store.'
        : null

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={dc.dcNumber}
      dateLabel="Challan date"
      date={longDate(dc.dcDate) ?? ''}
      backHref="/sales/challan?tab=challans"
      backLabel="Delivery challans"
      banner={banner}
      panels={[
        {
          title: 'Consignee',
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
              <Fact label="Deliver to" value={dc.deliveryAddress ?? billing} />
              <Fact label="Transporter" value={dc.transporter} />
              <Fact label="Vehicle" value={dc.vehicleNumber} mono />
              <Fact label="LR No" value={dc.lrNumber} mono />
              <Fact label="E-way bill" value={dc.eWayBillNumber} mono />
            </>
          ),
        },
        {
          title: 'Against',
          body: (
            <>
              <Fact label="Our order" value={`${dc.so.soNumber}, ${longDate(dc.so.orderDate)}`} mono />
              <Fact
                label="Your PO"
                value={
                  dc.so.customerPORef
                    ? `${dc.so.customerPORef}${dc.so.customerPODate ? `, ${longDate(dc.so.customerPODate)}` : ''}`
                    : null
                }
              />
              <Fact label="Type" value={dc.so.isJobWork ? 'Job work (your fabric)' : null} />
              <Fact label="From" value={dc.warehouse?.name} />
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
              <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                <Eyebrow style={{ color: GREY }}>Packing</Eyebrow>
                <div style={{ fontSize: '10px', color: dc.packingNote ? INK : MUTED, marginTop: '3px', lineHeight: 1.55 }}>
                  {dc.packingNote ?? 'None.'}
                </div>
              </div>
              {dc.notes && (
                <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                  <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
                  <div style={{ fontSize: '10px', color: GREY, marginTop: '3px', lineHeight: 1.55 }}>{dc.notes}</div>
                </div>
              )}
              {template.showAmountInWords !== false && (
                <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
                  <Eyebrow style={{ color: GREY }}>Value of goods, in words</Eyebrow>
                  <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.55 }}>{data.valueInWords}</div>
                </div>
              )}
            </div>
            <div style={{ border: `1px solid ${RULE}`, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '6px 11px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                {(
                  [
                    ['Pieces', qty(pieces)],
                    ['Cartons', dc.cartons != null ? String(dc.cartons) : '—'],
                    ['Value', money(data.value)],
                    ['GST', money(data.gst)],
                  ] as Array<[string, string]>
                ).map(([label, value]) => (
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
                  Consignment value
                </span>
                <span style={{ fontSize: '13px', fontWeight: 700, ...NUM }}>₹{money(data.value + data.gst)}</span>
              </div>
            </div>
          </div>
          {template.termsText && (
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
              <Eyebrow style={{ color: GREY }}>Terms</Eyebrow>
              <div style={{ fontSize: '9.5px', color: INK, marginTop: '3px', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                {template.termsText}
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
        { role: `For ${company.name}`, who: dc.dispatchedBy?.name ?? dc.createdBy?.name },
        { role: 'Transporter', who: null },
        { role: 'Received in good condition', who: null },
      ]}
      footerNote={template.footerNote ?? 'Delivery challan. Not a tax invoice; the invoice follows separately.'}
    />
  )
}
