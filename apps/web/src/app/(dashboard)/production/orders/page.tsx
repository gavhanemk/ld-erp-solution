'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CalendarDays, CheckCircle2, Eye, Info, Pencil, Plus, RefreshCw, Search } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { MO_STATUS, moStatus } from '@/components/production/status'
import { ManufacturingOrderDialog } from '@/components/production/ManufacturingOrderDialog'
import { ManufacturingOrderDetailDialog } from '@/components/production/ManufacturingOrderDetailDialog'

interface MoRow {
  id: string
  moNumber: string
  status: string
  brand: { id: string; name: string; type: string }
  soId: string | null
  customer: string | null
  soNumber: string | null
  deliveryDate: string | null
  styles: string[]
  withoutBom: number
  requisitions: number
  plannedStartDate: string | null
  plannedEndDate: string | null
  closeReason: string | null
  totalPlannedQty: number
  totalPackedQty: number
}

const pcs = (n: number) => n.toLocaleString('en-IN')

/**
 * Manufacturing orders: what the factory is making, and for which order.
 *
 * Each is raised from a confirmed sales order (New MO, or Plan production on
 * the order), released to the floor, and its materials worked out from the
 * BOM and asked of the store. Packed is what has been booked into finished
 * goods against it. Links in: ?make=<sales order id> opens a new one for
 * that order; ?open=<id> opens one.
 */
