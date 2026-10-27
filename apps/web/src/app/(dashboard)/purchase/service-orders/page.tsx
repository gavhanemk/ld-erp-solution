'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Pencil,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { api, ApiError, masterResource, type Paginated } from '@/lib/api'
import { PurchaseOrderDialog, type PurchaseOrder } from '@/components/purchase/PurchaseOrderDialog'
import { PurchaseBillDialog } from '@/components/purchase/PurchaseBillDialog'
import { Pagination } from '@/components/tables/Pagination'
import { ExportButton } from '@/components/tables/ExportButton'
import { ActionMenu, type RowAction } from '@/components/tables/ActionMenu'
import { RowPanel } from '@/components/tables/RowPanel'
import { asDate, asNumber, downloadRows, fetchEveryPage, type ExportColumn, type ExportFormat } from '@/lib/export'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Purchase → Services & Expenses → Service Purchase Orders.
 *
 * The old ERP's "Service Purchase Order": labour, job charges, a repair,
 * ordered from a supplier at an agreed rate. Nothing arrives at the gate, so
 * there is no goods receipt — the supplier's bill is booked straight from the
 * order, and what is billed is what counts as done.
 */

/** The order's progress, in service words: billed rather than received. */
const STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  SENT: { label: 'Open', cls: 'badge-info' },
  PARTIALLY_RECEIVED: { label: 'Part billed', cls: 'badge-warning' },
  COMPLETED: { label: 'Billed', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const qty = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })

/** What is still to be billed, before GST: open quantity at the order's rate. */
const leftToBill = (po: PurchaseOrder) =>
  (po.lines ?? []).reduce(
    (s, l) => s + (l.shortClosed ? 0 : Number(l.pendingQty ?? 0)) * Number(l.unitRate ?? 0),
    0
  )

const billable = (po: PurchaseOrder) => po.status === 'SENT' || po.status === 'PARTIALLY_RECEIVED'

