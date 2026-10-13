'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Boxes, CheckCircle2, Printer, RefreshCw, ScanLine, Search, Tags, Warehouse, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { InwardStickers, type LabelTarget } from '@/components/packages/InwardStickers'
import { printLabels, qtyText } from '@/components/packages/packageTypes'
import { PackageGroups, type PackageGroup } from '@/components/packages/PackageGroups'

interface ToLabel {
  tracked: boolean
  grns: Array<{ id: string; grnNumber: string; grnDate: string; supplier: string }>
  lines: Array<{
    grnLineId: string
    grnId: string
    grnNumber: string
    grnDate: string
    supplier: string
    itemId: string
    itemCode: string
    item: string
    unit: string
    warehouseId: string
    store: string
    lotNo: string | null
    accepted: number
    toLabel: number
    packType: string
    perPack: number | null
  }>
  loose: Array<{
    itemId: string
    itemCode: string
    item: string
    unit: string
    warehouseId: string
    store: string
    ownership: 'OWNED' | 'CUSTOMER_OWNED'
    ownerCustomerId: string | null
    owner: string | null
    qty: number
    packType: string
    perPack: number | null
  }>
}

const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })

/**
 * Every labelled package, and what is still waiting for a sticker.
 *
 * Stock arrives on a GRN, gets stickers here, and from then on is issued and
 * moved by scanning. Stock that was on the racks before packages were
 * switched on shows under "To label" until somebody stickers it.
 */
