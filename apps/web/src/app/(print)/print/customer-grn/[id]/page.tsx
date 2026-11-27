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
      item: { code: string; name: string; uom: { symbol: string } | null } & ShadeFields
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

/** A figure per unit — metres and pieces are never added together: "20 mtr · 12 pcs". */
function perUnit<T>(lines: T[], unitOf: (l: T) => string, figure: (l: T) => number): string {
  const sums = new Map<string, number>()
  for (const l of lines) sums.set(unitOf(l), (sums.get(unitOf(l)) ?? 0) + figure(l))
  return [...sums.entries()].map(([unit, n]) => `${qty(n)} ${unit}`.trim()).join(' · ') || '0'
}

/** "ZZ-CH-12, 27/11/2026": a reference and its date. */
const refOn = (no: string | null, date: string | null) => (no ? `${no}${date ? `, ${shortDate(date)}` : ''}` : null)

/**
 * A customer's material, acknowledged.
 *
 * Their challan beside what we counted: what arrived, what was short or more,
 * what was accepted and what was rejected and is held — with why — and the
 * sticker numbers on the rolls, so the customer, the driver and the store all
 * hold the same paper. It is their property, received for job work: no value,
 * no tax.
 *
 * Laid out like the purchase order (27 Nov 2026): the customer the material
 * came from in the "Received from," block with the receipt's facts beside it,
 * the store it went into in a band.
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
            {itemShade(l.item) && <SubLine>{itemShade(l.item)}</SubLine>}
            {(l.batchNumber || l.markings) && (
              <SubLine>{[l.batchNumber && `Lot ${l.batchNumber}`, l.markings].filter(Boolean).join(' · ')}</SubLine>
            )}
            {codes.length > 0 && (
              <SubLine>Stickers: {codes.map((p) => `${p.code}${p.grade === 'R' ? ' (held)' : ''}`).join(', ')}</SubLine>
            )}
          </>
        ),
        uom: l.item.uom?.symbol ?? '',
        challan: qty(l.challanQty),
        received: <strong>{qty(l.receivedQty)}</strong>,
        diff: diff === 0 ? '—' : `${diff > 0 ? '+' : '−'}${qty(Math.abs(diff))}`,
        accepted: <strong>{qty(received - rejected)}</strong>,
        rejected:
          rejected > 0 ? (
            <>
              <strong>{qty(rejected)}</strong>
              {l.rejectReason && <SubLine>{l.rejectReason}</SubLine>}
              {Number(l.releasedQty) > 0 && <SubLine>{qty(l.releasedQty)} released for use</SubLine>}
            </>
          ) : (
            '—'
          ),
      },
    }
  })

  const banner =
    doc.status === 'CANCELLED'
      ? `CANCELLED${doc.cancelledAt ? ` on ${longDate(doc.cancelledAt)}` : ''}${doc.cancelledBy ? ` by ${doc.cancelledBy.name}` : ''}${doc.cancelReason ? ` — ${doc.cancelReason}` : ''}. This receipt is not on the books.`
      : doc.status !== 'POSTED'
        ? `${doc.statusLabel.toUpperCase()}: not yet approved. Nothing on this receipt is on the books until it is.`
        : null

  // Their challan, what came, what was accepted and what is held — a figure per unit.
  const unit = (l: Payload['doc']['lines'][number]) => l.item.uom?.symbol ?? ''
  const rejectedTotal = doc.lines.reduce((s, l) => s + Number(l.rejectedQty), 0)
  const totals: TotalLine[] = [
    { label: 'Items', value: doc.lines.length },
    { label: 'Their challan', value: perUnit(doc.lines, unit, (l) => Number(l.challanQty)) },
    { label: 'Received', value: perUnit(doc.lines, unit, (l) => Number(l.receivedQty)) },
    {
      label: 'Rejected (held)',
      value: rejectedTotal > 0 ? perUnit(doc.lines, unit, (l) => Number(l.rejectedQty)) : '—',
    },
  ]
  const accepted = perUnit(doc.lines, unit, (l) => Number(l.receivedQty) - Number(l.rejectedQty))

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
      party={{
        heading: 'Received from, the customer (owner of the goods)',
        name: c.name,
        code: c.code,
        lines: (
          <>
            <PartyLine label="Address-" value={address || null} />
            <PartyLine label="GST No" value={c.gstin ?? 'Unregistered'} mono={Boolean(c.gstin)} />
            <PartyLine label="Contact No" value={c.phone} mono />
            <PartyLine label="For order" value={doc.so?.soNumber ?? 'Not against an order'} />
          </>
        ),
        meta: [
          ['Receipt No', doc.grnNumber, true],
          ['Receipt Date', shortDate(doc.receiptDate), true],
          ['Their challan', refOn(doc.challanNumber, doc.challanDate), true],
          ['Their bill', refOn(doc.billNumber, doc.billDate), true],
          ['Gate entry', refOn(doc.gateEntryNumber, doc.gateEntryDate), true],
          ['Vehicle No', doc.vehicleNo, true],
          ['Transporter', doc.transporter],
          !!doc.correctionOf && ['Corrects', doc.correctionOf.grnNumber, true],
        ],
      }}
      bands={[
        {
          icon: 'truck',
          label: 'Into store',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{doc.warehouse.name}</div>
              {doc.warehouse.address && <div style={{ marginTop: '1px' }}>{doc.warehouse.address}</div>}
              <div style={{ marginTop: '1px' }}>
                <strong>Status</strong> {doc.statusLabel}
                <span style={{ marginLeft: '14px' }}>
                  <strong>QC</strong>{' '}
                  {doc.inspectedAt ? `${shortDate(doc.inspectedAt)}${doc.inspectedBy ? `, ${doc.inspectedBy.name}` : ''}` : '—'}
                </span>
                <span style={{ marginLeft: '14px' }}>
                  <strong>Approved</strong>{' '}
                  {doc.postedAt ? `${shortDate(doc.postedAt)}${doc.postedBy ? `, ${doc.postedBy.name}` : ''}` : '—'}
                </span>
              </div>
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
            left={
              <Note title="Notes">
                {doc.inspectionNotes || doc.notes ? (
                  <>
                    {doc.inspectionNotes && <div>QC: {doc.inspectionNotes}</div>}
                    {doc.notes && <div>{doc.notes}</div>}
                  </>
                ) : (
                  <Dash />
                )}
              </Note>
            }
            totals={<TotalsBox rows={totals} totalLabel="Accepted" total={accepted} />}
          />
          <Box title="Declaration" style={{ marginTop: '7px' }}>
            {template.declaration ??
              `The goods above are the property of ${c.name}, received by ${company.name} for job work. They are held on the customer's behalf and carry no value in our books. Rejected material is kept apart and is not used; it is returned to the customer or used only with their agreement.`}
          </Box>
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
