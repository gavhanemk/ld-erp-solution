'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import {
  StoreSheet,
  Dash,
  Eyebrow,
  Note,
  PartyLine,
  Terms,
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
  type TotalLine,
} from '@/components/print/StoreSheet'
import { Box, DocTable, type DocColumn } from '@/components/print/doc'
import { garmentTable } from '@/components/print/garmentLines'

interface Payload {
  /** The own brand the order is made under, carried from start to end. */
  brand?: { name: string; type: string } | null
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
      item: {
        code: string
        name: string
        color: string | null
        hsnCode: string | null
        uom?: { symbol: string } | null
        style?: { code: string; name: string } | null
      }
      /** The order line it delivers: its colour, fabric, gender, print name. */
      soLine?: {
        styleCode: string | null
        color: string | null
        gender: string | null
        fabric: string | null
        printName: string | null
        description: string | null
        hsnCode: string | null
      } | null
      sizes: Array<{ id: string; qty: string; size: { code: string; sequence: number } }>
    }>
    /** The cartons loaded on it, scanned or picked: its packing list. */
    fgCartons?: Array<{
      code: string
      lines: Array<{ qty: number; grade: string; item: { code: string; name: string; color: string | null; style: { code: string } | null }; size: { code: string; sequence: number } }>
    }>
  }
}

/** The packing list: one row per item in each carton. */
const CARTON_COLUMNS: DocColumn[] = [
  { key: 'carton', head: 'Carton', width: '15%' },
  { key: 'item', head: 'Style · Item', width: '42%' },
  { key: 'sizes', head: 'Sizes × pcs', width: '33%' },
  { key: 'pcs', head: 'Pcs', width: '10%', align: 'right' },
]

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

  // The goods as the sales order prints them (28 Nov 2026): code, description,
  // colour, fabric, gender, print name and every size with its pieces. No
  // prices per line — the consignment's value is printed once, below.
  const { columns, rows } = garmentTable(
    dc.lines.map((l) => ({
      id: l.id,
      item: l.item,
      styleCode: l.soLine?.styleCode,
      color: l.soLine?.color,
      gender: l.soLine?.gender,
      fabric: l.soLine?.fabric,
      printName: l.soLine?.printName,
      description: [l.soLine?.description, l.overNote].filter(Boolean).join(' · ') || null,
      hsnCode: l.soLine?.hsnCode,
      qty: l.qty,
      unitPrice: 0,
      gstRate: 0,
      amount: 0,
      sizes: l.sizes,
    })),
    { showHsn, allColumns: true, money: false },
  )

  const pieces = dc.lines.reduce((s, l) => s + Number(l.qty), 0)

  // Carton by carton: what is in each, by style, item and size.
  const cartonRows = (dc.fgCartons ?? []).flatMap((carton) => {
    const items = new Map<string, { label: string; sizes: string[]; pcs: number }>()
    for (const l of carton.lines) {
      const k = `${l.item.code}|${l.grade}`
      const it = items.get(k) ?? {
        label: `${l.item.style?.code ? `${l.item.style.code} · ` : ''}${l.item.code} ${l.item.color ?? ''}${l.grade === 'B' ? ' (B)' : ''}`,
        sizes: [],
        pcs: 0,
      }
      it.sizes.push(`${l.size.code}×${l.qty}`)
      it.pcs += l.qty
      items.set(k, it)
    }
    return [...items.values()].map((it, i) => ({
      key: `${carton.code}-${i}`,
      cells: {
        carton: i === 0 ? <strong style={CODE}>{carton.code}</strong> : '',
        item: it.label,
        sizes: <span style={NUM}>{it.sizes.join('  ')}</span>,
        pcs: it.pcs,
      },
    }))
  })

  const banner =
    dc.status === 'CANCELLED'
      ? `CANCELLED on ${longDate(dc.cancelledAt)}${dc.cancelledBy ? ` by ${dc.cancelledBy.name}` : ''}${
          dc.cancelReason ? ` — ${dc.cancelReason}` : ''
        }. These goods are not to travel on this challan.`
      : dc.status === 'DRAFT'
        ? 'DRAFT — not yet dispatched. The goods have not left the store.'
        : null

  const totals: TotalLine[] = [
    { label: 'Pieces', value: qty(pieces) },
    { label: 'Cartons', value: dc.cartons != null ? String(dc.cartons) : <Dash /> },
    { label: 'Value', value: money(data.value) },
    { label: 'GST', value: money(data.gst) },
  ]

  // Laid out like the purchase order (27 Nov 2026): the consignee in the "To,"
  // block with the challan's facts and how it travels beside it, then where
  // it goes.
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
      party={{
        name: c.name,
        lines: (
          <>
            <PartyLine label="Address-" value={billing || null} />
            <PartyLine label="GST No" value={c.gstin ?? 'Unregistered'} mono={Boolean(c.gstin)} />
            <PartyLine label="Contact No" value={c.phone} mono />
          </>
        ),
        meta: [
          ['Challan No', dc.dcNumber, true],
          ['Challan Date', shortDate(dc.dcDate), true],
          ['Our Order', `${dc.so.soNumber}, ${shortDate(dc.so.orderDate)}`, true],
          !!dc.so.customerPORef && [
            'Your PO',
            `${dc.so.customerPORef}${dc.so.customerPODate ? `, ${shortDate(dc.so.customerPODate)}` : ''}`,
          ],
          !!data.brand?.name && ['Brand', data.brand?.name],
          dc.so.isJobWork && ['Type', 'Job work (your fabric)'],
          ['From store', dc.warehouse?.name ?? null],
          ['Transporter', dc.transporter],
          ['Vehicle No', dc.vehicleNumber, true],
          ['LR No', dc.lrNumber, true],
          ['E-way Bill', dc.eWayBillNumber, true],
        ],
      }}
      bands={[
        {
          icon: 'truck',
          label: 'Deliver to',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{c.name}</div>
              <div style={{ marginTop: '1px' }}>{dc.deliveryAddress || billing || <Dash />}</div>
            </>
          ),
        },
      ]}
      columns={columns}
      rows={rows}
      after={
        <>
          {cartonRows.length > 0 && (
            <>
              <Eyebrow style={{ marginTop: '9px' }}>
                Packing list — {dc.fgCartons!.length} carton{dc.fgCartons!.length === 1 ? '' : 's'}
              </Eyebrow>
              <DocTable columns={CARTON_COLUMNS} rows={cartonRows} fontSize={9} style={{ marginTop: '3px' }} />
            </>
          )}
          <WordsAndTotals
            words={template.showAmountInWords !== false ? data.valueInWords : null}
            left={
              <>
                {(cartonRows.length === 0 || dc.packingNote) && <Note title="Packing">{dc.packingNote || <Dash />}</Note>}
                {dc.notes && <Note title="Note">{dc.notes}</Note>}
              </>
            }
            totals={<TotalsBox rows={totals} totalLabel="Consignment value" total={`₹ ${money(data.value + data.gst)}`} />}
          />
          <Terms text={template.termsText} title="Terms" />
          {template.declaration && (
            <Box title="Declaration" style={{ marginTop: '7px' }}>
              {template.declaration}
            </Box>
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
