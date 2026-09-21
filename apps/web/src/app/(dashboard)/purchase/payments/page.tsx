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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-semibold">Supplier payments</h1>
          <p className="text-muted-foreground text-sm">
            What is owed, and what has been paid against it.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {message && (
        <div className="rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-sm text-teal-300">
          {message}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
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

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-white/10 p-0.5">
          {(['outstanding', 'history'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                tab === t
                  ? 'bg-white/10 text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'outstanding' ? 'Outstanding' : 'Payments made'}
            </button>
          ))}
        </div>

        <div className="relative min-w-[200px] flex-1">
          <Search
            size={15}
            className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
          />
          <input
            className="form-input h-9 pl-9"
            placeholder={
              tab === 'outstanding'
                ? 'Supplier, our bill number, or theirs'
                : 'Supplier, payment number, bill, or reference'
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <div className="glass-card text-muted-foreground p-8 text-center text-sm">Loading…</div>
      ) : tab === 'outstanding' ? (
        visibleBills.length === 0 ? (
          <div className="glass-card p-8 text-center">
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
          <div className="glass-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left">
                  <th className="text-muted-foreground p-3 font-medium">Supplier</th>
                  <th className="text-muted-foreground p-3 font-medium">Bill</th>
                  <th className="text-muted-foreground p-3 font-medium">Due</th>
                  <th className="text-muted-foreground p-3 text-right font-medium">Bill total</th>
                  <th className="text-muted-foreground p-3 text-right font-medium">Paid</th>
                  <th className="text-muted-foreground p-3 text-right font-medium">Outstanding</th>
                  <th className="text-muted-foreground p-3 font-medium">Ageing</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {visibleBills.map((b) => (
                  <tr key={b.id} className="border-b border-white/5 last:border-0">
                    <td className="text-foreground p-3">{b.supplier.name}</td>
                    <td className="p-3">
                      <span className="text-foreground">{b.billNumber}</span>
                      {b.supplierInvoiceNo && (
                        <span className="text-muted-foreground block text-xs">
                          Theirs: {b.supplierInvoiceNo}
                        </span>
                      )}
                    </td>
                    <td className="text-muted-foreground p-3">
                      {b.dueDate ? formatDate(b.dueDate) : '—'}
                    </td>
                    <td className="text-muted-foreground p-3 text-right">
                      ₹{money(b.totalAmount)}
                    </td>
                    <td className="text-muted-foreground p-3 text-right">
                      ₹{money(b.paidAmount)}
                    </td>
                    <td className="text-foreground p-3 text-right font-medium">
                      ₹{money(b.balanceAmount)}
                    </td>
                    <td className="p-3">
                      <span className={bucketClass(b.bucket)}>
                        {b.bucket}
                        {b.daysOverdue > 0 ? ` · ${b.daysOverdue}d` : ''}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        className="btn-primary h-8 px-3 text-xs"
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
        )
      ) : visiblePayments.length === 0 ? (
        <div className="glass-card p-8 text-center">
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
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left">
                <th className="text-muted-foreground p-3 font-medium">Payment</th>
                <th className="text-muted-foreground p-3 font-medium">Date</th>
                <th className="text-muted-foreground p-3 font-medium">Supplier</th>
                <th className="text-muted-foreground p-3 font-medium">Against</th>
                <th className="text-muted-foreground p-3 font-medium">How</th>
                <th className="text-muted-foreground p-3 text-right font-medium">Amount</th>
                <th className="text-muted-foreground p-3 font-medium">Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {visiblePayments.map((p) => (
                <tr key={p.id} className="border-b border-white/5 last:border-0">
                  <td className="text-foreground p-3">{p.paymentNumber}</td>
                  <td className="text-muted-foreground p-3">{formatDate(p.paymentDate)}</td>
                  <td className="text-foreground p-3">{p.supplier.name}</td>
                  <td className="text-muted-foreground p-3">{p.invoice?.billNumber ?? '—'}</td>
                  <td className="p-3">
                    <span className="text-foreground">{MODE_LABEL[p.mode] ?? p.mode}</span>
                    {p.referenceNo && (
                      <span className="text-muted-foreground block text-xs">{p.referenceNo}</span>
                    )}
                  </td>
                  <td className="text-foreground p-3 text-right font-medium">
                    ₹{money(p.amount)}
                  </td>
                  <td className="text-muted-foreground p-3">{p.createdBy?.name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
