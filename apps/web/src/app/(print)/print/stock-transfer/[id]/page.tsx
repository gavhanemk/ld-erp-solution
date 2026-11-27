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

interface Store {
  name: string
  address: string | null
}

interface Payload {
  company: Record<string, string | null>
  template: { title: string; footerNote: string | null }
  transfer: {
    transferNumber: string
    transferDate: string
    notes: string | null
    cancelledAt: string | null
    cancelReason: string | null
    fromWarehouse: Store
    toWarehouse: Store
    movedBy: { name: string } | null
    cancelledBy: { name: string } | null
    /** DIRECT, or IN_TRANSIT: on the road through a transit store until received. */
    mode?: 'DIRECT' | 'IN_TRANSIT'
    status?: 'DISPATCHED' | 'PARTLY_RECEIVED' | 'RECEIVED' | 'DISCREPANCY' | 'CANCELLED'
    transitWarehouse?: { name: string } | null
    receipts?: Array<{
      id: string
      kind: 'RECEIVED' | 'RETURNED' | 'WRITTEN_OFF'
      receivedAt: string
      notes: string | null
      by: { name: string } | null
      lines: Array<{ transferLineId: string; qty: string; damagedQty: string }>
    }>
    lines: Array<{
      id: string
      qty: string
      unitRate: string | null
      receivedQty?: string
      damagedQty?: string
      returnedQty?: string
      lostQty?: string
      item: { code: string; name: string; hsnCode: string | null; uom: { symbol: string } }
    }>
  }
}

const STATUS_WORDS: Record<string, string> = {
  DISPATCHED: 'On the way',
  PARTLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received in full',
  DISCREPANCY: 'Closed with differences',
  CANCELLED: 'Cancelled',
}

const COLS: SheetColumn[] = [
  { key: 'sn', head: 'S.N', width: '5%', align: 'center' },
  { key: 'code', head: 'Item Code', width: '14%' },
  { key: 'desc', head: 'Description', width: '35%' },
  { key: 'hsn', head: 'HSN', width: '9%', align: 'center' },
  { key: 'uom', head: 'UOM', width: '6%', align: 'center' },
  { key: 'qty', head: 'Quantity', width: '10%', align: 'right' },
  { key: 'rate', head: 'Rate', width: '9%', align: 'right' },
  { key: 'value', head: 'Value (₹)', width: '12%', align: 'right' },
]

function StoreBox({ store }: { store: Store }) {
  return (
    <>
      <div style={{ fontSize: '12px', fontWeight: 700, color: NAVY, lineHeight: 1.3 }}>{store.name}</div>
      {store.address && (
        <div style={{ fontSize: '10px', color: GREY, lineHeight: 1.55, marginTop: '3px' }}>{store.address}</div>
      )}
    </>
  )
}

/**
 * The note that travels with goods from one of our stores to another.
 *
 * Quantity and the value the stock was carried at when it moved, which is on
 * the line so the note prints the same figure next year. Signed out by whoever
 * sent it, and in by whoever received it at the other end.
 */
