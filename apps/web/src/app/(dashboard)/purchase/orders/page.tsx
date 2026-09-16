'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Plus, Pencil, Printer, Search, RefreshCw, AlertCircle, Send, Ban,
  ChevronDown, ChevronRight,
} from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { PurchaseOrderDialog, type PurchaseOrder } from '@/components/purchase/PurchaseOrderDialog'
import { Pagination } from '@/components/tables/Pagination'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'

const STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-neutral' },
  SENT: { label: 'Sent', cls: 'badge-info' },
  PARTIALLY_RECEIVED: { label: 'Part received', cls: 'badge-warning' },
  COMPLETED: { label: 'Completed', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-danger' },
}

export default function PurchaseOrdersPage() {
  const { rowsPerPage } = useAppSettings()

  const [rows, setRows] = useState<PurchaseOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  // Which order has its items open. One at a time, as on the receipt screen.
  const [open, setOpen] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ open: boolean; record: PurchaseOrder | null }>({
    open: false,
    record: null,
  })

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(rowsPerPage) })
      if (debounced) qs.set('q', debounced)
      if (status) qs.set('status', status)
      const res = await api.get<Paginated<PurchaseOrder>>(`/purchase/orders?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing purchase orders.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced, status, page, rowsPerPage])

  useEffect(() => {
    void load()
  }, [load])

  // Narrowing the search while on page 3 would show an empty page 3 of a
  // shorter list, which reads as "nothing found" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [debounced, status])

  const act = async (po: PurchaseOrder, what: 'send' | 'cancel') => {
    if (what === 'cancel' && !confirm(`Cancel ${po.poNumber}?`)) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/purchase/orders/${po.id}/${what}`, {})
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const money = (v: string | number) =>
    Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const pages = Math.ceil(total / rowsPerPage) || 1

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Purchase Orders</h1>
          <p className="page-subtitle">What you have ordered from your suppliers</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-primary" onClick={() => setDialog({ open: true, record: null })}>
            <Plus size={15} /> New Purchase Order
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/5">
          <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {message && (
        <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5">
          <p className="text-sm text-emerald-400">{message}</p>
        </div>
      )}

      <div className="glass-card p-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border flex-1 min-w-[220px] max-w-sm">
            <Search size={14} className="text-muted-foreground" />
            <input
              className="bg-transparent border-0 outline-none text-sm flex-1 text-foreground placeholder:text-muted-foreground"
              placeholder="Search order number or supplier..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search purchase orders"
            />
          </div>
          <select
            className="form-input h-9 w-44"
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
          </select>
          <span className="text-xs text-muted-foreground ml-auto">{total} orders</span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No purchase orders yet. Create one to order fabric, buttons or trims.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full min-w-[1100px]">
              <thead>
                <tr>
                  <th style={{ width: 32 }} />
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Date</th>
                  <th>Enquiry</th>
                  <th>Reference</th>
                  <th>Items</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((po) => {
                  const s = STATUS[po.status] ?? { label: po.status, cls: 'badge-neutral' }
                  const lines = po.lines ?? []
                  const expanded = open === po.id
                  return (
                    <Fragment key={po.id}>
                    <tr>
                      <td>
                        {/* Item code, category and quantity belong to a line, not
                            to the order — a four-item order has four of each — so
                            they open underneath rather than being flattened into
                            a column that could only ever show the first one. */}
                        <button
                          className="btn-ghost p-1"
                          onClick={() => setOpen(expanded ? null : po.id)}
                          disabled={lines.length === 0}
                          title={expanded ? 'Hide items' : 'Show items'}
                          aria-label={`${expanded ? 'Hide' : 'Show'} items on ${po.poNumber}`}
                          aria-expanded={expanded}
                        >
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="font-mono text-xs text-teal-400">{po.poNumber}</td>
                      <td>
                        <div className="font-medium text-foreground">{po.supplier?.name}</div>
                        {po.supplier?.gstin && (
                          <div className="text-[10px] text-muted-foreground font-mono">
                            {po.supplier.gstin}
                          </div>
                        )}
                      </td>
                      <td className="text-xs whitespace-nowrap">{formatDate(po.poDate)}</td>
                      <td className="text-xs">
                        {po.enquiryNo ? (
                          <>
                            <div className="font-mono text-foreground">{po.enquiryNo}</div>
                            {po.enquiryDate && (
                              <div className="text-[10px] text-muted-foreground">
                                {formatDate(po.enquiryDate)}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="text-xs">
                        {po.reference ? (
                          po.reference
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="text-xs whitespace-nowrap">
                        {lines.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            <div className="text-foreground">
                              {lines.length} {lines.length === 1 ? 'item' : 'items'}
                            </div>
                            <div className="text-[10px] text-muted-foreground truncate max-w-[160px]">
                              {lines[0].item?.name}
                              {lines.length > 1 ? ` +${lines.length - 1} more` : ''}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="text-right font-semibold tabular-nums">₹{money(po.totalAmount)}</td>
                      <td>
                        <span className={s.cls}>{s.label}</span>
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <div className="flex justify-end gap-1">
                          <Link
                            href={`/print/purchase-order/${po.id}`}
                            target="_blank"
                            className="btn-ghost p-1.5"
                            title="Print"
                            aria-label={`Print ${po.poNumber}`}
                          >
                            <Printer size={15} />
                          </Link>
                          {po.status === 'DRAFT' && (
                            <>
                              <button
                                className="btn-ghost p-1.5"
                                onClick={() => setDialog({ open: true, record: po })}
                                title="Edit"
                                aria-label={`Edit ${po.poNumber}`}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                className="btn-ghost p-1.5 hover:text-teal-400"
                                onClick={() => void act(po, 'send')}
                                disabled={busy}
                                title="Mark as sent to the supplier"
                                aria-label={`Mark ${po.poNumber} sent`}
                              >
                                <Send size={15} />
                              </button>
                            </>
                          )}
                          {po.status !== 'CANCELLED' && po.status !== 'COMPLETED' && (
                            <button
                              className="btn-ghost p-1.5 text-muted-foreground hover:text-red-400"
                              onClick={() => void act(po, 'cancel')}
                              disabled={busy}
                              title="Cancel"
                              aria-label={`Cancel ${po.poNumber}`}
                            >
                              <Ban size={15} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>

                    {expanded && lines.length > 0 && (
                      <tr>
                        <td colSpan={10} className="bg-secondary/30 p-0">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-border">
                                {['Item code', 'Item', 'Category', 'Subcategory', 'Qty', 'Rate', 'Amount'].map(
                                  (h) => (
                                    <th
                                      key={h}
                                      className={`text-[10px] uppercase tracking-wider text-muted-foreground py-2 px-4 ${
                                        ['Qty', 'Rate', 'Amount'].includes(h) ? 'text-right' : 'text-left'
                                      }`}
                                    >
                                      {h}
                                    </th>
                                  ),
                                )}
                              </tr>
                            </thead>
                            <tbody>
                              {lines.map((line, i) => {
                                // An item is filed under one category, which may
                                // itself sit under a parent. Where it does, the
                                // parent is the category and the item's own is the
                                // subcategory; where it does not, there is no
                                // subcategory to show.
                                const cat = line.item?.category
                                const parent = cat?.parent
                                return (
                                  <tr key={line.itemId + i} className="border-b border-border/40 last:border-0">
                                    <td className="py-2 px-4 font-mono text-xs text-teal-400 whitespace-nowrap">
                                      {line.item?.code ?? '—'}
                                    </td>
                                    <td className="py-2 px-4">
                                      <div className="text-foreground">{line.item?.name ?? '—'}</div>
                                      {line.description && (
                                        <div className="text-[10px] text-muted-foreground">
                                          {line.description}
                                        </div>
                                      )}
                                      {line.item?.hsnCode && (
                                        <div className="text-[10px] text-muted-foreground font-mono">
                                          HSN {line.item.hsnCode}
                                        </div>
                                      )}
                                    </td>
                                    <td className="py-2 px-4 text-xs">
                                      {parent?.name ?? cat?.name ?? (
                                        <span className="text-muted-foreground">—</span>
                                      )}
                                    </td>
                                    <td className="py-2 px-4 text-xs">
                                      {parent ? (
                                        cat?.name
                                      ) : (
                                        <span className="text-muted-foreground">—</span>
                                      )}
                                    </td>
                                    <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">
                                      {Number(line.qty)} {line.item?.uom?.symbol ?? ''}
                                    </td>
                                    <td className="py-2 px-4 text-right tabular-nums">
                                      ₹{money(line.unitRate)}
                                    </td>
                                    <td className="py-2 px-4 text-right tabular-nums font-medium">
                                      ₹{money(line.amount ?? 0)}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />
      </div>

      <p className="text-xs text-muted-foreground">
        An order can be changed while it is a draft. Once it is marked sent, raise a new one instead —
        the supplier is holding the old paper.
      </p>

      <PurchaseOrderDialog
        open={dialog.open}
        record={dialog.record}
        onClose={() => setDialog({ open: false, record: null })}
        onSaved={() => void load()}
      />
    </div>
  )
}
