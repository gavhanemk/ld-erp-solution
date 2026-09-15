'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Pencil, Printer, Search, RefreshCw, AlertCircle, Ban } from 'lucide-react'
import { api, ApiError, type Paginated } from '@/lib/api'
import { PurchaseBillDialog, type PurchaseBill } from '@/components/purchase/PurchaseBillDialog'
import { Pagination } from '@/components/tables/Pagination'
import { useAppSettings } from '@/lib/appSettings'
import { formatDate } from '@/lib/utils'

const STATUS: Record<string, { label: string; cls: string }> = {
  UNPAID: { label: 'Unpaid', cls: 'badge-warning' },
  PARTIAL: { label: 'Part paid', cls: 'badge-info' },
  PAID: { label: 'Paid', cls: 'badge-success' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-neutral' },
}

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function PurchaseBillsPage() {
  const { rowsPerPage } = useAppSettings()

  const [rows, setRows] = useState<PurchaseBill[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<{ open: boolean; record: PurchaseBill | null }>({
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
      if (overdueOnly) qs.set('overdue', 'true')
      const res = await api.get<Paginated<PurchaseBill>>(`/purchase/bills?${qs}`)
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing purchase bills.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [debounced, status, overdueOnly, page, rowsPerPage])

  useEffect(() => {
    void load()
  }, [load])

  // Narrowing a filter while on page 3 would show an empty page 3 of a shorter
  // list, which reads as "nothing found" rather than "you moved".
  useEffect(() => {
    setPage(1)
  }, [debounced, status, overdueOnly])

  const cancel = async (bill: PurchaseBill) => {
    const reason = prompt(
      `Cancel ${bill.billNumber}?\n\nThe bill and its number stay on the record. Say why:`,
    )
    if (reason === null) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await api.patch<{ message?: string }>(`/purchase/bills/${bill.id}/cancel`, {
        reason: reason.trim() || undefined,
      })
      await load()
      if (res.message) setMessage(res.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel that bill.')
    } finally {
      setBusy(false)
    }
  }

  const pages = Math.ceil(total / rowsPerPage) || 1

  const isOverdue = (b: PurchaseBill) =>
    b.dueDate != null &&
    new Date(b.dueDate) < new Date() &&
    (b.status === 'UNPAID' || b.status === 'PARTIAL')

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Purchase Bills</h1>
          <p className="page-subtitle">What your suppliers have charged you, and what is still owed</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button className="btn-primary" onClick={() => setDialog({ open: true, record: null })}>
            <Plus size={15} /> Book Bill
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
              placeholder="Search our number, theirs, or supplier..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search purchase bills"
            />
          </div>
          <select
            className="form-input h-9 w-40"
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
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(e) => setOverdueOnly(e.target.checked)}
            />
            Overdue only
          </label>
          <span className="text-xs text-muted-foreground ml-auto">{total} bills</span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">Loading...</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {debounced || status || overdueOnly
                ? 'No bills match what you are looking for. Clear the filters to see them all.'
                : 'No supplier bills booked yet. Book one to record what a supplier has charged you — start from a goods receipt and it fills itself in.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Our ref</th>
                  <th>Their invoice</th>
                  <th>Supplier</th>
                  <th>Booked</th>
                  <th>Due</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Outstanding</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((bill) => {
                  const s = STATUS[bill.status] ?? { label: bill.status, cls: 'badge-neutral' }
                  const overdue = isOverdue(bill)
                  return (
                    <tr key={bill.id}>
                      <td className="font-mono text-xs text-teal-400">{bill.billNumber}</td>
                      <td>
                        {bill.supplierInvoiceNo ? (
                          <>
                            <div className="font-mono text-xs text-foreground">
                              {bill.supplierInvoiceNo}
                            </div>
                            {bill.supplierInvoiceDate && (
                              <div className="text-[10px] text-muted-foreground">
                                {formatDate(bill.supplierInvoiceDate)}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td>
                        <div className="font-medium text-foreground">{bill.supplier?.name}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {bill.supplier?.gstin && (
                            <span className="text-[10px] text-muted-foreground font-mono">
                              {bill.supplier.gstin}
                            </span>
                          )}
                          {bill.isReverseCharge && <span className="badge-purple">RCM</span>}
                        </div>
                      </td>
                      <td className="text-xs">{formatDate(bill.billDate)}</td>
                      <td className="text-xs">
                        {bill.dueDate ? (
                          <span className={overdue ? 'text-red-400 font-medium' : undefined}>
                            {formatDate(bill.dueDate)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="text-right font-semibold tabular-nums">
                        ₹{money(bill.totalAmount)}
                      </td>
                      <td className="text-right tabular-nums">
                        {bill.status === 'CANCELLED' ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            ₹{money(bill.balanceAmount)}
                            {Number(bill.tdsAmount) > 0 && (
                              <div className="text-[10px] text-muted-foreground">
                                after ₹{money(bill.tdsAmount)} TDS
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        <span className={s.cls}>{s.label}</span>
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <div className="flex justify-end gap-1">
                          <Link
                            href={`/print/purchase-bill/${bill.id}`}
                            target="_blank"
                            className="btn-ghost p-1.5"
                            title="Print"
                            aria-label={`Print ${bill.billNumber}`}
                          >
                            <Printer size={15} />
                          </Link>
                          {bill.status !== 'CANCELLED' && Number(bill.paidAmount) === 0 && (
                            <>
                              <button
                                className="btn-ghost p-1.5"
                                onClick={() => setDialog({ open: true, record: bill })}
                                title="Edit"
                                aria-label={`Edit ${bill.billNumber}`}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                className="btn-ghost p-1.5 text-muted-foreground hover:text-red-400"
                                onClick={() => void cancel(bill)}
                                disabled={busy}
                                title="Cancel"
                                aria-label={`Cancel ${bill.billNumber}`}
                              >
                                <Ban size={15} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination page={page} pages={pages} onPageChange={setPage} busy={loading} />
      </div>

      <p className="text-xs text-muted-foreground">
        A bill can be changed until a payment is made against it. After that it is part of the payment
        record — cancel it, or raise a debit note. A bill for more than was accepted at the gate is
        refused, which is the whole point of booking it against the receipt.
      </p>

      <PurchaseBillDialog
        open={dialog.open}
        record={dialog.record}
        onClose={() => setDialog({ open: false, record: null })}
        onSaved={() => void load()}
      />
    </div>
  )
}
