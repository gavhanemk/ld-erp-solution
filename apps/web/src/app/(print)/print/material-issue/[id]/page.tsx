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
import { SubLine } from '@/components/print/doc'
import { itemShade, type ShadeFields } from '@/lib/items'

interface Person {
  name: string
}

interface Payload {
  /** The own brand the order is made under, carried from start to end. */
  brand?: { name: string; type: string } | null
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
      purchaseQty?: string | number | null
      item: ShadeFields & { code: string; name: string; uom: { symbol: string } }
      warehouse: { name: string }
      ownership?: 'OWNED' | 'CUSTOMER_OWNED'
      ownerCustomer?: { name: string } | null
    }>
  }
  handovers: Array<{
    transactionDate: string
    outQty: string
    item: ShadeFields & { code: string; name: string; uom: { symbol: string } }
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

/** A figure per unit — metres and pieces are never added together: "20 mtr · 12 pcs". */
function perUnit<T>(lines: T[], unitOf: (l: T) => string, figure: (l: T) => number): string {
  const sums = new Map<string, number>()
  for (const l of lines) sums.set(unitOf(l), (sums.get(unitOf(l)) ?? 0) + figure(l))
  return [...sums.entries()].map(([unit, n]) => `${qty(n)} ${unit}`.trim()).join(' · ') || '0'
}

/**
 * The slip a department signs for what the store handed it.
 *
 * Asked, given and still owed on every line, and each part handed over with its
 * date, because a requisition can be given in parts: this is the paper that
 * says which part arrived when, and whose signature is on it.
 *
 * Laid out like the purchase order (27 Nov 2026): the department it is issued
 * to in the "Issued to," block with the slip's facts beside it, the store it
 * comes out of in a band, then the lines and the totals.
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

  const owedOf = (l: Payload['mr']['lines'][number]) => Math.max(0, Number(l.requestedQty) - Number(l.issuedQty))

  const rows = mr.lines.map((l, i) => {
    // Being bought: still owed to the department, handed over from the store once it arrives.
    const buying =
      l.purchaseQty !== null && l.purchaseQty !== undefined
        ? Number(l.purchaseQty)
        : l.fulfilment === 'PURCHASE'
          ? Math.max(0, Number(l.requestedQty) - Number(l.issuedQty))
          : 0
    const toBuy = buying > 0
    const owed = owedOf(l)
    return {
      key: l.id,
      cells: {
        sn: i + 1,
        code: <span style={CODE}>{l.item.code}</span>,
        desc: (
          <>
            <div style={{ fontWeight: 600 }}>{l.item.name}</div>
            {/* A fabric's design and colour: the roll handed over is the one asked for. */}
            {itemShade(l.item) && <SubLine>{itemShade(l.item)}</SubLine>}
            {l.ownership === 'CUSTOMER_OWNED' && (
              <SubLine style={{ fontWeight: 700 }}>{l.ownerCustomer?.name ?? 'Customer'}&apos;s material — not ours</SubLine>
            )}
            {(l.purpose || toBuy) && (
              <SubLine>{[l.purpose, toBuy ? `${qty(buying)} being bought` : null].filter(Boolean).join(' · ')}</SubLine>
            )}
          </>
        ),
        store: l.warehouse.name,
        uom: l.item.uom.symbol,
        asked: qty(l.requestedQty),
        given: <strong>{qty(l.issuedQty)}</strong>,
        owed: owed > 0 ? qty(owed) : '—',
      },
    }
  })

  // The stores the lines come out of, each once.
  const stores = [...new Set(mr.lines.map((l) => l.warehouse.name))]

  // Asked, given and owed, a figure per unit.
  const unit = (l: Payload['mr']['lines'][number]) => l.item.uom.symbol
  const owedTotal = mr.lines.reduce((s, l) => s + owedOf(l), 0)
  const totals: TotalLine[] = [
    { label: 'Items', value: mr.lines.length },
    { label: 'Asked', value: perUnit(mr.lines, unit, (l) => Number(l.requestedQty)) },
    { label: 'Still owed', value: owedTotal > 0 ? perUnit(mr.lines, unit, owedOf) : '—' },
  ]

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
      party={{
        heading: 'Issued to,',
        name: mr.department.name,
        code: mr.department.code,
        lines: (
          <>
            <PartyLine label="Raised by" value={mr.raisedBy?.name ?? null} />
            <PartyLine
              label="Approved by"
              value={
                mr.approvedBy || mr.approvedAt
                  ? [mr.approvedBy?.name, shortDate(mr.approvedAt)].filter(Boolean).join(', ')
                  : null
              }
            />
            <PartyLine label="Stage" value={stage} />
          </>
        ),
        meta: [
          ['MR No', mr.mrNumber, true],
          ['MR Date', shortDate(mr.requestDate), true],
          ['Needed by', shortDate(mr.requiredDate), true],
          ['Against MO', mr.mo?.moNumber ?? null, true],
          ['Brand', data.brand?.name ?? null],
          ['Issued in full', shortDate(mr.issuedAt), true],
        ],
      }}
      bands={[
        {
          label: 'From store',
          body: (
            <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>
              {stores.length ? stores.join(' · ') : <Dash />}
            </div>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      after={
        <WordsAndTotals
          words={null}
          left={
            <>
              {/* Each part handed over, dated. A slip for a requisition given
                  in two goes has to say which metres went on which day. */}
              <Note title="Handed over">
                {handovers.length === 0
                  ? 'Nothing yet.'
                  : handovers.map((h, i) => (
                      <div key={i}>
                        {shortDate(h.transactionDate)} · {qty(h.outQty)} {h.item.uom.symbol} {h.item.name}
                        {itemShade(h.item) ? ` (${itemShade(h.item)})` : ''}
                      </div>
                    ))}
              </Note>
              <Note title="Note">{mr.notes || <Dash />}</Note>
            </>
          }
          totals={
            <TotalsBox
              rows={totals}
              totalLabel="Given"
              total={perUnit(mr.lines, unit, (l) => Number(l.issuedQty))}
            />
          }
        />
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
