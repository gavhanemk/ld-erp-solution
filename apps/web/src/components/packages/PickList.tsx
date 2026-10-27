'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, Loader2, MapPin, PackageCheck, ScanLine } from 'lucide-react'
import { api } from '@/lib/api'
import { packCount, qtyText } from './packageTypes'

interface PickPackage {
  id: string
  code: string
  qty: number
  initialQty: number
  packType: string
  rack: string | null
  lotNo: string | null
  sourceRef: string | null
  receivedOn: string
  days: number
  note: string | null
  opened: boolean
  takeFirst: boolean
}
interface Pick {
  packages: PickPackage[]
  inPackages: number
  held: { packages: number; qty: number }
  loose: number
  inStore: number
}

const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
const SHOWN = 5

/**
 * Which packets to take for one requisition line: the item's packages in its
 * store — ours, or the customer's for a customer's material — in the order
 * first-in-first-out takes them, each with its rack, lot, age and what is in
 * it. "Issue this" loads one into the scan panel as if its sticker had been
 * scanned; with a scanner, the sticker is scanned instead.
 */
export function PickList({
  item,
  itemId,
  warehouseId,
  store,
  ownership,
  ownerCustomerId,
  owner,
  unit,
  owed,
  refreshKey,
  onPick,
  action = 'Issue this',
  bare = false,
}: {
  item: string
  itemId: string
  warehouseId: string
  store: string
  ownership?: 'OWNED' | 'CUSTOMER_OWNED'
  ownerCustomerId?: string | null
  owner?: string | null
  unit: string
  /** Still to issue on the line. Left out on the Scan page, where packets are only opened. */
  owed?: number
  /** Bumped after an issue, to read the packets again. */
  refreshKey: number
  onPick: (code: string) => void
  /** What a packet's button says: "Issue this", or "Open" on the Scan page. */
  action?: string
  /** Without the item's own header: the Scan page's list already names it. */
  bare?: boolean
}) {
  const [pick, setPick] = useState<Pick | null>(null)
  const [all, setAll] = useState(false)

  useEffect(() => {
    let live = true
    const qs = new URLSearchParams({ itemId, warehouseId, ownership: ownership ?? 'OWNED', ...(ownerCustomerId ? { ownerCustomerId } : {}) })
    api
      .get<{ data: Pick }>(`/packages/pick?${qs}`)
      .then((r) => live && setPick(r.data))
      .catch(() => live && setPick(null))
    return () => {
      live = false
    }
  }, [itemId, warehouseId, ownership, ownerCustomerId, refreshKey])

  const whose = ownership === 'CUSTOMER_OWNED' ? `${owner ?? 'the customer'}'s material` : 'our stock'
  const list = pick?.packages ?? []
  const shown = all ? list : list.slice(0, SHOWN)
  // How many packets of the oldest cover what is still owed, as the store would pick them.
  let left = owed ?? 0
  const covers = new Set<string>()
  for (const p of list) {
    if (left <= 0.0005) break
    covers.add(p.id)
    left -= p.qty
  }

  return (
    <div className="border-border rounded-lg border">
      <div className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-3 py-2 ${bare ? '' : 'bg-secondary/40'}`}>
        {!bare && <span className="text-foreground text-sm font-semibold">{item}</span>}
        {!bare && (
          <span className="text-muted-foreground text-xs">
            {store} · {whose}
            {owed != null ? ` · ${qtyText(owed)} ${unit} still to issue` : ''}
          </span>
        )}
        {pick && (
          <span className="text-muted-foreground ml-auto text-xs">
            <b className="text-foreground">{list.length}</b> {list.length === 1 ? 'packet' : 'packets'} · {qtyText(pick.inPackages)} {unit} on stickers
            {pick.loose > 0 && ` · ${qtyText(pick.loose)} ${unit} without a sticker`}
            {pick.held.packages > 0 && ` · ${pick.held.packages} on hold`}
          </span>
        )}
      </div>

      {!pick ? (
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-3 text-xs">
          <Loader2 size={13} className="animate-spin" /> Finding its packets…
        </div>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground px-3 py-3 text-xs">
          No stickered packets of this in {store}.{' '}
          {pick.loose > 0 ? (
            <>
              {qtyText(pick.loose)} {unit} is there without a sticker: type the quantity in the table below to issue it, or label it first in{' '}
              <Link href="/inventory/packages" className="text-primary font-medium hover:underline">
                Stickers → No stickers
              </Link>
              .
            </>
          ) : (
            'Nothing of it is in this store.'
          )}
        </p>
      ) : (
        <>
          <ul className="divide-border divide-y">
            {shown.map((p) => (
              <li key={p.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm ${p.takeFirst ? 'bg-primary/5' : ''}`}>
                <span className="w-24 shrink-0">
                  {p.takeFirst ? (
                    <span className="badge-success text-[10px]">Take first</span>
                  ) : (
                    <span className="text-muted-foreground text-[11px]">Newer</span>
                  )}
                </span>
                <span className="text-primary w-20 shrink-0 font-mono text-xs font-semibold">{p.code}</span>
                <span className="text-foreground flex w-20 shrink-0 items-center gap-1 text-xs">
                  <MapPin size={12} className="text-muted-foreground" />
                  {p.rack ? `Rack ${p.rack}` : <span className="text-muted-foreground">no rack</span>}
                </span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                  {packCount(1, p.packType).replace(/^1 /, '')}
                  {p.lotNo ? ` · lot ${p.lotNo}` : ''} · came {day(p.receivedOn)}
                  {p.days > 0 ? ` (${p.days} ${p.days === 1 ? 'day' : 'days'})` : ' (today)'}
                  {p.sourceRef ? ` · ${p.sourceRef}` : ''}
                  {p.note ? ` · ${p.note}` : ''}
                </span>
                <span className="text-foreground w-28 shrink-0 text-right text-xs tabular-nums">
                  <b className="text-sm">{qtyText(p.qty)}</b> {unit}
                  {p.opened && <span className="text-muted-foreground block text-[10px]">opened · of {qtyText(p.initialQty)}</span>}
                </span>
                <button
                  type="button"
                  className={`${covers.has(p.id) ? 'btn-primary' : 'btn-secondary'} h-8 shrink-0 px-2.5 text-xs`}
                  onClick={() => onPick(p.code)}
                  title={owed != null ? `Issue from ${p.code}, as if its sticker had been scanned` : `Open ${p.code}`}
                >
                  <ScanLine size={13} /> {action}
                </button>
              </li>
            ))}
          </ul>
          {list.length > SHOWN && (
            <button type="button" className="text-primary flex w-full items-center justify-center gap-1 border-t border-border py-1.5 text-xs font-medium hover:underline" onClick={() => setAll((a) => !a)}>
              {all ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {all ? 'Show fewer' : `Show all ${list.length} packets`}
            </button>
          )}
          {covers.size > 0 && (
            <p className="text-muted-foreground flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-[11px]">
              <PackageCheck size={12} className="text-primary" />
              {covers.size === 1 ? 'The packet marked in green covers' : `The ${covers.size} packets marked in green cover`} what is still to issue, oldest first.
            </p>
          )}
        </>
      )}
    </div>
  )
}
