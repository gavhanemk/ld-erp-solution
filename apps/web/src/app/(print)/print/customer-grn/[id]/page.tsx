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
    grnNumber: string
    status: string
    statusLabel: string
    receiptDate: string
    challanNumber: string | null
    challanDate: string | null
    gateEntryNumber: string | null
    gateEntryDate: string | null
    billNumber: string | null
    billDate: string | null
    vehicleNo: string | null
    transporter: string | null
    notes: string | null
    inspectionNotes: string | null
    postedAt: string | null
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
      billingPincode: string | null
    }
    so: { soNumber: string } | null
    warehouse: { name: string; address: string | null }
    receivedBy: { name: string } | null
    inspectedBy: { name: string } | null
    inspectedAt: string | null
    postedBy: { name: string } | null
    cancelledBy: { name: string } | null
    correctionOf: { grnNumber: string } | null
    lines: Array<{
      id: string
      itemId: string
      challanQty: string
      receivedQty: string
      rejectedQty: string
      rejectReason: string | null
      releasedQty: string
      batchNumber: string | null
      markings: string | null
      item: { code: string; name: string; uom: { symbol: string } | null }
    }>
    packages: Array<{ code: string; itemId: string; qty: string; initialQty: string; grade: string; status: string }>
  }
}

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '4%', align: 'center' },
  { key: 'desc', head: 'Item', width: '30%' },
  { key: 'uom', head: 'UOM', width: '6%', align: 'center' },
  { key: 'challan', head: 'Their challan', width: '10%', align: 'right' },
  { key: 'received', head: 'Received', width: '10%', align: 'right' },
  { key: 'diff', head: 'Short / extra', width: '10%', align: 'right' },
  { key: 'accepted', head: 'Accepted', width: '10%', align: 'right' },
  { key: 'rejected', head: 'Rejected (held)', width: '20%', align: 'right' },
]

/** One copy for the customer's driver, one for our file. */
const COPIES = ['Copy for the customer', 'Office copy']

/**
 * A customer's material, acknowledged.
 *
 * Their challan beside what we counted: what arrived, what was short or more,
 * what was accepted and what was rejected and is held — with why — and the
 * sticker numbers on the rolls, so the customer, the driver and the store all
 * hold the same paper. It is their property, received for job work: no value,
 * no tax.
 */
