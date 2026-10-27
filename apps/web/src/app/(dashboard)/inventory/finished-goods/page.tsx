'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Ban, CalendarDays, ChevronDown, ChevronRight, Info, PackageCheck, Plus, RefreshCw, Search } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { RowPanel } from '@/components/tables/RowPanel'
import { ScrollableTable } from '@/components/tables/ScrollableTable'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate, formatRupees } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { FinishedGoodsDialog } from '@/components/inventory/FinishedGoodsDialog'

interface Receipt {
  id: string
  fgrNumber: string
  receiptDate: string
  notes: string | null
  cancelledAt: string | null
  cancelReason: string | null
  warehouse: { id: string; name: string }
  so: { id: string; soNumber: string; customer: { name: string } } | null
  createdBy: { name: string }
  cancelledBy: { name: string } | null
  lines: Array<{
    id: string
    qty: string | number
    unitRate: string | number
    rateSource: string
    item: { id: string; code: string; name: string; color: string | null }
    size: { id: string; code: string; sequence: number } | null
  }>
  pieces: number
  value: number
}

const pcs = (n: number | string) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })

/** Where a piece's stock value came from. */
const RATE_FROM: Record<string, string> = {
  BOM: 'Approved BOM cost',
  STANDARD: 'Item standard rate',
  JOB_WORK: "Customer's goods, ₹0",
}

/** "38 30 · 40 40 · 42 30", or the pieces when the item has no sizes. */
const sizeRun = (g: ReturnType<typeof byItem>[number]) =>
  g.sizes.some((l) => l.size) ? g.sizes.map((l) => `${l.size?.code ?? '—'} ${pcs(l.qty)}`).join(' · ') : `${pcs(g.total)} pcs`

/** A receipt's lines read back per item: "FG-SHRT-002 · S 40 · M 100 · L 120". */
function byItem(r: Receipt) {
  const groups = new Map<string, { item: Receipt['lines'][number]['item']; sizes: Receipt['lines']; total: number }>()
  for (const l of r.lines) {
    const g = groups.get(l.item.id) ?? { item: l.item, sizes: [], total: 0 }
    g.sizes.push(l)
    g.total += Number(l.qty)
    groups.set(l.item.id, g)
  }
  return [...groups.values()].map((g) => ({
    ...g,
    sizes: [...g.sizes].sort((a, b) => (a.size?.sequence ?? 0) - (b.size?.sequence ?? 0)),
  }))
}

/**
 * Finished goods in: every receipt of packed garments into the finished-goods
 * store, newest first. A receipt is cancelled, not edited: cancelling takes its
 * pieces back out of stock, so it is only possible while they are still there.
 */
