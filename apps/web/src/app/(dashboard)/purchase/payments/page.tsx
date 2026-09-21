'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, IndianRupee, RefreshCw, Search } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { RecordPaymentDialog, type PayableBill } from '@/components/purchase/RecordPaymentDialog'
import { formatDate } from '@/lib/utils'

interface OutstandingBill extends PayableBill {
  billDate: string
  dueDate?: string | null
  totalAmount: string | number
  paidAmount: string | number
  status: string
  daysOverdue: number
  bucket: string
}

interface Payment {
  id: string
  paymentNumber: string
  paymentDate: string
  amount: string | number
  mode: string
  referenceNo?: string | null
  chequeDate?: string | null
  supplier: { id: string; name: string }
  invoice?: { id: string; billNumber: string } | null
  createdBy?: { id: string; name: string } | null
}

interface Summary {
  billCount: number
  totalOutstanding: number
  overdueCount: number
  overdueAmount: number
}

const money = (v: string | number) =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const MODE_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CHEQUE: 'Cheque',
  NEFT: 'NEFT',
  RTGS: 'RTGS',
  UPI: 'UPI',
  PDC: 'Post-dated cheque',
}

/** Anything past its date reads red; the rest stays quiet. */
function bucketClass(bucket: string) {
  if (bucket === 'Not yet due') return 'badge-neutral'
  if (bucket === '1-30 days') return 'badge-warning'
  return 'badge-danger'
}