export default function PrintCustomerGrn() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copy, setCopy] = useState(COPIES[0])

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/inventory/customer-grn/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that receipt.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the receipt…</p>

  const { company, template, doc } = data
  const c = doc.customer
  const address = [c.billingAddress, c.billingCity, c.billingState, c.billingPincode].filter(Boolean).join(', ')

  const rows = doc.lines.map((l, i) => {
    const received = Number(l.receivedQty)
    const rejected = Number(l.rejectedQty)
    const diff = received - Number(l.challanQty)
    const codes = doc.packages.filter((p) => p.itemId === l.itemId)
    return {
      key: l.id,
      cells: {
        sn: i + 1,
        desc: (
          <>
            <div style={{ fontWeight: 600 }}>
              <span style={CODE}>{l.item.code}</span> {l.item.name}
            </div>
            {(l.batchNumber || l.markings) && <div style={{ fontSize: '9px', color: GREY }}>{[l.batchNumber && `Lot ${l.batchNumber}`, l.markings].filter(Boolean).join(' · ')}</div>}
            {codes.length > 0 && (
              <div style={{ fontSize: '8.5px', color: GREY, marginTop: '2px', lineHeight: 1.45 }}>
                Stickers: {codes.map((p) => `${p.code}${p.grade === 'R' ? ' (held)' : ''}`).join(', ')}
              </div>
            )}
          </>
        ),
        uom: <span style={{ fontSize: '9px', color: GREY }}>{l.item.uom?.symbol ?? ''}</span>,
        challan: qty(l.challanQty),
        received: <strong>{qty(l.receivedQty)}</strong>,
        diff: diff === 0 ? <span style={{ color: GREY }}>—</span> : `${diff > 0 ? '+' : '−'}${qty(Math.abs(diff))}`,
        accepted: <strong>{qty(received - rejected)}</strong>,
        rejected:
          rejected > 0 ? (
            <>
              <strong>{qty(rejected)}</strong>
              {l.rejectReason && <div style={{ fontSize: '9px', color: GREY }}>{l.rejectReason}</div>}
              {Number(l.releasedQty) > 0 && <div style={{ fontSize: '9px', color: GREY }}>{qty(l.releasedQty)} released for use</div>}
            </>
          ) : (
            <span style={{ color: GREY }}>—</span>
          ),
      },
    }
  })

  const banner =
    doc.status === 'CANCELLED'
      ? `CANCELLED${doc.cancelledAt ? ` on ${longDate(doc.cancelledAt)}` : ''}${doc.cancelledBy ? ` by ${doc.cancelledBy.name}` : ''}${doc.cancelReason ? ` — ${doc.cancelReason}` : ''}. This receipt is not on the books.`
      : doc.status !== 'POSTED'
        ? `${doc.statusLabel.toUpperCase()}: not yet approved. Nothing on this receipt is on the books until it is posted.`
        : null

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={doc.grnNumber}
      copyLabel={copy}
      dateLabel="Received on"
      date={longDate(doc.receiptDate) ?? ''}
      backHref="/inventory/customer-material"
      backLabel="Customer material"
      banner={banner}
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
          title: 'Customer (owner of the goods)',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{c.name}</div>
              {address && <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{address}</div>}
              <div style={{ marginTop: '4px' }}>
                <Fact label="GSTIN" value={c.gstin ?? 'Unregistered'} mono />
                <Fact label="Phone" value={c.phone} />
                <Fact label="For order" value={doc.so?.soNumber ?? 'Not against an order'} />
              </div>
            </>
          ),
        },
        {
          title: 'Their paperwork',
          body: (
            <>
              <Fact label="Their challan" value={doc.challanNumber ? `${doc.challanNumber}${doc.challanDate ? `, ${longDate(doc.challanDate)}` : ''}` : null} mono />
              <Fact label="Their bill" value={doc.billNumber ? `${doc.billNumber}${doc.billDate ? `, ${longDate(doc.billDate)}` : ''}` : null} mono />
              <Fact label="Gate entry" value={doc.gateEntryNumber ? `${doc.gateEntryNumber}${doc.gateEntryDate ? `, ${longDate(doc.gateEntryDate)}` : ''}` : null} mono />
              <Fact label="Vehicle No" value={doc.vehicleNo} mono />
              <Fact label="Transporter" value={doc.transporter} />
            </>
          ),
        },
        {
          title: 'The receipt',
          body: (
            <>
              <Fact label="Receipt No" value={doc.grnNumber} mono />
              <Fact label="Into store" value={doc.warehouse.name} />
              <Fact label="Status" value={doc.statusLabel} />
              <Fact label="QC" value={doc.inspectedAt ? `${longDate(doc.inspectedAt)}${doc.inspectedBy ? `, ${doc.inspectedBy.name}` : ''}` : null} />
              <Fact label="Approved" value={doc.postedAt ? `${longDate(doc.postedAt)}${doc.postedBy ? `, ${doc.postedBy.name}` : ''}` : null} />
              <Fact label="Corrects" value={doc.correctionOf?.grnNumber ?? null} mono />
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      minRows={5}
      after={
        <>
          {(doc.inspectionNotes || doc.notes) && (
            <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '8px' }}>
              <Eyebrow style={{ color: GREY }}>Notes</Eyebrow>
              {doc.inspectionNotes && <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.55 }}>QC: {doc.inspectionNotes}</div>}
              {doc.notes && <div style={{ fontSize: '10px', color: GREY, marginTop: '3px', lineHeight: 1.55 }}>{doc.notes}</div>}
            </div>
          )}
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px', marginTop: '7px' }}>
            <Eyebrow style={{ color: GREY }}>Declaration</Eyebrow>
            <div style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.6 }}>
              {template.declaration ??
                `The goods above are the property of ${c.name}, received by ${company.name} for job work. They are held on the customer's behalf and carry no value in our books. Rejected material is kept apart and is not used; it is returned to the customer or used only with their agreement.`}
            </div>
          </div>
        </>
      }
      signatures={[
        { role: 'Received by (store)', who: doc.receivedBy?.name },
        { role: 'QC', who: doc.inspectedBy?.name },
        { role: 'Approved into stock', who: doc.postedBy?.name },
        { role: "Customer's driver", who: null },
      ]}
      footerNote={template.footerNote ?? 'Acknowledgement of customer material received. Not a tax invoice.'}
    />
  )
}