function PackagesScreen() {
  const params = useSearchParams()
  const router = useRouter()
  const tab = params.get('tab') === 'label' ? 'label' : 'list'
  const grnFilter = params.get('grn') ?? ''
  // To label is two lists: what came in on GRNs, and what was already on the racks.
  const fromParam = params.get('from')

  const [groups, setGroups] = useState<PackageGroup[]>([])
  const [summary, setSummary] = useState({ packages: 0, items: 0, stores: 0, mismatches: 0 })
  const [todo, setTodo] = useState<ToLabel | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('IN_STOCK')
  const [store, setStore] = useState('')
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // The packages just labelled, so a closed print tab is one click from coming back.
  const [lastBatch, setLastBatch] = useState<string[]>([])
  const [labelling, setLabelling] = useState<LabelTarget | null>(null)
  // Finding one item among dozens waiting: searched and filtered here, without a reload.
  const [lq, setLq] = useState('')
  const [lstore, setLstore] = useState('')

  const go = (next: 'list' | 'label', from?: LabelFrom) =>
    router.replace(next === 'label' ? `/inventory/packages?tab=label${from ? `&from=${from}` : ''}` : '/inventory/packages', { scroll: false })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ status })
      if (q.trim()) qs.set('q', q.trim())
      if (store) qs.set('warehouseId', store)
      const [list, label] = await Promise.all([
        api.get<{ data: PackageGroup[]; summary: typeof summary }>(`/packages/groups?${qs}`),
        api.get<{ data: ToLabel }>(`/packages/to-label${grnFilter ? `?grnId=${grnFilter}` : ''}`),
      ])
      setGroups(list.data)
      setSummary(list.summary)
      setTodo(label.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the packages.')
    } finally {
      setLoading(false)
    }
  }, [q, status, store, grnFilter])

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, q])

  useEffect(() => {
    api
      .get<{ data: Array<{ id: string; name: string }> }>('/masters/warehouses?limit=100&active=true')
      .then((r) => setStores(r.data))
      .catch(() => {})
  }, [])

  const total = groups.reduce((s, g) => s + g.packages, 0)
  const waiting = (todo?.lines.filter((l) => l.toLabel > 0).length ?? 0) + (todo?.loose.length ?? 0)
  const creator = can('inventory', 'create')

  const needle = lq.trim().toLowerCase()
  const hit = (...v: Array<string | null | undefined>) => !needle || v.some((x) => (x ?? '').toLowerCase().includes(needle))
  const grnRows = (todo?.lines ?? []).filter((l) => l.toLabel > 0 && (!lstore || l.warehouseId === lstore) && hit(l.item, l.itemCode, l.store, l.grnNumber, l.supplier, l.lotNo))
  const rackRows = grnFilter ? [] : (todo?.loose ?? []).filter((l) => (!lstore || l.warehouseId === lstore) && hit(l.item, l.itemCode, l.store, l.owner))
  // Opens on whichever list has something in it, unless one was chosen.
  const from: LabelFrom = grnFilter ? 'grn' : fromParam === 'grn' || fromParam === 'racks' ? fromParam : grnRows.length || !rackRows.length ? 'grn' : 'racks'

  return (
    <div className="space-y-3">
      {/* Title, the figures and the two buttons on one line: the tiles took a
        third of the screen that the packages themselves need. */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="page-title mr-auto" title="Every labelled box, roll and carton, and stock still waiting for a sticker">
          Packages & Stickers
        </h1>
        <Figure icon={Boxes} value={summary.packages} label={`in stock · ${summary.items} ${summary.items === 1 ? 'item' : 'items'}`} />
        <Figure icon={Warehouse} value={summary.stores} label={summary.stores === 1 ? 'store' : 'stores'} />
        <Figure icon={Tags} value={waiting} label="waiting for stickers" tone={waiting ? 'warn' : undefined} onClick={() => go('label')} />
        <Figure
          icon={AlertTriangle}
          value={summary.mismatches}
          label="don't match the stock"
          tone={summary.mismatches ? 'bad' : undefined}
          title="Items issued without scanning: scan their packages and correct the quantity"
        />
        <button className="btn-ghost h-9" onClick={() => void load()} disabled={loading} title="Refresh">
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
        <Link href="/inventory/scan" className="btn-primary h-9">
          <ScanLine size={15} /> Scan
        </Link>
      </div>

      {message && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-600">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
          <p className="font-medium">{message}</p>
          {lastBatch.length > 0 && (
            <button className="btn-secondary ml-auto h-9 shrink-0" onClick={() => printLabels(lastBatch)}>
              <Printer size={15} /> Print {lastBatch.length === 1 ? 'this sticker' : `these ${lastBatch.length} stickers`} again
            </button>
          )}
          <button
            className={lastBatch.length ? 'shrink-0' : 'ml-auto'}
            onClick={() => {
              setMessage(null)
              setLastBatch([])
            }}
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* The tabs share the bar with the search, rather than taking a row of their own. */}
      <div className="glass-card overflow-hidden p-0">
        <div className="relative z-20 flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="inline-flex shrink-0 rounded-lg border border-border bg-secondary p-0.5" role="tablist">
            {(
              [
                ['list', `Packages (${total})`],
                ['label', `To label (${waiting})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => go(key)}
                className={`h-8 rounded-md px-3 text-sm font-semibold ${tab === key ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'list' && (
            <>
              <div className="flex h-9 min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
                <Search size={14} className="text-muted-foreground" />
                <input
                  className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  placeholder="Search code, item or lot…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Search packages"
                />
              </div>
              <SmartSelect className="form-input h-9 w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="IN_STOCK">In stock</option>
                <option value="EMPTY">Empty</option>
                <option value="SPLIT">Split</option>
                <option value="VOID">Withdrawn</option>
                <option value="ALL">All</option>
              </SmartSelect>
              <SmartSelect className="form-input h-9 w-44" value={store} onChange={(e) => setStore(e.target.value)}>
                <option value="">All stores</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SmartSelect>
            </>
          )}
          {tab === 'label' && (
            <>
              <div className="inline-flex shrink-0 rounded-lg border border-border p-0.5" role="tablist" aria-label="Which stock to label">
                {(
                  [
                    ['grn', `Received on GRNs (${grnRows.length})`],
                    ['racks', `On the racks (${rackRows.length})`],
                  ] as const
                )
                  .filter(([key]) => !(grnFilter && key === 'racks'))
                  .map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={from === key}
                      onClick={() => go('label', key)}
                      className={`h-8 rounded-md px-3 text-xs font-semibold ${from === key ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {label}
                    </button>
                  ))}
              </div>
              <div className="flex h-9 min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
                <Search size={14} className="text-muted-foreground" />
                <input
                  className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  placeholder={from === 'grn' ? 'Search item, code, GRN, supplier or lot…' : 'Search item, code or store…'}
                  value={lq}
                  onChange={(e) => setLq(e.target.value)}
                  aria-label="Search stock to label"
                />
                {lq && (
                  <button onClick={() => setLq('')} aria-label="Clear the search" className="text-muted-foreground hover:text-foreground">
                    <X size={14} />
                  </button>
                )}
              </div>
              <SmartSelect className="form-input h-9 w-44" value={lstore} onChange={(e) => setLstore(e.target.value)}>
                <option value="">All stores</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SmartSelect>
            </>
          )}
        </div>
        {tab === 'label' && (
          <ToLabelView
            todo={todo}
            from={from}
            grnRows={grnRows}
            rackRows={rackRows}
            searching={Boolean(needle || lstore)}
            loading={loading}
            grnFilter={grnFilter}
            creator={creator}
            onLabel={setLabelling}
            onClearGrn={() => go('label', 'grn')}
          />
        )}
        {tab === 'list' && (
          <PackageGroups
            groups={groups}
            filters={{ q, status }}
            emptyText={
              loading
                ? 'Loading…'
                : q || store || status !== 'IN_STOCK'
                  ? 'No package matches that.'
                  : 'No packages yet. Stock of the categories kept in packages shows under "To label" — make its stickers there.'
            }
          />
        )}
      </div>

      {labelling && (
        <InwardStickers
          targets={[labelling]}
          onClose={() => setLabelling(null)}
          onDone={(m, ids) => {
            setLastBatch(ids)
            setLabelling(null)
            setMessage(m)
            void load()
          }}
        />
      )}
    </div>
  )
}

/** One figure in the title line: an icon, the number, what it counts. */
function Figure({
  icon: Icon,
  value,
  label,
  tone,
  onClick,
  title,
}: {
  icon: typeof Boxes
  value: number
  label: string
  tone?: 'warn' | 'bad'
  onClick?: () => void
  title?: string
}) {
  const colour = tone === 'bad' ? 'text-red-500' : tone === 'warn' ? 'warn-text' : 'text-foreground'
  const body = (
    <>
      <Icon size={15} className={tone ? colour : 'text-primary'} />
      <span className={`font-bold tabular-nums ${colour}`}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </>
  )
  const cls = 'inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm'
  return onClick ? (
    <button type="button" className={`${cls} hover:border-primary/50`} onClick={onClick} title={title}>
      {body}
    </button>
  ) : (
    <span className={cls} title={title}>
      {body}
    </span>
  )
}

type LabelFrom = 'grn' | 'racks'
type GrnRow = ToLabel['lines'][number]
type RackRow = ToLabel['loose'][number]

/**
 * Stock waiting for stickers, one list at a time: what came in on a GRN, or
 * what was already on the racks. Searched and filtered from the bar above, so
 * one item among dozens is a few letters away rather than a long scroll.
 */
function ToLabelView({
  todo,
  from,
  grnRows,
  rackRows,
  searching,
  loading,
  grnFilter,
  creator,
  onLabel,
  onClearGrn,
}: {
  todo: ToLabel | null
  from: LabelFrom
  grnRows: GrnRow[]
  rackRows: RackRow[]
  searching: boolean
  loading: boolean
  grnFilter: string
  creator: boolean
  onLabel: (t: LabelTarget) => void
  onClearGrn: () => void
}) {
  if (!todo) return <p className="p-6 text-center text-sm text-muted-foreground">{loading ? 'Loading…' : ''}</p>
  if (!todo.tracked) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        No category is kept in packages yet. Open{' '}
        <Link href="/masters/item-categories" className="font-semibold text-primary hover:underline">
          Masters → Item Categories
        </Link>
        , edit a category such as Fabric or Trims, and tick <span className="font-semibold text-foreground">Track by package</span>.
      </div>
    )
  }

  if (from === 'grn') {
    return (
      <>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{grnFilter ? 'This GRN' : 'GRNs of the last 90 days'}: what came in and has no sticker yet.</span>
          {grnFilter && (
            <button className="btn-ghost h-8" onClick={onClearGrn}>
              <X size={14} /> Show all GRNs
            </button>
          )}
        </div>
        {grnRows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{searching ? 'Nothing received matches that.' : 'Everything received is labelled.'}</p>
        ) : (
          <ScrollableTable>
            <table className="data-table table-compact min-w-full">
              <thead>
                <tr className="bg-secondary">
                  <th>GRN</th>
                  <th>Item</th>
                  <th>Store</th>
                  <th>Lot</th>
                  <th style={{ textAlign: 'right' }}>Received</th>
                  <th style={{ textAlign: 'right' }}>To label</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grnRows.map((l) => (
                  <tr key={l.grnLineId}>
                    <td className="whitespace-nowrap">
                      <div className="font-mono text-sm font-semibold text-foreground">{l.grnNumber}</div>
                      <div className="text-xs text-muted-foreground">
                        {day(l.grnDate)} · {l.supplier}
                      </div>
                    </td>
                    <td>
                      <div className="font-medium text-foreground">{l.item}</div>
                      <div className="font-mono text-xs text-muted-foreground">{l.itemCode}</div>
                    </td>
                    <td className="whitespace-nowrap text-sm">{l.store}</td>
                    <td className="whitespace-nowrap text-sm">{l.lotNo ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="whitespace-nowrap text-right text-sm tabular-nums">
                      {qtyText(l.accepted)} {l.unit}
                    </td>
                    <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                      {qtyText(l.toLabel)} {l.unit}
                    </td>
                    <td className="text-right">
                      {creator && (
                        <button
                          className="btn-primary h-9"
                          onClick={() =>
                            onLabel({
                              itemId: l.itemId,
                              item: l.item,
                              itemCode: l.itemCode,
                              unit: l.unit,
                              warehouseId: l.warehouseId,
                              store: l.store,
                              ownership: 'OWNED',
                              ownerCustomerId: null,
                              grnLineId: l.grnLineId,
                              sourceRef: l.grnNumber,
                              lotNo: l.lotNo,
                              packType: l.packType,
                              perPack: l.perPack,
                              max: l.toLabel,
                            })
                          }
                        >
                          <Tags size={14} /> Make stickers
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        )}
      </>
    )
  }

  return (
    <>
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        Stock on the racks with no sticker: from before stickers were switched on, or left over.
      </div>
      {rackRows.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">{searching ? 'Nothing on the racks matches that.' : 'All the stock of these items is in labelled packages.'}</p>
      ) : (
        <ScrollableTable>
          <table className="data-table table-compact min-w-full">
            <thead>
              <tr className="bg-secondary">
                <th>Item</th>
                <th>Store</th>
                <th>Owner</th>
                <th style={{ textAlign: 'right' }}>Without a sticker</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rackRows.map((l) => (
                <tr key={`${l.itemId}-${l.warehouseId}-${l.ownerCustomerId ?? ''}`}>
                  <td>
                    <div className="font-medium text-foreground">{l.item}</div>
                    <div className="font-mono text-xs text-muted-foreground">{l.itemCode}</div>
                  </td>
                  <td className="whitespace-nowrap text-sm">{l.store}</td>
                  <td className="whitespace-nowrap text-sm">{l.owner ?? 'Ours'}</td>
                  <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                    {qtyText(l.qty)} {l.unit}
                  </td>
                  <td className="text-right">
                    {creator && (
                      <button
                        className="btn-secondary h-9"
                        onClick={() =>
                          onLabel({
                            itemId: l.itemId,
                            item: l.item,
                            itemCode: l.itemCode,
                            unit: l.unit,
                            warehouseId: l.warehouseId,
                            store: l.store,
                            ownership: l.ownership,
                            ownerCustomerId: l.ownerCustomerId,
                            owner: l.owner,
                            packType: l.packType,
                            perPack: l.perPack,
                            max: l.qty,
                          })
                        }
                      >
                        <Tags size={14} /> Make stickers
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableTable>
      )}
    </>
  )
}

export default function PackagesPage() {
  return (
    <Suspense fallback={null}>
      <PackagesScreen />
    </Suspense>
  )
}