export default function SupplierPaymentsPage() {
  const [tab, setTab] = useState<'outstanding' | 'history'>('outstanding')

  const [bills, setBills] = useState<OutstandingBill[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [paying, setPaying] = useState<OutstandingBill | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'outstanding') {
        const res = await api.get<{ data: OutstandingBill[]; summary: Summary }>(
          '/purchase/payments/outstanding'
        )
        setBills(res.data)
        setSummary(res.summary)
      } else {
        const res = await api.get<{ data: Payment[] }>('/purchase/payments')
        setPayments(res.data)
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing supplier payments.'
            : err.message
          : 'Could not reach the server. Is the API running?'
      )
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    void load()
  }, [load])

  const term = search.trim().toLowerCase()
  const visibleBills = term
    ? bills.filter(
        (b) =>
          b.supplier.name.toLowerCase().includes(term) ||
          b.billNumber.toLowerCase().includes(term) ||
          (b.supplierInvoiceNo ?? '').toLowerCase().includes(term)
      )
    : bills
  const visiblePayments = term
    ? payments.filter(
        (p) =>
          p.supplier.name.toLowerCase().includes(term) ||
          p.paymentNumber.toLowerCase().includes(term) ||
          (p.invoice?.billNumber ?? '').toLowerCase().includes(term) ||
          (p.referenceNo ?? '').toLowerCase().includes(term)
      )
    : payments

  return (
    <div className="space-y-5">
      <div className="page-header flex-wrap gap-3">
        <div>
          <h1 className="page-title">Supplier Payments</h1>
          <p className="page-subtitle">What is owed, and what has been paid against it</p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
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

      {tab === 'outstanding' && summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="glass-card p-3">
            <p className="text-muted-foreground text-xs">Bills outstanding</p>
            <p className="text-foreground mt-1 text-lg font-semibold">{summary.billCount}</p>
          </div>
          <div className="glass-card p-3">
            <p className="text-muted-foreground text-xs">Total outstanding</p>
            <p className="text-foreground mt-1 text-lg font-semibold">
              ₹{money(summary.totalOutstanding)}
            </p>
          </div>
          <div className="glass-card p-3">
            <p className="text-muted-foreground text-xs">Overdue bills</p>
            <p className="mt-1 text-lg font-semibold text-amber-400">{summary.overdueCount}</p>
          </div>
          <div className="glass-card p-3">
            <p className="text-muted-foreground text-xs">Overdue amount</p>
            <p className="mt-1 text-lg font-semibold text-amber-400">
              ₹{money(summary.overdueAmount)}
            </p>
          </div>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        <div className="border-border flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-3 py-2">
          <div className="bg-secondary/60 flex shrink-0 gap-1 rounded-lg p-0.5" role="tablist">
            {(
              [
                ['outstanding', 'Outstanding', bills.length],
                ['history', 'Payments made', payments.length],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  tab === key
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
                <span
                  className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
                    tab === key ? 'bg-primary/20' : 'bg-secondary'
                  }`}
                >
                  {count}
                </span>
              </button>
            ))}
          </div>

          <span className="bg-border hidden h-6 w-px shrink-0 lg:block" />

          <div className="border-border bg-secondary flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 sm:min-w-[150px] sm:max-w-[260px]">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder={
                tab === 'outstanding'
                  ? 'Supplier, our bill number, or theirs...'
                  : 'Supplier, payment number, bill, or reference...'
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
            />
          </div>

          <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
            {tab === 'outstanding'
              ? `${visibleBills.length} ${visibleBills.length === 1 ? 'bill' : 'bills'}`
              : `${visiblePayments.length} ${visiblePayments.length === 1 ? 'payment' : 'payments'}`}
          </span>
        </div>

        {loading ? (
          <p className="text-muted-foreground px-4 py-8 text-sm">Loading...</p>
        ) : tab === 'outstanding' ? (
          visibleBills.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <IndianRupee size={22} className="text-muted-foreground mx-auto" />
              <p className="text-foreground mt-2 text-sm font-medium">
                {bills.length === 0 ? 'Nothing is outstanding' : 'Nothing matches that'}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                {bills.length === 0
                  ? 'Every purchase bill on the system is paid in full.'
                  : 'Try a different supplier or bill number.'}
              </p>
            </div>
          ) : (
            <>
              <div className="divide-border divide-y xl:hidden">
                {visibleBills.map((b) => (
                  <div key={b.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-foreground font-medium leading-snug">
                          {b.supplier.name}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span className="text-foreground font-mono text-xs">
                            {b.billNumber}
                          </span>
                          <span className={bucketClass(b.bucket)}>
                            {b.bucket}
                            {b.daysOverdue > 0 ? ` · ${b.daysOverdue}d` : ''}
                          </span>
                        </div>
                        {b.supplierInvoiceNo && (
                          <p className="text-muted-foreground mt-0.5 text-[10px]">
                            Theirs: {b.supplierInvoiceNo}
                          </p>
                        )}
                      </div>
                      <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">
                        ₹{money(b.balanceAmount)}
                      </span>
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Due</dt>
                      <dd className="text-foreground min-w-0">
                        {b.dueDate ? formatDate(b.dueDate) : <span className="text-muted-foreground">—</span>}
                      </dd>
                      <dt className="text-muted-foreground">Bill total</dt>
                      <dd className="text-foreground min-w-0 tabular-nums">₹{money(b.totalAmount)}</dd>
                      <dt className="text-muted-foreground">Paid</dt>
                      <dd className="text-foreground min-w-0 tabular-nums">₹{money(b.paidAmount)}</dd>
                    </dl>

                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        className="btn-primary h-7 px-2.5 text-xs"
                        onClick={() => setPaying(b)}
                      >
                        Pay
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden w-full overflow-x-auto xl:block">
                <table className="data-table w-full min-w-[900px]">
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th>Bill</th>
                      <th>Due</th>
                      <th style={{ textAlign: 'right' }}>Bill total</th>
                      <th style={{ textAlign: 'right' }}>Paid</th>
                      <th style={{ textAlign: 'right' }}>Outstanding</th>
                      <th>Ageing</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleBills.map((b) => (
                      <tr key={b.id}>
                        <td className="text-foreground">{b.supplier.name}</td>
                        <td>
                          <span className="text-foreground font-mono text-xs">{b.billNumber}</span>
                          {b.supplierInvoiceNo && (
                            <div className="text-muted-foreground text-[10px]">
                              Theirs: {b.supplierInvoiceNo}
                            </div>
                          )}
                        </td>
                        <td className="text-xs">
                          {b.dueDate ? formatDate(b.dueDate) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="text-right tabular-nums">₹{money(b.totalAmount)}</td>
                        <td className="text-right tabular-nums">₹{money(b.paidAmount)}</td>
                        <td className="text-foreground text-right font-medium tabular-nums">
                          ₹{money(b.balanceAmount)}
                        </td>
                        <td>
                          <span className={bucketClass(b.bucket)}>
                            {b.bucket}
                            {b.daysOverdue > 0 ? ` · ${b.daysOverdue}d` : ''}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <button
                            type="button"
                            className="btn-primary h-7 px-2.5 text-xs"
                            onClick={() => setPaying(b)}
                          >
                            Pay
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : visiblePayments.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <IndianRupee size={22} className="text-muted-foreground mx-auto" />
            <p className="text-foreground mt-2 text-sm font-medium">
              {payments.length === 0 ? 'No payments yet' : 'Nothing matches that'}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {payments.length === 0
                ? 'Payments recorded against a purchase bill will appear here.'
                : 'Try a different supplier, bill, or reference.'}
            </p>
          </div>
        ) : (
          <>
            <div className="divide-border divide-y xl:hidden">
              {visiblePayments.map((p) => (
                <div key={p.id} className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-foreground font-mono text-xs font-semibold">
                        {p.paymentNumber}
                      </span>
                      <p className="text-foreground mt-1 font-medium leading-snug">
                        {p.supplier.name}
                      </p>
                    </div>
                    <span className="text-foreground shrink-0 text-right font-semibold tabular-nums">
                      ₹{money(p.amount)}
                    </span>
                  </div>

                  <dl className="mt-2.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Date</dt>
                    <dd className="text-foreground min-w-0">{formatDate(p.paymentDate)}</dd>
                    <dt className="text-muted-foreground">Against</dt>
                    <dd className="text-foreground min-w-0">{p.invoice?.billNumber ?? '—'}</dd>
                    <dt className="text-muted-foreground">How</dt>
                    <dd className="text-foreground min-w-0">
                      {MODE_LABEL[p.mode] ?? p.mode}
                      {p.referenceNo && (
                        <span className="text-muted-foreground"> · {p.referenceNo}</span>
                      )}
                    </dd>
                    <dt className="text-muted-foreground">Recorded by</dt>
                    <dd className="text-foreground min-w-0">{p.createdBy?.name ?? '—'}</dd>
                  </dl>
                </div>
              ))}
            </div>

            <div className="hidden w-full overflow-x-auto xl:block">
              <table className="data-table w-full min-w-[900px]">
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Date</th>
                    <th>Supplier</th>
                    <th>Against</th>
                    <th>How</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>Recorded by</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePayments.map((p) => (
                    <tr key={p.id}>
                      <td className="font-mono text-xs text-teal-400">{p.paymentNumber}</td>
                      <td className="text-xs">{formatDate(p.paymentDate)}</td>
                      <td className="text-foreground">{p.supplier.name}</td>
                      <td className="text-xs">{p.invoice?.billNumber ?? '—'}</td>
                      <td>
                        <span className="text-foreground text-xs">
                          {MODE_LABEL[p.mode] ?? p.mode}
                        </span>
                        {p.referenceNo && (
                          <div className="text-muted-foreground text-[10px]">{p.referenceNo}</div>
                        )}
                      </td>
                      <td className="text-foreground text-right font-medium tabular-nums">
                        ₹{money(p.amount)}
                      </td>
                      <td className="text-xs">{p.createdBy?.name ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {paying && (
        <RecordPaymentDialog
          bill={paying}
          onClose={() => setPaying(null)}
          onSaved={(msg) => {
            setPaying(null)
            setMessage(msg)
            void load()
          }}
        />
      )}
    </div>
  )
}
