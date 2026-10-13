'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Boxes, CheckCircle2, Printer, RefreshCw, ScanLine, Search, Tags, Warehouse, X } from 'lucide-react'
import { api, ApiError, can } from '@/lib/api'
import { KpiTile, TONE } from '@/components/dashboard/DashKit'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { LabelDialog, type LabelTarget } from '@/components/packages/LabelDialog'
import { STATUS, packLabel, printLabels, qtyText } from '@/components/packages/packageTypes'

interface Row {
  id: string
  code: string
  status: string
  packType: string
  qty: number
  initialQty: number
  unit: string
  lotNo: string | null
  sourceType: string
  createdAt: string
  item: { code: string; name: string; category: { name: string } | null }
  warehouse: { id: string; name: string }
  ownerCustomer: { name: string } | null
}

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

  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState({ packages: 0, items: 0, stores: 0, mismatches: 0 })
  const [total, setTotal] = useState(0)
  const [todo, setTodo] = useState<ToLabel | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('IN_STOCK')
  const [store, setStore] = useState('')
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // The packages just labelled, so a closed print tab is one click from coming back.
  const [lastBatch, setLastBatch] = useState<string[]>([])
  const [labelling, setLabelling] = useState<LabelTarget | null>(null)

  const go = (next: 'list' | 'label') => router.replace(next === 'label' ? '/inventory/packages?tab=label' : '/inventory/packages', { scroll: false })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ status, limit: '200' })
      if (q.trim()) qs.set('q', q.trim())
      if (store) qs.set('warehouseId', store)
      const [list, label] = await Promise.all([
        api.get<{ data: Row[]; summary: typeof summary; pagination: { total: number } }>(`/packages?${qs}`),
        api.get<{ data: ToLabel }>(`/packages/to-label${grnFilter ? `?grnId=${grnFilter}` : ''}`),
      ])
      setRows(list.data)
      setSummary(list.summary)
      setTotal(list.pagination.total)
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

  const waiting = (todo?.lines.filter((l) => l.toLabel > 0).length ?? 0) + (todo?.loose.length ?? 0)
  const creator = can('inventory', 'create')

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Packages & Stickers</h1>
          <p className="page-subtitle">Every labelled box, roll and carton, and stock still waiting for a sticker</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} title="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <Link href="/inventory/scan" className="btn-primary">
            <ScanLine size={15} /> Scan
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile icon={Boxes} label="Packages in stock" value={summary.packages} sub={`of ${summary.items} ${summary.items === 1 ? 'item' : 'items'}`} />
        <KpiTile icon={Warehouse} tone={TONE.blue} label="Stores" value={summary.stores} sub="holding labelled stock" />
        <KpiTile icon={Tags} tone={TONE.amber} label="Waiting for stickers" value={waiting} sub="GRN lines and loose stock" onClick={() => go('label')} active={tab === 'label'} />
        <KpiTile
          icon={AlertTriangle}
          tone={TONE.rose}
          label="Don't match the stock"
          value={summary.mismatches}
          valueClass={summary.mismatches ? 'text-red-500' : 'text-foreground'}
          sub="items issued without scanning"
        />
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

      <div className="flex gap-1 border-b border-border">
        {(
          [
            ['list', `Packages (${total})`],
            ['label', `To label (${waiting})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => go(key)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold ${tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'list' ? (
        <div className="glass-card overflow-hidden p-0">
          <div className="relative z-20 flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <div className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border bg-secondary px-3">
              <Search size={14} className="text-muted-foreground" />
              <input
                className="flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="Search code, item or lot…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search packages"
              />
            </div>
            <SmartSelect className="form-input h-10 w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="IN_STOCK">In stock</option>
              <option value="EMPTY">Empty</option>
              <option value="SPLIT">Split</option>
              <option value="VOID">Withdrawn</option>
              <option value="ALL">All</option>
            </SmartSelect>
            <SmartSelect className="form-input h-10 w-48" value={store} onChange={(e) => setStore(e.target.value)}>
              <option value="">All stores</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SmartSelect>
            {picked.size > 0 && (
              <button className="btn-primary h-10" onClick={() => printLabels([...picked])}>
                <Printer size={15} /> Print {picked.size} {picked.size === 1 ? 'label' : 'labels'}
              </button>
            )}
          </div>
          {rows.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground">
              {loading
                ? 'Loading…'
                : q || store || status !== 'IN_STOCK'
                  ? 'No package matches that.'
                  : 'No packages yet. Stock of the categories kept in packages shows under "To label" — make its stickers there.'}
            </div>
          ) : (
            <ScrollableTable>
              <table className="data-table table-compact min-w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th className="w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={picked.size === rows.length}
                        onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                      />
                    </th>
                    <th>Code</th>
                    <th>Item</th>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>In it</th>
                    <th style={{ textAlign: 'right' }}>Labelled with</th>
                    <th>Lot</th>
                    <th>Store</th>
                    <th>Labelled on</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const st = STATUS[r.status] ?? { label: r.status, cls: 'badge-neutral' }
                    return (
                      <tr key={r.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.code}`}
                            checked={picked.has(r.id)}
                            onChange={(e) =>
                              setPicked((p) => {
                                const n = new Set(p)
                                if (e.target.checked) n.add(r.id)
                                else n.delete(r.id)
                                return n
                              })
                            }
                          />
                        </td>
                        <td className="whitespace-nowrap">
                          <Link href={`/inventory/scan?code=${r.code}`} className="font-mono text-sm font-semibold text-primary hover:underline">
                            {r.code}
                          </Link>
                        </td>
                        <td>
                          <div className="font-medium text-foreground">{r.item.name}</div>
                          <div className="text-xs text-muted-foreground">
                            <span className="font-mono">{r.item.code}</span>
                            {r.ownerCustomer ? ` · ${r.ownerCustomer.name}'s` : ''}
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-sm">{packLabel(r.packType)}</td>
                        <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                          {qtyText(r.qty)} <span className="text-xs font-normal text-muted-foreground">{r.unit}</span>
                        </td>
                        <td className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">{qtyText(r.initialQty)}</td>
                        <td className="whitespace-nowrap text-sm">{r.lotNo ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="whitespace-nowrap text-sm">{r.warehouse.name}</td>
                        <td className="whitespace-nowrap text-sm">{day(r.createdAt)}</td>
                        <td>
                          <span className={`badge ${st.cls}`}>{st.label}</span>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <button className="btn-ghost p-1.5" title="Print label" onClick={() => printLabels([r.id])}>
                            <Printer size={15} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </ScrollableTable>
          )}
        </div>
      ) : (
        <ToLabelView todo={todo} loading={loading} grnFilter={grnFilter} creator={creator} onLabel={setLabelling} onClearGrn={() => go('label')} />
      )}

      {labelling && (
        <LabelDialog
          target={labelling}
          onClose={() => setLabelling(null)}
          onDone={(m, ids) => {
            setLastBatch(ids)
            setLabelling(null)
            setMessage(`${m} The stickers have opened in a new tab for printing.`)
            void load()
          }}
        />
      )}
    </div>
  )
}