export default function FinishedGoodsPage() {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<Receipt[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([])

  const [adding, setAdding] = useState(false)
  /** Opened from a manufacturing order: its pieces ready to pack come in filled. */
  const [presetMoId, setPresetMoId] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<Receipt | null>(null)
  const [busy, setBusy] = useState(false)
  /** The receipt whose sizes are open under its row. */
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ data: Array<{ id: string; name: string }> }>('/masters/warehouses?limit=100')
      .then((r) => setWarehouses(r.data))
      .catch(() => {})
    const mo = new URLSearchParams(window.location.search).get('mo')
    if (mo) {
      setPresetMoId(mo)
      setAdding(true)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const latest = useRef(0)
  const load = useCallback(async () => {
    const ticket = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage) })
      if (debounced) qs.set('q', debounced)
      if (warehouseId) qs.set('warehouseId', warehouseId)
      if (fromDate) qs.set('from', fromDate)
      if (toDate) qs.set('to', toDate)
      const res = await api.get<Paginated<Receipt>>(`/finished-goods?${qs}`)
      if (ticket !== latest.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing finished goods.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [page, rowsPerPage, debounced, warehouseId, fromDate, toDate])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    setPage(1)
  }, [debounced, warehouseId, fromDate, toDate])

  const anyFilter = Boolean(search || warehouseId || fromDate || toDate)

  const cancel = async (reason: string) => {
    if (!cancelling) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ message?: string }>(`/finished-goods/${cancelling.id}/cancel`, { reason })
      setMessage(res.message ?? `${cancelling.fgrNumber} cancelled.`)
      void load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel it.')
    } finally {
      setBusy(false)
      setCancelling(null)
    }
  }

  const rowActions = (r: Receipt): RowAction[] =>
    !r.cancelledAt && can('inventory', 'edit')
      ? [{ key: 'cancel', label: 'Cancel receipt', icon: <Ban size={15} />, danger: true, onClick: () => setCancelling(r) }]
      : []

  const pages = Math.ceil(total / rowsPerPage) || 1

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Finished Goods In</h1>
          <p className="page-subtitle hidden sm:block">Packed garments into the finished-goods store, by size</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {can('inventory', 'create') && (
            <button className="btn-primary" onClick={() => setAdding(true)} aria-label="New finished goods receipt" data-hotkey="new" aria-keyshortcuts="Alt+N">
              <Plus size={15} /> <span className="hidden sm:inline">Put packed goods in</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-3">
          <p className="text-primary text-sm">{message}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:max-w-[240px]">
            <Search size={14} className="text-muted-foreground hidden shrink-0 sm:block" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="Receipt, order or item..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search finished goods receipts"
              data-hotkey="search"
            />
          </div>
          <div className="flex items-center gap-1">
            <input type="date" className="form-input h-8 w-[7.75rem] px-2 py-0 text-xs" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} aria-label="From date" />
            <span className="text-muted-foreground text-xs">to</span>
            <input type="date" className="form-input h-8 w-[7.75rem] px-2 py-0 text-xs" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} aria-label="To date" />
          </div>
          <SmartSelect className="form-input h-8 px-2 py-0 text-xs sm:w-44" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="Filter by store">
            <option value="">All stores</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </SmartSelect>
          {anyFilter && (
            <button
              className="btn-ghost h-8 px-2 text-xs"
              onClick={() => {
                setSearch('')
                setWarehouseId('')
                setFromDate('')
                setToDate('')
              }}
            >
              Clear
            </button>
          )}
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {total} {total === 1 ? 'receipt' : 'receipts'}
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            {anyFilter
              ? 'No receipts match these filters.'
              : 'Nothing put into the finished-goods store yet. When garments are packed, press "Put packed goods in".'}
          </p>
        ) : (
          // A table like every other list, and a card per receipt where the
          // list is too narrow for its columns (see `.list-scope`).
          <div className="list-scope">
            <div className="list-cards divide-border divide-y">
              {rows.map((r) => {
                const actions = rowActions(r)
                return (
                  <div key={r.id} className="space-y-2 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-primary font-mono text-xs font-semibold">{r.fgrNumber}</span>
                          {r.cancelledAt ? <span className="badge-neutral">Cancelled</span> : <span className="badge-success">In stock</span>}
                        </div>
                        <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-[11px]">
                          <CalendarDays size={11} /> {formatDate(r.receiptDate)} · {r.warehouse.name}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-foreground font-semibold tabular-nums">{pcs(r.pieces)} pcs</p>
                        <p className="text-muted-foreground text-xs tabular-nums">{formatRupees(r.value)}</p>
                      </div>
                    </div>
                    {byItem(r).map((g) => (
                      <div key={g.item.id}>
                        <p className="text-foreground text-sm font-medium leading-snug">
                          {g.item.name}
                          {g.item.color ? <span className="text-muted-foreground font-normal"> · {g.item.color}</span> : null}
                        </p>
                        <p className="text-muted-foreground text-xs tabular-nums">
                          {sizeRun(g)} · <span className="text-foreground">{pcs(g.total)} pcs</span>
                        </p>
                      </div>
                    ))}
                    <p className="text-muted-foreground text-[11px]">
                      {r.so ? `For ${r.so.soNumber} · ${r.so.customer.name} · ` : ''}By {r.createdBy.name}
                    </p>
                    {r.cancelledAt && (
                      <p className="text-muted-foreground text-[11px]">
                        Cancelled {formatDate(r.cancelledAt)}
                        {r.cancelledBy ? ` by ${r.cancelledBy.name}` : ''}: {r.cancelReason}
                      </p>
                    )}
                    {actions.length > 0 && (
                      <div className="flex justify-end">
                        <ActionMenu label={`Actions for ${r.fgrNumber}`} items={actions} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="list-rows w-full">
              <ScrollableTable>
                <table className="data-table min-w-full">
                  <thead>
                    <tr className="bg-secondary">
                      <th style={{ width: 30 }} />
                      <th className="whitespace-nowrap">Receipt no.</th>
                      <th className="whitespace-nowrap">Date</th>
                      <th>Store</th>
                      <th className="whitespace-nowrap">Sales order</th>
                      <th>Items</th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                        Pieces
                      </th>
                      <th className="whitespace-nowrap" style={{ textAlign: 'right' }}>
                        Value
                      </th>
                      <th>Status</th>
                      <th className="whitespace-nowrap">Received by</th>
                      <th className="border-border bg-secondary sticky right-0 z-10 border-l" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, ri) => {
                      const actions = rowActions(r)
                      const items = byItem(r)
                      const expanded = open === r.id
                      return (
                        <Fragment key={r.id}>
                          <tr data-row tabIndex={ri === 0 ? 0 : -1}>
                            <td>
                              <button
                                data-row-open
                                className="btn-ghost p-1"
                                onClick={() => setOpen(expanded ? null : r.id)}
                                aria-label={`${expanded ? 'Hide' : 'Show'} the sizes on ${r.fgrNumber}`}
                                aria-expanded={expanded}
                              >
                                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            </td>
                            <td className="whitespace-nowrap">
                              <span className="text-primary font-mono text-xs font-semibold">{r.fgrNumber}</span>
                            </td>
                            <td className="whitespace-nowrap text-sm">{formatDate(r.receiptDate)}</td>
                            <td className="whitespace-nowrap text-sm">{r.warehouse.name}</td>
                            <td className="text-sm">
                              {r.so ? (
                                <>
                                  <div className="whitespace-nowrap font-mono text-xs">{r.so.soNumber}</div>
                                  <div className="text-muted-foreground text-xs">{r.so.customer.name}</div>
                                </>
                              ) : (
                                <span className="text-muted-foreground">For stock</span>
                              )}
                            </td>
                            <td className="min-w-[16rem]">
                              <div className="text-foreground text-sm font-medium leading-snug">
                                {items[0].item.name}
                                {items[0].item.color ? <span className="text-muted-foreground font-normal"> · {items[0].item.color}</span> : null}
                                {items.length > 1 && <span className="text-muted-foreground font-normal"> +{items.length - 1} more</span>}
                              </div>
                              <div className="text-muted-foreground text-xs tabular-nums">{items.length === 1 ? sizeRun(items[0]) : `${items.length} items`}</div>
                            </td>
                            <td className="whitespace-nowrap text-right font-semibold tabular-nums">{pcs(r.pieces)} pcs</td>
                            <td className="whitespace-nowrap text-right tabular-nums">{formatRupees(r.value)}</td>
                            <td className="whitespace-nowrap">
                              {r.cancelledAt ? (
                                <span className="badge-neutral" title={`Cancelled ${formatDate(r.cancelledAt)}${r.cancelledBy ? ` by ${r.cancelledBy.name}` : ''}: ${r.cancelReason ?? ''}`}>
                                  Cancelled
                                </span>
                              ) : (
                                <span className="badge-success">In stock</span>
                              )}
                            </td>
                            <td className="whitespace-nowrap text-sm">{r.createdBy.name}</td>
                            <td className="border-border bg-card sticky right-0 z-10 whitespace-nowrap border-l text-right">
                              {actions.length > 0 ? (
                                <ActionMenu label={`Actions for ${r.fgrNumber}`} items={actions} />
                              ) : (
                                <span className="text-muted-foreground text-xs">—</span>
                              )}
                            </td>
                          </tr>

                          {expanded && (
                            <tr>
                              <td colSpan={10} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                                <div className="w-full space-y-2">
                                  <RowPanel icon={PackageCheck} title="What came in" note={`${r.lines.length} ${r.lines.length === 1 ? 'line' : 'lines'} on ${r.fgrNumber}`}>
                                    <table className="subtable w-full table-fixed">
                                      <colgroup>
                                        <col style={{ width: '34%' }} />
                                        <col style={{ width: '10%' }} />
                                        <col style={{ width: '12%' }} />
                                        <col style={{ width: '12%' }} />
                                        <col style={{ width: '14%' }} />
                                        <col style={{ width: '18%' }} />
                                      </colgroup>
                                      <thead className="sticky top-0 z-10">
                                        <tr>
                                          <th>Item</th>
                                          <th>Size</th>
                                          <th className="text-right">Pieces</th>
                                          <th className="text-right">Rate</th>
                                          <th className="text-right">Value</th>
                                          <th>Rate from</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {items.flatMap((g) =>
                                          g.sizes.map((l, i) => (
                                            <tr key={l.id}>
                                              <td>
                                                {i === 0 ? (
                                                  <>
                                                    <div className="text-foreground">
                                                      {g.item.name}
                                                      {g.item.color ? <span className="text-muted-foreground"> · {g.item.color}</span> : null}
                                                    </div>
                                                    <div className="text-muted-foreground font-mono text-[10px]">{g.item.code}</div>
                                                  </>
                                                ) : null}
                                              </td>
                                              <td className="font-semibold">{l.size?.code ?? '—'}</td>
                                              <td className="text-right tabular-nums">{pcs(l.qty)}</td>
                                              <td className="text-right tabular-nums">{formatRupees(Number(l.unitRate))}</td>
                                              <td className="text-right tabular-nums">{formatRupees(Number(l.qty) * Number(l.unitRate))}</td>
                                              <td className="text-muted-foreground text-xs">{RATE_FROM[l.rateSource] ?? l.rateSource}</td>
                                            </tr>
                                          )),
                                        )}
                                        <tr className="font-semibold">
                                          <td>Total</td>
                                          <td />
                                          <td className="text-right tabular-nums">{pcs(r.pieces)}</td>
                                          <td />
                                          <td className="text-right tabular-nums">{formatRupees(r.value)}</td>
                                          <td />
                                        </tr>
                                      </tbody>
                                    </table>
                                  </RowPanel>
                                  {(r.notes || r.cancelledAt) && (
                                    <p className="text-muted-foreground px-1 text-xs">
                                      {r.notes && <>Note: {r.notes}. </>}
                                      {r.cancelledAt && (
                                        <>
                                          Cancelled {formatDate(r.cancelledAt)}
                                          {r.cancelledBy ? ` by ${r.cancelledBy.name}` : ''}: {r.cancelReason}
                                        </>
                                      )}
                                    </p>
                                  )}
                                </div>
                              </td>
                              <td className="border-border bg-card sticky right-0 z-10 border-l" />
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </ScrollableTable>
            </div>
          </div>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />

        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            Each piece goes into stock at its style&apos;s approved BOM cost, or the item&apos;s standard rate when there is no
            approved costing. Cancelling a receipt takes its pieces back out, so it works only while they are still in the store.
          </p>
        </div>
      </div>

      <FinishedGoodsDialog
        open={adding}
        presetMoId={presetMoId}
        onClose={() => {
          setAdding(false)
          setPresetMoId(null)
        }}
        onSaved={(msg) => {
          setMessage(msg)
          void load()
        }}
      />

      {cancelling && (
        <ReasonDialog
          title={`Cancel ${cancelling.fgrNumber}?`}
          description="Its pieces come back out of the finished-goods store, and the receipt stays on file as cancelled. Refused if any of them have already been dispatched."
          confirmLabel="Cancel receipt"
          placeholder="Counted wrong at packing"
          danger
          busy={busy}
          onCancel={() => setCancelling(null)}
          onConfirm={(reason) => void cancel(reason)}
        />
      )}
    </div>
  )
}
