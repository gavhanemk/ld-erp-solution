'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, Loader2, MapPin, PackageCheck, ScanLine } from 'lucide-react'
import { api } from '@/lib/api'
import { qtyText } from './packageTypes'

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
const ago = (days: number) => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`)
const SHOWN = 5

/**
 * The packets of one item in one store — ours, or the customer's for a
 * customer's material — as a plain table, in the order they are to be used:
 * "Use first" for the ones that came in earliest, "Later" for the rest. Each
 * says where it is, how much is left in it and when it came in. The button
 * on a packet issues it (in a requisition) or opens it (on the Scan page).
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
  /** What a packet's button says: "Issue this", or "View" on the Scan page. */
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
  // The packets, oldest first, that cover what is still owed: their buttons are green.
  let left = owed ?? 0
  const covers = new Set<string>()
  for (const p of list) {
    if (left <= 0.0005) break
    covers.add(p.id)
    left -= p.qty
  }

  return (
    <div className="border-border overflow-hidden rounded-lg border">
      {!bare && (
        <div className="bg-secondary/40 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-3 py-2">
          <span className="text-foreground text-sm font-semibold">{item}</span>
          <span className="text-muted-foreground text-xs">
            {store} · {whose}
            {owed != null ? ` · ${qtyText(owed)} ${unit} still to give` : ''}
          </span>
          {pick && list.length > 0 && (
            <span className="text-muted-foreground ml-auto text-xs">
              {list.length} {list.length === 1 ? 'packet' : 'packets'} · {qtyText(pick.inPackages)} {unit}
            </span>
          )}
        </div>
      )}

      {!pick ? (
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-3 text-xs">
          <Loader2 size={13} className="animate-spin" /> Finding its packets…
        </div>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground px-3 py-3 text-sm">
          No packets with a sticker in {store}.{' '}
          {pick.loose > 0 ? (
            <>
              There is {qtyText(pick.loose)} {unit} without a sticker: type the quantity in the table below to give it, or put stickers on it first in{' '}
              <Link href="/inventory/packages" className="text-primary font-medium hover:underline">
                Stickers → No stickers
              </Link>
              .
            </>
          ) : (
            'None of it is in this store.'
          )}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-muted-foreground border-b border-border text-left text-[11px] uppercase tracking-wide">
                  <th className="px-3 py-1.5 font-semibold">Use</th>
                  <th className="px-3 py-1.5 font-semibold">Packet no.</th>
                  <th className="px-3 py-1.5 font-semibold">Where</th>
                  <th className="px-3 py-1.5 font-semibold">Left in it</th>
                  <th className="px-3 py-1.5 font-semibold">Came in</th>
                  <th className="px-3 py-1.5 font-semibold">Note</th>
                  <th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {shown.map((p) => {
                  const share = p.initialQty > 0 ? Math.max(0, Math.min(1, p.qty / p.initialQty)) : 1
                  return (
                    <tr key={p.id} className={p.takeFirst ? 'bg-primary/5' : ''}>
                      <td className="px-3 py-2">
                        {p.takeFirst ? (
                          <span className="badge-success whitespace-nowrap text-[11px]">Use first</span>
                        ) : (
                          <span className="text-muted-foreground text-xs">Later</span>
                        )}
                      </td>
                      <td className="text-primary px-3 py-2 font-mono text-xs font-semibold">{p.code}</td>
                      <td className="px-3 py-2 text-xs">
                        {p.rack ? (
                          <span className="text-foreground inline-flex items-center gap-1 whitespace-nowrap">
                            <MapPin size={12} className="text-muted-foreground" /> Rack {p.rack}
                          </span>
                        ) : (
                          <span className="warn-text whitespace-nowrap" title="Not put on a rack yet">
                            No rack
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-foreground whitespace-nowrap text-xs tabular-nums">
                          {p.opened ? (
                            <>
                              <b className="text-sm">{qtyText(p.qty)}</b> of {qtyText(p.initialQty)} {unit}
                            </>
                          ) : (
                            <>
                              <b className="text-sm">{qtyText(p.qty)}</b> {unit} <span className="text-muted-foreground">full</span>
                            </>
                          )}
                        </div>
                        {/* How full it still is. */}
                        <div className="bg-secondary mt-1 h-1.5 w-24 overflow-hidden rounded-full">
                          <div className="bg-primary h-full rounded-full" style={{ width: `${Math.round(share * 100)}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span className="text-foreground whitespace-nowrap">
                          {day(p.receivedOn)} <span className="text-muted-foreground">({ago(p.days)})</span>
                        </span>
                        {p.sourceRef && <span className="text-muted-foreground block">{p.sourceRef}</span>}
                      </td>
                      <td className="text-muted-foreground max-w-[12rem] truncate px-3 py-2 text-xs" title={p.note ?? undefined}>
                        {p.note || (p.lotNo ? `Lot ${p.lotNo}` : '—')}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className={`${owed != null && covers.has(p.id) ? 'btn-primary' : 'btn-secondary'} h-8 whitespace-nowrap px-2.5 text-xs`}
                          onClick={() => onPick(p.code)}
                          title={owed != null ? `Give from ${p.code}, the same as scanning its sticker` : `See ${p.code}: what is left, where it is, and its history`}
                        >
                          <ScanLine size={13} /> {action}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {list.length > SHOWN && (
            <button type="button" className="text-primary flex w-full items-center justify-center gap-1 border-t border-border py-1.5 text-xs font-medium hover:underline" onClick={() => setAll((a) => !a)}>
              {all ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {all ? 'Show fewer' : `Show all ${list.length} packets`}
            </button>
          )}
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 border-t border-border px-3 py-1.5 text-[11px]">
            <PackageCheck size={12} className="text-primary" />
            <span>
              <b className="text-foreground">Use first</b> = came in earliest: use these before the others.
              {owed != null && covers.size > 0 && ` The green buttons are enough for the ${qtyText(owed)} ${unit} still to give.`}
              {pick.loose > 0 && ` ${qtyText(pick.loose)} ${unit} has no sticker.`}
              {pick.held.packages > 0 && ` ${pick.held.packages} on hold (rejected), not shown.`}
            </span>
          </p>
        </>
      )}
    </div>
  )
}
