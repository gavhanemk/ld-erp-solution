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
  money,
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
    lines: Array<{
      id: string
      qty: string
      unitRate: string | null
      item: ShadeFields & { code: string; name: string; hsnCode: string | null; uom: { symbol: string } }
    }>
  }
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

/** A figure per unit — metres and pieces are never added together: "20 mtr · 12 pcs". */
function perUnit<T>(lines: T[], unitOf: (l: T) => string, figure: (l: T) => number): string {
  const sums = new Map<string, number>()
  for (const l of lines) sums.set(unitOf(l), (sums.get(unitOf(l)) ?? 0) + figure(l))
  return [...sums.entries()].map(([unit, n]) => `${qty(n)} ${unit}`.trim()).join(' · ') || '0'
}

/**
 * The note that travels with goods from one of our stores to another.
 *
 * Quantity and the value the stock was carried at when it moved, which is on
 * the line so the note prints the same figure next year. Signed out by whoever
 * sent it, and in by whoever received it at the other end.
 *
 * Laid out like the purchase order (27 Nov 2026): the receiving store in the
 * "To," block with the note's facts beside it, the store it left in a band.
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
  const value = (l: Payload['transfer']['lines'][number]) =>
    l.unitRate === null ? null : Number(l.qty) * Number(l.unitRate)
  const total = transfer.lines.reduce((s, l) => s + (value(l) ?? 0), 0)

  const rows = transfer.lines.map((l, i) => ({
    key: l.id,
    cells: {
      sn: i + 1,
      code: <span style={CODE}>{l.item.code}</span>,
      desc: (
        <>
          <div style={{ fontWeight: 600 }}>{l.item.name}</div>
          {/* A fabric's design and colour: the receiving store knows which roll it is. */}
          {itemShade(l.item) && <SubLine>{itemShade(l.item)}</SubLine>}
        </>
      ),
      hsn: l.item.hsnCode ?? '—',
      uom: l.item.uom.symbol,
      qty: <strong>{qty(l.qty)}</strong>,
      rate: l.unitRate === null ? '—' : money(l.unitRate),
      value: value(l) === null ? '—' : money(value(l)!),
    },
  }))

  const totals: TotalLine[] = [
    { label: 'Lines', value: transfer.lines.length },
    { label: 'Quantity', value: perUnit(transfer.lines, (l) => l.item.uom.symbol, (l) => Number(l.qty)) },
  ]

  return (
    <StoreSheet
      company={company}
      title={template.title}
      number={transfer.transferNumber}
      dateLabel="Moved"
      date={longDate(transfer.transferDate) ?? ''}
      backHref="/inventory/documents"
      backLabel="Stock documents"
      banner={
        transfer.cancelledAt
          ? `CANCELLED on ${longDate(transfer.cancelledAt)}${transfer.cancelledBy ? ` by ${transfer.cancelledBy.name}` : ''}${transfer.cancelReason ? ` — ${transfer.cancelReason}` : ''}. The goods were walked back; nothing on this note moved.`
          : null
      }
      party={{
        name: transfer.toWarehouse.name,
        lines: <PartyLine label="Address-" value={transfer.toWarehouse.address} />,
        meta: [
          ['Note No', transfer.transferNumber, true],
          ['Date', shortDate(transfer.transferDate), true],
          ['Sent by', transfer.movedBy?.name ?? null],
        ],
      }}
      bands={[
        {
          label: 'From store',
          body: (
            <>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase' }}>{transfer.fromWarehouse.name}</div>
              {transfer.fromWarehouse.address && <div style={{ marginTop: '1px' }}>{transfer.fromWarehouse.address}</div>}
            </>
          ),
        },
      ]}
      columns={COLS}
      rows={rows}
      after={
        <WordsAndTotals
          words={null}
          left={<Note title="Note">{transfer.notes || <Dash />}</Note>}
          totals={<TotalsBox rows={totals} totalLabel="Value moved" total={`₹ ${money(total)}`} />}
        />
      }
      signatures={[
        { role: 'Sent by', who: transfer.movedBy?.name },
        { role: 'Carried by', who: null },
        { role: 'Received by', who: null },
      ]}
      footerNote={
        template.footerNote ?? 'Between our own stores. Not a sale, and not a tax invoice.'
      }
    />
  )
}
