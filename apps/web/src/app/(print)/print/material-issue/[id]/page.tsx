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

interface Person {
  name: string
}

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  mr: {
    mrNumber: string
    status: 'PENDING' | 'APPROVED' | 'REJECTED'
    requestDate: string
    requiredDate: string | null
    approvedAt: string | null
    issuedAt: string | null
    closedAt: string | null
    closeReason: string | null
    rejectionReason: string | null
    notes: string | null
    department: { name: string; code: string }
    mo: { moNumber: string } | null
    raisedBy: Person | null
    approvedBy: Person | null
    issuedBy: Person | null
    closedBy: Person | null
    lines: Array<{
      id: string
      requestedQty: string
      issuedQty: string
      purpose: string | null
      fulfilment?: 'FROM_STOCK' | 'PURCHASE'
      item: { code: string; name: string; uom: { symbol: string } }
      warehouse: { name: string }
      ownership?: 'OWNED' | 'CUSTOMER_OWNED'
      ownerCustomer?: { name: string } | null
    }>
  }
  handovers: Array<{
    transactionDate: string
    outQty: string
    item: { code: string; name: string; uom: { symbol: string } }
    warehouse: { name: string }
  }>
}

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
  { key: 'code', head: 'Item Code', width: '13%' },
  { key: 'desc', head: 'Description', width: '32%' },
  { key: 'store', head: 'Store', width: '14%' },
  { key: 'uom', head: 'UOM', width: '6%', align: 'center' },
  { key: 'asked', head: 'Asked', width: '10%', align: 'right' },
  { key: 'given', head: 'Given', width: '10%', align: 'right' },
  { key: 'owed', head: 'Owed', width: '10%', align: 'right' },
]

/**
 * The slip a department signs for what the store handed it.
 *
 * Asked, given and still owed on every line, and each part handed over with its
 * date, because a requisition can be given in parts: this is the paper that
 * says which part arrived when, and whose signature is on it.
 */
export default function PrintMaterialIssue() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/inventory/requisitions/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that requisition.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the slip…</p>

  const { company, template, mr, handovers } = data
  const partly = mr.lines.some((l) => Number(l.issuedQty) > 0)

  const stage = mr.closedAt
    ? partly
      ? 'Closed — part issued'
      : 'Cancelled'
    : mr.status === 'REJECTED'
      ? 'Refused'
      : mr.status === 'PENDING'
        ? 'Waiting for approval'
        : mr.issuedAt
          ? 'Issued in full'
          : partly
            ? 'Part issued'
            : 'Approved — to hand over'

  const banner = mr.closedAt
    ? `${partly ? 'CLOSED' : 'CANCELLED'} on ${longDate(mr.closedAt)}${mr.closedBy ? ` by ${mr.closedBy.name}` : ''}${mr.closeReason ? ` — ${mr.closeReason}` : ''}. Nothing more is issued against it.`
    : mr.status === 'REJECTED'
      ? `REFUSED${mr.rejectionReason ? ` — ${mr.rejectionReason}` : ''}. Nothing is issued against it.`
      : mr.status === 'PENDING'
        ? 'NOT YET APPROVED. Nothing may be handed over against this slip until it is.'
        : null

  const rows = mr.lines.map((l, i) => {
    const toBuy = l.fulfilment === 'PURCHASE'
    const owed = Math.max(0, Number(l.requestedQty) - Number(l.issuedQty))
    return {
      key: l.id,
      cells: {
        sn: i + 1,
        code: <span style={CODE}>{l.item.code}</span>,
        desc: (
          <>
            <div style={{ fontWeight: 600 }}>{l.item.name}</div>
            {l.ownership === 'CUSTOMER_OWNED' && (
              <div style={{ fontSize: '8.5px', fontWeight: 700, color: NAVY, marginTop: '1px' }}>
                {l.ownerCustomer?.name ?? 'Customer'}&apos;s material — not ours
              </div>
            )}
            {(l.purpose || toBuy) && (
              <div style={{ fontSize: '8.5px', color: MUTED, marginTop: '1px' }}>
                {toBuy ? 'To be bought — not from the store' : l.purpose}
              </div>
            )}
          </>
        ),
        store: <span style={{ fontSize: '9px', color: GREY }}>{l.warehouse.name}</span>,
        uom: <span style={{ fontSize: '9px', color: GREY }}>{l.item.uom.symbol}</span>,
        asked: qty(l.requestedQty),
        given: <strong>{qty(l.issuedQty)}</strong>,
        owed: toBuy ? '—' : owed > 0 ? qty(owed) : '—',
      },
    }
  })

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={mr.mrNumber}
      dateLabel="Raised"
      date={longDate(mr.requestDate) ?? ''}
      backHref="/inventory/requisitions"
      backLabel="Requisitions"
      banner={banner}
      panels={[
        {
          title: 'Asked by',
          body: (
            <>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#173a6c', lineHeight: 1.3 }}>
                {mr.department.name}
              </div>
              <div style={{ marginTop: '4px' }}>
                <Fact label="Raised by" value={mr.raisedBy?.name ?? null} />
                <Fact label="Needed by" value={longDate(mr.requiredDate)} />
                <Fact label="Against" value={mr.mo?.moNumber ?? null} mono />
              </div>
            </>
          ),
        },
        {
          title: 'Decision',
          body: (
            <>
              <Fact label="Stage" value={stage} />
              <Fact label="Approved by" value={mr.approvedBy?.name ?? null} />
              <Fact label="Approved on" value={longDate(mr.approvedAt)} />
              <Fact label="Issued in full" value={longDate(mr.issuedAt)} />
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      minRows={6}
      after={
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px', marginTop: '8px' }}>
          {/* Each part handed over, dated. A slip for a requisition given
              in two goes has to say which metres went on which day. */}
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
            <Eyebrow style={{ color: GREY }}>Handed over</Eyebrow>
            {handovers.length === 0 ? (
              <div style={{ fontSize: '10px', color: MUTED, marginTop: '3px' }}>Nothing yet.</div>
            ) : (
              handovers.map((h, i) => (
                <div key={i} style={{ fontSize: '10px', color: INK, marginTop: '3px', lineHeight: 1.45 }}>
                  <span style={{ color: GREY }}>{longDate(h.transactionDate)} · </span>
                  {qty(h.outQty)} {h.item.uom.symbol} {h.item.name}
                </div>
              ))
            )}
          </div>
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
            <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
            <div style={{ fontSize: '10px', color: mr.notes ? GREY : MUTED, marginTop: '3px', lineHeight: 1.55 }}>
              {mr.notes ?? 'None.'}
            </div>
          </div>
        </div>
      }
      signatures={[
        { role: 'Raised by', who: mr.raisedBy?.name },
        { role: 'Approved by', who: mr.approvedBy?.name },
        { role: 'Issued by', who: mr.issuedBy?.name },
        { role: 'Received by', who: null },
      ]}
      footerNote={
        template.footerNote ??
        'Material leaves stock on the date it is handed over. An internal store record, not a sale.'
      }
    />
  )
}
