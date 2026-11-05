'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Ban, CalendarDays, CheckCircle2, Eye, Info, Pencil, Plus, RefreshCw, Search } from 'lucide-react'
import { api, ApiError, can, type Paginated } from '@/lib/api'
import { Pagination } from '@/components/tables/Pagination'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'
import { ReasonDialog } from '@/components/ui/ReasonDialog'
import { FLOOR_NOTE, MO_STAGE, moStage } from '@/components/production/status'
import { PROGRESS } from '@/components/production/floor/types'
import { ManufacturingOrderDialog } from '@/components/production/ManufacturingOrderDialog'
import { ManufacturingOrderDetailDialog } from '@/components/production/ManufacturingOrderDetailDialog'

interface MoRow {
  id: string
  moNumber: string
  status: string
  /** Where the work stands: materials not asked, asked, issued, in production, packing… (MO_STAGE). */
  stage: string
  /** Part issued or issued: the materials its BOM asks for, and how many are issued in full. */
  materialItems: number | null
  materialItemsInFull: number | null
  /** Its plan can still change: nothing issued to it, cut or packed yet. */
  editable?: boolean
  /** Why it cannot, in a few words. */
  editBlock?: string | null
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
  totalCutQty: number
  /** Where the work stands across its route, for an order with one. */
  progress: string | null
  routing: string | null
  routed: boolean
  held: boolean
  holdReason: string | null
}

const pcs = (n: number) => n.toLocaleString('en-IN')

/**
 * Beside the stage: on hold, or, once it is being made, what the floor says
 * needs a look (QC pending, rework, count short) or that every piece is through.
 */
function FloorState({ mo }: { mo: MoRow }) {
  if (mo.held) {
    return (
      <span className="badge-warning" title={mo.holdReason ?? undefined}>
        On hold
      </span>
    )
  }
  if (!mo.routed || !['IN_PRODUCTION', 'PACKING'].includes(mo.stage) || !mo.progress || !FLOOR_NOTE.has(mo.progress)) return null
  const p = PROGRESS[mo.progress]
  return p ? <span className={p.cls}>{p.label}</span> : null
}

/** What has been asked of the store for it, and how much of that is issued. */
function Materials({ mo }: { mo: MoRow }) {
  const n = mo.requisitions
  const asked = `${n} ${n === 1 ? 'requisition' : 'requisitions'}`
  if (mo.withoutBom > 0) return <span className="warn-text whitespace-nowrap">{mo.withoutBom} without a BOM</span>
  switch (mo.stage) {
    case 'DRAFT':
      return <span className="text-muted-foreground whitespace-nowrap">After release</span>
    case 'NOT_ASKED':
      return <span className="warn-text whitespace-nowrap">Not asked for yet</span>
    case 'ASKED':
      return (
        <div className="whitespace-nowrap">
          <span className="text-foreground">{asked}</span>
          <div className="text-muted-foreground text-[11px]">Nothing issued yet</div>
        </div>
      )
    case 'PART_ISSUED':
      return (
        <div className="whitespace-nowrap" title="Items the BOM asks for, and how many of them the store has issued in full">
          <span className="warn-text">
            {mo.materialItemsInFull ?? 0} of {mo.materialItems ?? 0} issued in full
          </span>
          <div className="text-muted-foreground text-[11px]">{asked}</div>
        </div>
      )
    case 'ISSUED':
      return (
        <div className="whitespace-nowrap">
          <span className="text-foreground">All {mo.materialItems ?? ''} issued in full</span>
          <div className="text-muted-foreground text-[11px]">{asked}</div>
        </div>
      )
    default:
      return n > 0 ? <span className="text-foreground whitespace-nowrap">{asked}</span> : <span className="text-muted-foreground">—</span>
  }
}