function ToLabelView({
  todo,
  loading,
  grnFilter,
  creator,
  onLabel,
  onClearGrn,
}: {
  todo: ToLabel | null
  loading: boolean
  grnFilter: string
  creator: boolean
  onLabel: (t: LabelTarget) => void
  onClearGrn: () => void
}) {
  if (!todo) return <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : ''}</p>
  if (!todo.tracked) {
    return (
      <div className="glass-card p-8 text-center text-muted-foreground">
        No category is kept in packages yet. Open{' '}
        <Link href="/masters/item-categories" className="font-semibold text-primary hover:underline">
          Masters → Item Categories
        </Link>
        , edit a category such as Fabric or Trims, and tick <span className="font-semibold text-foreground">Track by package</span>.
      </div>
    )
  }
  const lines = todo.lines.filter((l) => l.toLabel > 0)
  return (
    <div className="space-y-5">
      <div className="glass-card overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="font-semibold text-foreground">Received on GRNs</h3>
            <p className="text-sm text-muted-foreground">
              {grnFilter ? 'This GRN' : 'GRNs of the last 90 days'} with items kept in packages and not yet stickered
            </p>
          </div>
          {grnFilter && (
            <button className="btn-ghost" onClick={onClearGrn}>
              <X size={15} /> Show all GRNs
            </button>
          )}
        </div>
        {lines.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Everything received is labelled.</p>
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
                {lines.map((l) => (
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
                              grnNumber: l.grnNumber,
                              supplier: l.supplier,
                              lotNo: l.lotNo,
                              packType: l.packType,
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
      </div>

      {!grnFilter && (
        <div className="glass-card overflow-hidden p-0">
          <div className="border-b border-border px-4 py-3">
            <h3 className="font-semibold text-foreground">Already on the racks, not labelled</h3>
            <p className="text-sm text-muted-foreground">Stock of these items with no sticker — from before packages were switched on, or left over</p>
          </div>
          {todo.loose.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">All the stock of these items is in labelled packages.</p>
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
                  {todo.loose.map((l) => (
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
        </div>
      )}
    </div>
  )
}

export default function PackagesPage() {
  return (
    <Suspense fallback={null}>
      <PackagesScreen />
    </Suspense>
  )
}
