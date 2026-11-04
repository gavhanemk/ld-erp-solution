'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Landmark, Plus, RefreshCw, Wallet } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { VoucherDialog } from '@/components/accounts/VoucherDialog'
import { amountOrBlank, day, drCr, inr, reportStart, todayIst, type BooksSummary, type ManualKind } from '@/components/accounts/books'

interface MoneyRow {
  id: string
  name: string
  group: string
  systemKey: string | null
  opening: number
  dr: number
  cr: number
  closing: number
  bank: { accountNumber: string; ifscCode: string; accountType: string } | null
}

/**
 * Cash and bank: what is in hand and in each account on a day, with what
 * came in and went out since the start of the period. Each row opens its
 * book — the cash book for cash, the bank book for a bank.
 */
export default function CashBankPage() {
  const [summary, setSummary] = useState<BooksSummary | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayIst())
  const [rows, setRows] = useState<MoneyRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<{ open: boolean; kind: ManualKind }>({ open: false, kind: 'CONTRA' })

  useEffect(() => {
    api
      .get<{ data: BooksSummary }>('/accounts/summary')
      .then((r) => {
        setSummary(r.data)
        setFrom(reportStart(r.data))
      })
      .catch((err) => setError(apiErrorMessage(err, 'Could not load the books.')))
  }, [])

  const load = useCallback(async () => {
    if (!from) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ data: { rows: MoneyRow[]; total: number } }>(`/accounts/cash-bank?from=${from}&to=${to}`)
      setRows(res.data.rows)
      setTotal(res.data.total)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load cash and bank.'))
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    void load()
  }, [load])

  const mayCreate = can('accounts', 'create') && !!summary?.booksStart

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Cash &amp; Bank</h1>
          <p className="page-subtitle hidden sm:block">What is in hand and in each bank, and the book behind each</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          {mayCreate && (
            <>
              <button className="btn-secondary" onClick={() => setForm({ open: true, kind: 'CONTRA' })}>
                <Plus size={15} /> <span className="hidden sm:inline">Contra</span>
              </button>
              <button className="btn-secondary" onClick={() => setForm({ open: true, kind: 'RECEIPT' })}>
                <Plus size={15} /> <span className="hidden sm:inline">Receipt</span>
              </button>
              <button className="btn-primary" onClick={() => setForm({ open: true, kind: 'PAYMENT' })} data-hotkey="new" aria-keyshortcuts="Alt+N">
                <Plus size={15} /> <span className="hidden sm:inline">Payment</span>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="glass-card flex flex-wrap items-center gap-2 p-3">
        <input type="date" className="form-input h-9 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <span className="text-muted-foreground text-xs">to</span>
        <input type="date" className="form-input h-9 w-[150px]" value={to} min={from} onChange={(e) => setTo(e.target.value || todayIst())} aria-label="To" />
        <p className="text-muted-foreground ml-auto text-sm">
          In hand and at the bank on {day(to)}: <span className="text-foreground font-semibold tabular-nums">{drCr(total)}</span>
        </p>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      <div className="glass-card overflow-hidden p-0">
        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table table-totals w-full">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="w-40 text-right">Opening</th>
                  <th className="w-36 text-right">In ₹</th>
                  <th className="w-36 text-right">Out ₹</th>
                  <th className="w-44 text-right">Closing</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} data-row tabIndex={i === 0 ? 0 : -1}>
                    <td>
                      <Link href={`/accounts/ledger?id=${r.id}&from=${from}&to=${to}`} className="flex items-center gap-2" data-row-open>
                        {r.systemKey === 'CASH' ? <Wallet size={15} className="text-muted-foreground" /> : <Landmark size={15} className="text-muted-foreground" />}
                        <span>
                          <span className="text-primary hover:underline">{r.name}</span>
                          <span className="text-muted-foreground block text-[11px]">
                            {r.group}
                            {r.bank?.ifscCode ? ` · ${r.bank.ifscCode}` : ''}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="text-right tabular-nums">{drCr(r.opening)}</td>
                    <td className="text-right tabular-nums">{amountOrBlank(r.dr)}</td>
                    <td className="text-right tabular-nums">{amountOrBlank(r.cr)}</td>
                    <td className={`text-right font-semibold tabular-nums ${r.closing < 0 && r.systemKey === 'CASH' ? 'text-destructive' : ''}`}>{drCr(r.closing)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="font-semibold">Total</td>
                  <td className="text-right font-semibold tabular-nums">{drCr(rows.reduce((t, r) => t + r.opening, 0))}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(rows.reduce((t, r) => t + r.dr, 0))}</td>
                  <td className="text-right font-semibold tabular-nums">{inr(rows.reduce((t, r) => t + r.cr, 0))}</td>
                  <td className="text-right font-semibold tabular-nums">{drCr(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      <p className="text-muted-foreground text-xs">A cash balance on the credit side is money paid out that the books never saw come in: check for a missing receipt or contra.</p>

      <VoucherDialog
        open={form.open}
        kind={form.kind}
        booksStart={summary?.booksStart ?? null}
        onClose={() => setForm((f) => ({ ...f, open: false }))}
        onSaved={() => void load()}
      />
    </div>
  )
}