export default function ServiceOrdersPage() {
  const { rowsPerPage } = useAppSettings()

  const [rows, setRows] = useState<PurchaseOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])

  const [dialog, setDialog] = useState<{ open: boolean; record: PurchaseOrder | null }>({
    open: false,
    record: null,
  })
  /** The order a bill is being booked from. */
  const [billing, setBilling] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    masterResource<{ id: string; name: string }>('suppliers')
      .list({ limit: 500 })
      .then((r) => setSuppliers([...r.data].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {
        // The filter comes up empty; the list still works.
      })
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const query = (p: number, limit: number) => {
    const qs = new URLSearchParams({ page: String(p), limit: String(limit), service: 'true' })
    if (debounced) qs.set('q', debounced)
    if (status) qs.set('status', status)
    if (supplierId) qs.set('supplierId', supplierId)
    if (fromDate) qs.set('from', fromDate)
    if (toDate) qs.set('to', toDate)
    return `/purchase/orders?${qs}`
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<Paginated<PurchaseOrder>>(query(page, rowsPerPage))
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing purchase orders.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
      setRows([])
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, status, supplierId, fromDate, toDate, page, rowsPerPage])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [debounced, status, supplierId, fromDate, toDate])

  const EXPORT_COLUMNS: ExportColumn<PurchaseOrder>[] = [
    { header: 'Date', value: (po) => asDate(po.poDate) },
    { header: 'Order No.', value: (po) => po.poNumber },
    { header: 'Reference', value: (po) => po.reference ?? '' },
    { header: 'Supplier', value: (po) => po.supplier?.name ?? '' },
    { header: 'Status', value: (po) => STATUS[po.status]?.label ?? po.status },
    { header: 'Amount', value: (po) => asNumber(po.totalAmount) },
    { header: 'Left to Bill (before GST)', value: (po) => asNumber(leftToBill(po)) },
  ]

  const exportList = async (format: ExportFormat) => {
    setError(null)
    try {
      const { rows: all, total, truncated } = await fetchEveryPage<PurchaseOrder>((p) => query(p, 100))
      if (all.length === 0) {
        setMessage('Nothing to export — no service orders match these filters.')
        return
      }
      await downloadRows({
        rows: all,
        columns: EXPORT_COLUMNS,
        name: 'service-purchase-orders',
        sheet: 'Service Orders',
        format,
      })
      setMessage(
        truncated
          ? `Exported the first ${all.length} of ${total} orders. Narrow the filters to get the rest.`
          : `Exported ${all.length} ${all.length === 1 ? 'order' : 'orders'}.`
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the export.')
    }
  }

  const run = async (po: PurchaseOrder, request: () => Promise<{ message?: string }>, fallback: string) => {
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const res = await request()
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  const actions = (po: PurchaseOrder): RowAction[] => {
    const items: RowAction[] = [
      {
        key: 'print',
        label: 'Print order',
        icon: <Printer size={15} />,
        href: `/print/purchase-order/${po.id}`,
        newTab: true,
      },
    ]
    if (billable(po)) {
      items.push({
        key: 'bill',
        label: 'Book the bill',
        icon: <Receipt size={15} />,
        onClick: () => setBilling(po.id),
      })
    }
    // Correctable until a bill is booked against it; the server refuses after.
    if (po.status === 'DRAFT' || po.status === 'SENT') {
      items.push({
        key: 'edit',
        label: 'Edit order',
        icon: <Pencil size={15} />,
        onClick: () => setDialog({ open: true, record: po }),
      })
    }
    if (po.status !== 'CANCELLED' && po.status !== 'COMPLETED') {
      items.push({
        key: 'cancel',
        label: 'Cancel order',
        icon: <Ban size={15} />,
        danger: true,
        onClick: () => {
          if (!confirm(`Cancel ${po.poNumber}?`)) return
          void run(po, () => api.patch(`/purchase/orders/${po.id}/cancel`, {}), 'Could not cancel.')
        },
      })
    }
    if (po.status === 'DRAFT' || po.status === 'SENT' || po.status === 'CANCELLED') {
      items.push({
        key: 'delete',
        label: 'Delete order',
        icon: <Trash2 size={15} />,
        danger: true,
        onClick: () => {
          if (
            !confirm(
              `Delete ${po.poNumber} for good? This is not the same as cancelling — nothing will be left saying it was called off. The number will not be reused.`
            )
          )
            return
          void run(po, () => api.delete(`/purchase/orders/${po.id}`), 'Could not delete.')
        },
      })
    }
    return items
  }

  const pages = Math.ceil(total / rowsPerPage) || 1
  const filtered = Boolean(debounced || status || supplierId || fromDate || toDate)

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Service Purchase Orders</h1>
          <p className="page-subtitle hidden sm:block">
            Labour, job charges and repairs ordered from a supplier — billed when the work is done
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportList} disabled={loading} />
          <button
            className="btn-primary"
            onClick={() => setDialog({ open: true, record: null })}
            aria-label="New service order"
            data-hotkey="new"
            aria-keyshortcuts="Alt+N"
          >
            <Plus size={15} /> <span className="hidden sm:inline">New Service Order</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex flex-col gap-2 sm:contents">
            <div className="border-field-edge bg-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 sm:min-w-[150px] sm:max-w-[190px] sm:basis-0 sm:px-2.5">
              <Search size={14} className="text-muted-foreground hidden shrink-0 sm:block" />
              <input
                className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
                placeholder="Search..."
                title="Reaches the order number and the supplier"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search service orders"
                data-hotkey="search"
              />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="From date"
              />
              <span className="text-muted-foreground hidden text-xs sm:inline">to</span>
              <input
                type="date"
                className="form-input h-8 min-w-0 flex-1 px-1 py-0 text-[10px] sm:w-[7.75rem] sm:flex-none sm:px-3 sm:text-xs"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="To date"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 sm:contents">
            <SmartSelect
              className="form-input h-8 min-w-0 flex-1 px-1.5 py-0 text-[11px] sm:w-36 sm:flex-none sm:px-3 sm:text-xs"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              aria-label="Filter by supplier"
            >
              <option value="">All suppliers</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SmartSelect>
            <SmartSelect
              className="form-input h-8 min-w-0 flex-1 px-1.5 py-0 text-[11px] sm:w-32 sm:flex-none sm:px-3 sm:text-xs"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {Object.entries(STATUS).map(([v, s]) => (
                <option key={v} value={v}>
                  {s.label}
                </option>
              ))}
            </SmartSelect>
            {filtered && (
              <button
                className="btn-ghost h-8 shrink-0 px-2 text-xs"
                onClick={() => {
                  setSearch('')
                  setStatus('')
                  setSupplierId('')
                  setFromDate('')
                  setToDate('')
                }}
              >
                Clear
              </button>
            )}
            <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
              {total} {total === 1 ? 'order' : 'orders'}
            </span>
          </div>
        </div>

        {loading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-muted-foreground text-sm">
              {filtered
                ? 'No service orders match what you are looking for. Clear the filters to see them all.'
                : 'No service orders yet. Raise one for labour, job charges or a repair, then book the supplier’s bill straight from it.'}
            </p>
          </div>
        ) : (
          <div className="list-scope">
            <div className="list-cards divide-border divide-y">
              {rows.map((po) => {
                const s = STATUS[po.status] ?? { label: po.status, cls: 'badge-neutral' }
                return (
                  <div key={po.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-teal-400">{po.poNumber}</span>
                          <span className={s.cls}>{s.label}</span>
                        </div>
                        <p className="text-foreground mt-1 font-medium">{po.supplier?.name ?? '—'}</p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {formatDate(po.poDate)}
                          {po.reference ? ` · ${po.reference}` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-foreground font-semibold tabular-nums">₹{money(po.totalAmount)}</p>
                        {billable(po) && (
                          <p className="text-muted-foreground text-[11px] tabular-nums">
                            ₹{money(leftToBill(po))} to bill
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center justify-end gap-2">
                      {billable(po) && (
                        <button className="btn-secondary h-8 px-2.5 text-xs" onClick={() => setBilling(po.id)}>
                          <Receipt size={14} /> Book bill
                        </button>
                      )}
                      <ActionMenu label={`Actions for ${po.poNumber}`} items={actions(po)} />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="list-rows w-full">
              <table className="data-table w-full">
                <thead>
                  <tr className="bg-secondary">
                    <th style={{ width: 30 }} />
                    <th>Date</th>
                    <th>Order No.</th>
                    <th className="col-wide">Reference</th>
                    <th>Supplier</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th className="col-roomy" style={{ textAlign: 'right' }}>
                      Left to bill
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((po, ri) => {
                    const s = STATUS[po.status] ?? { label: po.status, cls: 'badge-neutral' }
                    const open = expanded === po.id
                    const lines = po.lines ?? []
                    return (
                      <Fragment key={po.id}>
                        <tr data-row tabIndex={ri === 0 ? 0 : -1}>
                          <td>
                            <button
                              className="bg-primary/10 text-primary hover:bg-primary/20 flex h-7 w-7 items-center justify-center rounded-lg"
                              onClick={() => setExpanded(open ? null : po.id)}
                              aria-label={`${open ? 'Hide' : 'Show'} lines on ${po.poNumber}`}
                              aria-expanded={open}
                              data-row-open
                            >
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td className="whitespace-nowrap text-xs">{formatDate(po.poDate)}</td>
                          <td className="whitespace-nowrap font-mono text-xs">
                            <Link
                              href={`/print/purchase-order/${po.id}`}
                              target="_blank"
                              className="text-teal-400 underline-offset-2 hover:underline"
                            >
                              {po.poNumber}
                            </Link>
                          </td>
                          <td className="col-wide text-xs">
                            {po.reference || <span className="text-muted-foreground">—</span>}
                          </td>
                          <td>
                            <div className="text-foreground max-w-[15rem] truncate font-medium">{po.supplier?.name}</div>
                          </td>
                          <td>
                            <span className={s.cls}>{s.label}</span>
                          </td>
                          <td className="whitespace-nowrap text-right font-semibold tabular-nums">
                            ₹{money(po.totalAmount)}
                          </td>
                          <td className="col-roomy whitespace-nowrap text-right tabular-nums">
                            {billable(po) ? `₹${money(leftToBill(po))}` : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="whitespace-nowrap text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {billable(po) && (
                                <button
                                  className="btn-secondary h-7 px-2 text-xs"
                                  onClick={() => setBilling(po.id)}
                                  title="Book the supplier's bill for this order"
                                >
                                  <Receipt size={13} /> Book bill
                                </button>
                              )}
                              <ActionMenu label={`Actions for ${po.poNumber}`} items={actions(po)} />
                            </div>
                          </td>
                        </tr>
                        {open && lines.length > 0 && (
                          <tr>
                            <td colSpan={9} className="bg-secondary/40 !px-2 !pb-2 !pt-0">
                              <RowPanel
                                icon={ClipboardList}
                                title="Order Lines"
                                note={`${lines.length} ${lines.length === 1 ? 'line' : 'lines'} on ${po.poNumber}`}
                              >
                                <table className="subtable w-full">
                                  <thead>
                                    <tr>
                                      <th>Expense head</th>
                                      <th>Description</th>
                                      <th style={{ textAlign: 'right' }}>Ordered</th>
                                      <th style={{ textAlign: 'right' }}>Billed</th>
                                      <th style={{ textAlign: 'right' }}>Left</th>
                                      <th style={{ textAlign: 'right' }}>Rate</th>
                                      <th style={{ textAlign: 'right' }}>Amount</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {lines.map((l, i) => (
                                      <tr key={l.id ?? i}>
                                        <td>{l.item?.name ?? '—'}</td>
                                        <td className="text-muted-foreground">{l.description || '—'}</td>
                                        <td style={{ textAlign: 'right' }} className="tabular-nums">
                                          {qty(l.qty)}
                                        </td>
                                        <td style={{ textAlign: 'right' }} className="tabular-nums">
                                          {qty(l.receivedQty)}
                                        </td>
                                        <td style={{ textAlign: 'right' }} className="tabular-nums">
                                          {l.shortClosed ? 'closed' : qty(l.pendingQty)}
                                        </td>
                                        <td style={{ textAlign: 'right' }} className="tabular-nums">
                                          {money(l.unitRate ?? 0)}
                                        </td>
                                        <td style={{ textAlign: 'right' }} className="tabular-nums">
                                          {money(Number(l.qty ?? 0) * Number(l.unitRate ?? 0))}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </RowPanel>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading || busy} />
      </div>

      <p className="text-muted-foreground text-xs">
        A service is not received at the gate. Book the supplier’s bill from the order — its lines fill
        in, the TDS is worked out, and the order shows as billed. The bill then sits on Expenses for
        payment.
      </p>

      <PurchaseOrderDialog
        open={dialog.open}
        record={dialog.record}
        service
        onClose={() => setDialog({ open: false, record: null })}
        onSaved={() => void load()}
      />

      <PurchaseBillDialog
        open={billing !== null}
        fromServiceOrder={billing}
        onClose={() => setBilling(null)}
        onSaved={(msg) => {
          setMessage(msg ?? 'Bill booked. It is on Expenses for payment.')
          void load()
        }}
      />
    </div>
  )
}