/**
 * Manufacturing orders: what the factory is making, and for which order.
 *
 * Each is raised from a confirmed sales order (New MO, or Plan production on
 * the order), released to the floor, and its materials worked out from the
 * BOM and asked of the store. Packed is what has been booked into finished
 * goods against it. Links in: ?make=<sales order id> opens a new one for
 * that order; ?open=<id> opens one; ?stage=<stage> lists those at it.
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
  const [stage, setStage] = useState('')
  const [openOnly, setOpenOnly] = useState(true)
  const [page, setPage] = useState(1)

  const [form, setForm] = useState<{ open: boolean; soId: string | null; moId: string | null }>({ open: false, soId: null, moId: null })
  const [viewId, setViewId] = useState<string | null>(null)
  /** A save just made in the form, confirmed in the window it opens. */
  const [savedNote, setSavedNote] = useState<string | null>(null)
  /** One whose sales order is over, being closed. */
  const [closing, setClosing] = useState<MoRow | null>(null)
  const [closeBusy, setCloseBusy] = useState(false)

  const mayCreate = can('production', 'create')
  const mayEdit = can('production', 'edit')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const make = params.get('make')
    const openId = params.get('open')
    const at = params.get('stage')
    if (make && can('production', 'create')) setForm({ open: true, soId: make, moId: null })
    if (openId) setViewId(openId)
    if (at && MO_STAGE[at]) setStage(at)
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
      if (stage) qs.set('stage', stage)
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
  }, [page, rowsPerPage, debounced, stage, openOnly])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    setPage(1)
  }, [debounced, stage, openOnly])

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

  const closeMo = async (mo: MoRow, reason: string) => {
    setCloseBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.post<{ message?: string }>(`/production/orders/${mo.id}/close`, { reason })
      setMessage(res.message ?? `${mo.moNumber} closed.`)
      setClosing(null)
      void load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not close it.')
      setClosing(null)
    } finally {
      setCloseBusy(false)
    }
  }

  const rowActions = (mo: MoRow): RowAction[] => {
    const items: RowAction[] = [{ key: 'view', label: 'Open — materials and progress', icon: <Eye size={15} />, onClick: () => setViewId(mo.id) }]
    // Editable until the store issues material to it (or cutting or packing starts), released or not.
    if (mayEdit && mo.editable) {
      items.push({ key: 'edit', label: mo.status === 'DRAFT' ? 'Edit draft' : 'Edit', icon: <Pencil size={15} />, onClick: () => setForm({ open: true, soId: null, moId: mo.id }) })
    } else if (mayEdit && mo.editBlock && mo.status !== 'COMPLETED' && mo.status !== 'CLOSED') {
      // Shown, greyed, with what is in the way: a missing Edit reads as a fault.
      items.push({ key: 'edit', label: 'Edit', icon: <Pencil size={15} />, disabled: true, hint: `Cannot be edited: ${mo.editBlock}.` })
    }
    if (mo.status === 'DRAFT' && mayEdit && mo.stage !== 'ORDER_CLOSED') {
      items.push({ key: 'release', label: 'Release to the floor', icon: <CheckCircle2 size={15} />, onClick: () => void release(mo) })
    }
    // Its sales order is over and nothing was made on it: all that is left is closing it.
    if (mo.stage === 'ORDER_CLOSED' && mayEdit) {
      items.push({ key: 'close', label: 'Cancel MO — its sales order is closed', icon: <Ban size={15} />, danger: true, onClick: () => setClosing(mo) })
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
            <button className="btn-primary" onClick={() => setForm({ open: true, soId: null, moId: null })} data-hotkey="new" aria-keyshortcuts="Alt+N">
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
              data-hotkey="search"
            />
          </div>
          <SmartSelect className="form-input h-8 min-w-0 px-1.5 py-0 text-[11px] sm:w-44 sm:px-3 sm:text-xs" value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by status">
            <option value="">{openOnly ? 'Open ones' : 'All statuses'}</option>
            {Object.entries(MO_STAGE).map(([v, s]) => (
              <option key={v} value={v}>
                {s.label}
              </option>
            ))}
          </SmartSelect>
          <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
            <input type="checkbox" className="accent-primary" checked={openOnly} disabled={!!stage} onChange={(e) => setOpenOnly(e.target.checked)} />
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
              {search || stage ? 'No manufacturing orders match these filters.' : 'None open. Press New MO, or Plan production on a confirmed sales order.'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            <div className="list-cards divide-border divide-y">
              {rows.map((mo) => {
                const s = moStage(mo.stage, mo.status)
                const share = mo.totalPlannedQty > 0 ? Math.min(100, Math.round((mo.totalPackedQty / mo.totalPlannedQty) * 100)) : 0
                return (
                  <div key={mo.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" className="text-primary font-mono text-xs font-semibold hover:underline" onClick={() => setViewId(mo.id)}>
                            {mo.moNumber}
                          </button>
                          <span className={s.cls} title={s.hint}>
                            {s.label}
                          </span>
                          <FloorState mo={mo} />
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
                        Cut {pcs(mo.totalCutQty)} · packed {share}% · finish {mo.plannedEndDate ? formatDate(mo.plannedEndDate) : '—'}
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
                  {rows.map((mo, i) => {
                    const s = moStage(mo.stage, mo.status)
                    const share = mo.totalPlannedQty > 0 ? Math.min(100, Math.round((mo.totalPackedQty / mo.totalPlannedQty) * 100)) : 0
                    const late = mo.plannedEndDate && new Date(mo.plannedEndDate) < new Date(new Date().toDateString()) && !['COMPLETED', 'CLOSED'].includes(mo.status)
                    return (
                      <tr key={mo.id} data-row tabIndex={i === 0 ? 0 : -1}>
                        <td className="whitespace-nowrap">
                          <button type="button" className="text-primary font-mono text-xs font-semibold hover:underline" onClick={() => setViewId(mo.id)} data-row-open>
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
                              {mo.totalCutQty ? ` · ${pcs(mo.totalCutQty)} cut` : ''}
                            </span>
                          </div>
                        </td>
                        <td className="col-wide text-xs">
                          <Materials mo={mo} />
                        </td>
                        <td className={`whitespace-nowrap text-xs ${late ? 'text-destructive font-medium' : ''}`}>
                          {mo.plannedEndDate ? formatDate(mo.plannedEndDate) : '—'}
                          {late && <div className="text-[11px]">late</div>}
                        </td>
                        <td>
                          <div className="flex flex-col items-start gap-1">
                            <span className={`${s.cls} whitespace-nowrap`} title={mo.closeReason ?? s.hint}>
                              {s.label}
                            </span>
                            <FloorState mo={mo} />
                          </div>
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
            Status follows the work: Draft → Materials not asked → Materials asked → Part issued → Materials issued → In production → Packing →
            Completed. Open one to see the materials its BOM needs and ask the store for them. Packed counts what is booked into Finished Goods In
            against it.
          </p>
        </div>
      </div>

      {closing && (
        <ReasonDialog
          title={`Cancel ${closing.moNumber}?`}
          description={`${closing.soNumber ?? 'Its sales order'} is closed and nothing was issued, cut or packed on this order. Nothing is deleted: it stays on file as Closed, with your reason; its requisitions close with it.`}
          confirmLabel="Cancel the MO"
          cancelLabel="Keep it"
          initialReason={`${closing.soNumber ?? 'The sales order'} is closed: nothing more is made for it`}
          danger
          busy={closeBusy}
          onCancel={() => setClosing(null)}
          onConfirm={(reason) => void closeMo(closing, reason)}
        />
      )}

      <ManufacturingOrderDialog
        open={form.open}
        soId={form.soId}
        moId={form.moId}
        onClose={() => setForm({ open: false, soId: null, moId: null })}
        onSaved={(msg, id) => {
          setMessage(msg)
          setError(null)
          void load()
          setSavedNote(msg)
          setViewId(id)
        }}
      />
      <ManufacturingOrderDetailDialog
        moId={viewId}
        notice={savedNote}
        onClose={() => {
          setViewId(null)
          setSavedNote(null)
        }}
        onEdit={(id) => {
          setViewId(null)
          setSavedNote(null)
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