export default function PrintStockTransfer() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Payload }>(`/inventory/transfers/${id}/print`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not open that transfer.'))
  }, [id])

  if (error) return <p style={{ padding: 48, color: INK }}>{error}</p>
  if (!data) return <p style={{ padding: 48, color: MUTED }}>Opening the transfer note…</p>

  const { company, template, transfer } = data
  const onTheRoad = transfer.mode === 'IN_TRANSIT'
  const lineOf = new Map(transfer.lines.map((l) => [l.id, l]))
  // What became of goods on the road, step by step, in words.
  const steps = (transfer.receipts ?? []).map((r) => {
    const said = r.lines
      .map((rl) => {
        const l = lineOf.get(rl.transferLineId)
        const unit = l?.item.uom.symbol ?? ''
        const parts = [Number(rl.qty) > 0 ? `${qty(rl.qty)} ${unit}` : null, Number(rl.damagedQty) > 0 ? `${qty(rl.damagedQty)} ${unit} damaged` : null].filter(Boolean)
        return `${l?.item.name ?? 'Item'} ${parts.join(', ')}`
      })
      .join('; ')
    const verb = r.kind === 'RECEIVED' ? `Received at ${transfer.toWarehouse.name}` : r.kind === 'RETURNED' ? `Sent back to ${transfer.fromWarehouse.name}` : 'Written off as lost'
    return { key: r.id, text: `${longDate(r.receivedAt)} · ${verb}${r.by ? ` by ${r.by.name}` : ''}: ${said}${r.notes ? ` — ${r.notes}` : ''}` }
  })
  const lastReceiver = [...(transfer.receipts ?? [])].reverse().find((r) => r.kind === 'RECEIVED')?.by?.name ?? null
  const value = (l: Payload['transfer']['lines'][number]) =>
    l.unitRate === null ? null : Number(l.qty) * Number(l.unitRate)
  const total = transfer.lines.reduce((s, l) => s + (value(l) ?? 0), 0)

  const rows = transfer.lines.map((l, i) => ({
    key: l.id,
    cells: {
      sn: i + 1,
      code: <span style={CODE}>{l.item.code}</span>,
      desc: <div style={{ fontWeight: 600 }}>{l.item.name}</div>,
      hsn: <span style={{ fontSize: '9px', color: GREY }}>{l.item.hsnCode ?? '—'}</span>,
      uom: <span style={{ fontSize: '9px', color: GREY }}>{l.item.uom.symbol}</span>,
      qty: <strong>{qty(l.qty)}</strong>,
      rate: l.unitRate === null ? '—' : money(l.unitRate),
      value: value(l) === null ? '—' : money(value(l)!),
    },
  }))

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={transfer.transferNumber}
      dateLabel={onTheRoad ? 'Sent' : 'Moved'}
      date={longDate(transfer.transferDate) ?? ''}
      backHref="/inventory/documents"
      backLabel="Stock documents"
      banner={
        transfer.cancelledAt
          ? `CANCELLED on ${longDate(transfer.cancelledAt)}${transfer.cancelledBy ? ` by ${transfer.cancelledBy.name}` : ''}${transfer.cancelReason ? ` — ${transfer.cancelReason}` : ''}. The goods were walked back; nothing on this note moved.`
          : null
      }
      panels={[
        { title: 'From', body: <StoreBox store={transfer.fromWarehouse} /> },
        { title: 'To', body: <StoreBox store={transfer.toWarehouse} /> },
        {
          title: 'The movement',
          body: (
            <>
              <Fact label="Note No" value={transfer.transferNumber} mono />
              <Fact label="Date" value={longDate(transfer.transferDate)} />
              <Fact label="Sent by" value={transfer.movedBy?.name ?? null} />
              <Fact label="Lines" value={String(transfer.lines.length)} />
              {onTheRoad && <Fact label="Goes" value={`In transit, through ${transfer.transitWarehouse?.name ?? 'transit'}`} />}
              {onTheRoad && transfer.status && <Fact label="Status" value={STATUS_WORDS[transfer.status] ?? transfer.status} />}
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      minRows={6}
      after={
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 250px', gap: '7px', marginTop: '8px' }}>
          <div style={{ border: `1px solid ${RULE}`, padding: '7px 10px' }}>
            <Eyebrow style={{ color: GREY }}>Note</Eyebrow>
            <div style={{ fontSize: '10px', color: transfer.notes ? GREY : MUTED, marginTop: '3px', lineHeight: 1.55 }}>
              {transfer.notes ?? 'None.'}
            </div>
            {onTheRoad && (
              <>
                <Eyebrow style={{ color: GREY, marginTop: '6px' }}>On arrival</Eyebrow>
                <div style={{ fontSize: '10px', color: steps.length ? GREY : MUTED, marginTop: '3px', lineHeight: 1.55 }}>
                  {steps.length ? steps.map((x) => <div key={x.key}>{x.text}</div>) : 'Nothing received yet.'}
                </div>
              </>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '7px 11px',
              background: NAVY,
              color: '#fff',
            }}
          >
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>
              Value moved
            </span>
            <span style={{ fontSize: '13px', fontWeight: 700, ...NUM }}>₹{money(total)}</span>
          </div>
        </div>
      }
      signatures={[
        { role: 'Sent by', who: transfer.movedBy?.name },
        { role: 'Carried by', who: null },
        { role: 'Received by', who: lastReceiver },
      ]}
      footerNote={
        template.footerNote ?? 'Between our own stores. Not a sale, and not a tax invoice.'
      }
    />
  )
}
