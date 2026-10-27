'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ChevronDown, ChevronRight, Layers, Loader2, MapPin, Package, Search, Warehouse } from 'lucide-react'
import { api } from '@/lib/api'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { PickList } from './PickList'
import { packCount, qtyText } from './packageTypes'

interface Group {
  key: string
  itemId: string
  itemCode: string
  item: string
  category: string
  unit: string
  warehouseId: string
  store: string
  ownerCustomerId: string | null
  owner: string | null
  packages: number
  qty: number
  packTypes: string[]
  lots: string[]
  racks: string[]
  lastAt: string
}
interface Summary {
  packages: number
  items: number
  stores: number
  mismatches: number
}

const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

/**
 * What is on the racks, on stickers, without scanning anything: one line per
 * item in a store — ours or a customer's — with how many packets, how much is
 * in them, their racks and lots. Opened, it lists the packets oldest first,
 * the order they are issued in; any one opens like a scan.
 */
export function StickerStock({ onOpen }: { onOpen: (code: string) => void }) {
  const [q, setQ] = useState('')
  const [typed, setTyped] = useState('')
  const [store, setStore] = useState('')
  const [owner, setOwner] = useState('')
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  // The stores and owners to filter by, from the first, unfiltered read.
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([])
  const [owners, setOwners] = useState<Array<{ id: string; name: string }>>([])
  const [open, setOpen] = useState<string | null>(null)

  // Typing settles for a moment before the list is read again.
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300)
    return () => clearTimeout(t)
  }, [typed])

  useEffect(() => {
    let live = true
    const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(store ? { warehouseId: store } : {}), ...(owner ? { owner } : {}) })
    api
      .get<{ data: Group[]; summary: Summary }>(`/packages/groups?${qs}`)
      .then((r) => {
        if (!live) return
        setGroups(r.data)
        setSummary(r.summary)
        if (!q && !store && !owner) {
          setStores([...new Map(r.data.map((g) => [g.warehouseId, { id: g.warehouseId, name: g.store }])).values()].sort((a, b) => a.name.localeCompare(b.name)))
          setOwners(
            [...new Map(r.data.filter((g) => g.ownerCustomerId).map((g) => [g.ownerCustomerId!, { id: g.ownerCustomerId!, name: g.owner ?? 'Customer' }])).values()].sort((a, b) =>
              a.name.localeCompare(b.name),
            ),
          )
        }
      })
      .catch(() => live && setGroups([]))
    return () => {
      live = false
    }
  }, [q, store, owner])

  const totals = useMemo(() => {
    const list = groups ?? []
    return { packets: list.reduce((t, g) => t + g.packages, 0), items: new Set(list.map((g) => g.itemId)).size, noRack: list.filter((g) => !g.racks.length).length }
  }, [groups])
  const filtered = Boolean(q || store || owner)

  return (
    <div className="glass-card overflow-hidden p-0">
      {/* What is on stickers, at a glance. */}
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h3 className="text-foreground mr-auto flex items-center gap-2 text-sm font-semibold">
          <Layers size={16} className="text-primary" /> Stock on stickers
        </h3>
        {summary && (
          <>
            <span className="badge-neutral">
              <b>{summary.packages}</b>&nbsp;packets · {summary.items} items · {summary.stores} stores
            </span>
            {summary.mismatches > 0 && (
              <Link href="/inventory/packages" className="badge-warning inline-flex items-center gap-1" title="Packets whose stickers say more than the store holds">
                <AlertTriangle size={12} /> {summary.mismatches} don&apos;t match the stock
              </Link>
            )}
          </>
        )}
      </div>

      {/* Find by what is known: a word, a lot, a rack; a store; whose. */}
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <label className="relative min-w-[14rem] flex-1">
          <Search size={14} className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            id="sticker-stock-search"
            className="form-input h-9 w-full pl-8 text-sm"
            placeholder="Item, code, lot or rack"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Find stock on stickers"
          />
        </label>
        <SmartSelect id="sticker-stock-store" className="form-input h-9 w-44 text-sm" value={store} onChange={(e) => setStore(e.target.value)} aria-label="Store">
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SmartSelect>
        <SmartSelect id="sticker-stock-owner" className="form-input h-9 w-52 text-sm" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Whose stock">
          <option value="">Ours and customers'</option>
          <option value="OWNED">Our own stock</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}&apos;s material
            </option>
          ))}
        </SmartSelect>
      </div>

      {!groups ? (
        <div className="text-muted-foreground flex items-center gap-2 px-4 py-6 text-sm">
          <Loader2 size={15} className="animate-spin" /> Reading the racks…
        </div>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">{filtered ? 'Nothing on stickers matches that.' : 'Nothing is on stickers yet.'}</p>
      ) : (
        <>
          <p className="text-muted-foreground px-4 pt-2 text-[11px]">
            {totals.packets} packets of {totals.items} {totals.items === 1 ? 'item' : 'items'}
            {filtered ? ' match' : ''} · open a line to see its packets, oldest first
          </p>
          <ul className="divide-border divide-y">
            {groups.map((g) => {
              const isOpen = open === g.key
              return (
                <li key={g.key}>
                  <button
                    type="button"
                    className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-secondary/50 ${isOpen ? 'bg-secondary/50' : ''}`}
                    onClick={() => setOpen(isOpen ? null : g.key)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? <ChevronDown size={15} className="text-primary shrink-0" /> : <ChevronRight size={15} className="text-muted-foreground shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-semibold">{g.item}</span>
                      <span className="text-muted-foreground block text-[11px]">
                        <span className="font-mono">{g.itemCode}</span>
                        {g.category ? ` · ${g.category}` : ''}
                        {g.lots.length ? ` · lot ${g.lots.slice(0, 3).join(', ')}${g.lots.length > 3 ? ' …' : ''}` : ''}
                      </span>
                    </span>
                    <span className="text-muted-foreground flex items-center gap-1 text-xs">
                      <Warehouse size={12} /> {g.store}
                    </span>
                    {g.owner && <span className="badge-purple text-[10px]">{g.owner}&apos;s</span>}
                    <span className="text-muted-foreground flex w-28 items-center gap-1 text-xs">
                      <MapPin size={12} />
                      {g.racks.length ? `${g.racks.slice(0, 3).join(', ')}${g.racks.length > 3 ? ' …' : ''}` : 'no rack'}
                    </span>
                    <span className="text-foreground w-40 text-right text-xs tabular-nums">
                      <b className="text-sm">{qtyText(g.qty)}</b> {g.unit}
                      <span className="text-muted-foreground block text-[11px]">
                        {packCount(g.packages, g.packTypes[0] ?? 'OTHER')} · last in {day(g.lastAt)}
                      </span>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="bg-secondary/20 px-4 pb-3">
                      <PickList
                        bare
                        item={g.item}
                        itemId={g.itemId}
                        warehouseId={g.warehouseId}
                        store={g.store}
                        ownership={g.ownerCustomerId ? 'CUSTOMER_OWNED' : 'OWNED'}
                        ownerCustomerId={g.ownerCustomerId}
                        owner={g.owner}
                        unit={g.unit}
                        refreshKey={0}
                        action="Open"
                        onPick={onOpen}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      <p className="text-muted-foreground border-border flex items-center gap-1.5 border-t px-4 py-2 text-[11px]">
        <Package size={12} /> Every packet is listed with its rack. A newer one is never issued while an older one of the same item is on the rack, unless the store manager allows it.
      </p>
    </div>
  )
}