export default function ManufacturingOrdersPage() {
  const { rowsPerPage } = useAppSettings()
  const [rows, setRows] = useState<MoRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [openOnly, setOpenOnly] = useState(true)
  const [page, setPage] = useState(1)

  const [form, setForm] = useState<{ open: boolean; soId: string | null; moId: string | null }>({ open: false, soId: null, moId: null })
  const [viewId, setViewId] = useState<string | null>(null)

  const mayCreate = can('production', 'create')
  const mayEdit = can('production', 'edit')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const make = params.get('make')
    const openId = params.get('open')
    if (make && can('production', 'create')) setForm({ open: true, soId: make, moId: null })
    if (openId) setViewId(openId)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const ticket = ++latestLoad.current
    setLoading(true)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      else if (openOnly) qs.set('open', '1')
      const res = await api.get<Paginated<MoRow>>(`/production/orders?${qs}`)
      if (ticket !== latestLoad.current) return
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      if (ticket !== latestLoad.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing manufacturing orders.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      if (ticket === latestLoad.current) setLoading(false)
    }
  }, [page, rowsPerPage, debounced, status, openOnly])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    setPage(1)
  }, [debounced, status, openOnly])

  const release = async (mo: MoRow) => {
    if (!window.confirm(`Release ${mo.moNumber} to the floor?${mo.soNumber ? ` ${mo.soNumber} goes into production.` : ''}`)) return
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${mo.id}/release`, {})
      setMessage(res.message ?? `${mo.moNumber} released.`)
      void load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not release it.')
    }
  }

  const rowActions = (mo: MoRow): RowAction[] => {
    const items: RowAction[] = [{ key: 'view', label: 'Open — materials and progress', icon: <Eye size={15} />, onClick: () => setViewId(mo.id) }]
    if (mo.status === 'DRAFT' && mayEdit) {
      items.push({ key: 'edit', label: 'Edit draft', icon: <Pencil size={15} />, onClick: () => setForm({ open: true, soId: null, moId: mo.id }) })
      items.push({ key: 'release', label: 'Release to the floor', icon: <CheckCircle2 size={15} />, onClick: () => void release(mo) })
    }
    return items
  }

  const pages = Math.ceil(total / rowsPerPage) || 1

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Manufacturing Orders</h1>
          <p className="page-subtitle hidden sm:block">What the factory is making, for which sales order, and the materials it needs</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {mayCreate && (
            <button className="btn-primary" onClick={() => setForm({ open: true, soId: null, moId: null })}>
              <Plus size={15} /> <span className="hidden sm:inline">New MO</span>
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
          <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:min-w-[170px] sm:max-w-[260px] sm:basis-0 sm:px-2.5">
            <Search size={14} className="text-muted-foreground hidden shrink-0 sm:block" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="MO, sales order, customer, style..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search manufacturing orders"
            />
          </div>
          <SmartSelect className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-36 sm:px-3 sm:text-xs" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">{openOnly ? 'Open ones' : 'All statuses'}</option>
            {Object.entries(MO_STATUS).map(([v, s]) => (
              <option key={v} value={v}>
                {s.label}
              </option>
            ))}
          </SmartSelect>
          <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
            <input type="checkbox" className="accent-primary" checked={openOnly} disabled={!!status} onChange={(e) => setOpenOnly(e.target.checked)} />
            Hide completed and closed
          </label>
          <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
            {total} {total === 1 ? 'order' : 'orders'}
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              {search || status ? 'No manufacturing orders match these filters.' : 'None open. Press New MO, or Plan production on a confirmed sales order.'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            <div className="list-cards divide-border divide-y">
              {rows.map((mo) => {
                const s = moStatus(mo.status)
                const share = mo.totalPlannedQty > 0 ? Math.min(100, Math.round((mo.totalPackedQty / mo.totalPlannedQty) * 100)) : 0
                return (
                  <div key={mo.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" className="text-primary font-mono text-xs font-semibold hover:underline" onClick={() => setViewId(mo.id)}>
                            {mo.moNumber}
                          </button>
                          <span className={s.cls}>{s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium leading-snug">{mo.customer ?? '—'}</p>
                        <p className="text-muted-foreground text-[11px]">
                          {mo.soNumber ?? 'No order'} · {mo.styles.slice(0, 2).join(', ')}
                          {mo.styles.length > 2 ? ` +${mo.styles.length - 2}` : ''}
                        </p>
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">{pcs(mo.totalPlannedQty)} pcs</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">
                        Packed {share}% · finish {mo.plannedEndDate ? formatDate(mo.plannedEndDate) : '—'}
                      </span>
                      <ActionMenu label={`Actions for ${mo.moNumber}`} items={rowActions(mo)} />
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="list-rows w-full">
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th>MO</th>
                    <th>Sales order</th>
                    <th className="col-wide">Styles</th>
                    <th style={{ textAlign: 'right' }}>Planned</th>
                    <th className="col-roomy">Packed</th>
                    <th className="col-wide">Materials</th>
                    <th>Finish by</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((mo) => {
                    const s = moStatus(mo.status)
                    const share = mo.totalPlannedQty > 0 ? Math.min(100, Math.round((mo.totalPackedQty / mo.totalPlannedQty) * 100)) : 0
                    const late = mo.plannedEndDate && new Date(mo.plannedEndDate) < new Date(new Date().toDateString()) && !['COMPLETED', 'CLOSED'].includes(mo.status)
                    return (
                      <tr key={mo.id}>
                        <td className="whitespace-nowrap">
                          <button type="button" className="text-primary font-mono text-xs font-semibold hover:underline" onClick={() => setViewId(mo.id)}>
                            {mo.moNumber}
                          </button>
                          {mo.plannedStartDate && (
                            <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                              <CalendarDays size={11} className="shrink-0" />
                              {formatDate(mo.plannedStartDate)}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="text-foreground max-w-[15rem] truncate font-medium">{mo.customer ?? '—'}</div>
                          {mo.soNumber && (
                            <a href={`/sales/orders?q=${encodeURIComponent(mo.soNumber)}`} className="text-primary font-mono text-[11px] hover:underline">
                              {mo.soNumber}
                            </a>
                          )}
                        </td>
                        <td className="col-wide max-w-[14rem] text-xs">
                          <span className="font-mono">{mo.styles.slice(0, 2).join(', ')}</span>
                          {mo.styles.length > 2 && <span className="text-muted-foreground"> +{mo.styles.length - 2}</span>}
                        </td>
                        <td className="text-right font-semibold tabular-nums">{pcs(mo.totalPlannedQty)}</td>
                        <td className="col-roomy">
                          <div className="flex min-w-[7.5rem] flex-col gap-1">
                            <div className="bg-secondary h-1.5 rounded-full" aria-hidden>
                              <div className="bg-primary h-1.5 rounded-full" style={{ width: `${share}%` }} />
                            </div>
                            <span className="text-muted-foreground text-[11px] tabular-nums">
                              {pcs(mo.totalPackedQty)} of {pcs(mo.totalPlannedQty)}
                            </span>
                          </div>
                        </td>
                        <td className="col-wide text-xs">
                          {mo.withoutBom > 0 ? (
                            <span className="warn-text">{mo.withoutBom} without a BOM</span>
                          ) : mo.requisitions > 0 ? (
                            <span className="text-foreground">
                              {mo.requisitions} {mo.requisitions === 1 ? 'requisition' : 'requisitions'}
                            </span>
                          ) : mo.status === 'DRAFT' ? (
                            <span className="text-muted-foreground">After release</span>
                          ) : (
                            <span className="warn-text">Not asked for yet</span>
                          )}
                        </td>
                        <td className={`whitespace-nowrap text-xs ${late ? 'text-destructive font-medium' : ''}`}>
                          {mo.plannedEndDate ? formatDate(mo.plannedEndDate) : '—'}
                          {late && <div className="text-[11px]">late</div>}
                        </td>
                        <td>
                          <span className={s.cls} title={mo.closeReason ?? undefined}>
                            {s.label}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <div className="flex justify-end">
                            <ActionMenu label={`Actions for ${mo.moNumber}`} items={rowActions(mo)} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />

        <div className="border-border bg-secondary/40 flex items-start gap-2 border-t px-4 py-2">
          <Info size={14} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            Raised from a confirmed sales order and released to the floor, which puts the order In production. Open one to see the materials its BOM
            needs and ask the store for them. Packed counts what is booked into Finished Goods In against it.
          </p>
        </div>
      </div>

      <ManufacturingOrderDialog
        open={form.open}
        soId={form.soId}
        moId={form.moId}
        onClose={() => setForm({ open: false, soId: null, moId: null })}
        onSaved={(msg, id) => {
          setMessage(msg)
          setError(null)
          void load()
          setViewId(id)
        }}
      />
      <ManufacturingOrderDetailDialog
        moId={viewId}
        onClose={() => setViewId(null)}
        onEdit={(id) => {
          setViewId(null)
          setForm({ open: true, soId: null, moId: id })
        }}
        onChanged={(msg) => {
          setMessage(msg)
          void load()
        }}
      />
    </div>
  )
}
