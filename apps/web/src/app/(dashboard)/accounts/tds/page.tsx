'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, HandCoins, Landmark, Plus, RefreshCw } from 'lucide-react'
import { api, apiErrorMessage, can } from '@/lib/api'
import { ExportButton } from '@/components/tables/ExportButton'
import { asDate, downloadRows, type ExportColumn, type ExportFormat } from '@/lib/export'
import { amountOrBlank, day, fyStartOf, inr, todayIst } from '@/components/accounts/books'

type Tab = 'deducted' | 'customers'
interface Deducted {
  period: { from: string; to: string }
  sections: Array<{
    ledgerId: string
    ledger: string
    section: string
    opening: number
    deducted: number
    paid: number
    closing: number
    months: Array<{ month: string; deducted: number; paid: number; owing: number; due: string; late: boolean }>
  }>
  deducted: Array<{ date: string; month: string; section: string; party: string; pan: string | null; base: number | null; tds: number; voucherNo: string; voucherId: string; from: string | null }>
  paid: Array<{ date: string; section: string; amount: number; voucherNo: string; voucherId: string }>
  totals: { deducted: number; paid: number; owing: number; late: number }
}
interface Customers {
  rows: Array<{ date: string; customer: string; ledgerId: string | null; pan: string | null; tds: number; voucherNo: string; invoices: string[] }>
  customers: Array<{ customer: string; pan: string | null; tds: number; entries: number }>
  total: number
}

/** The quarters of the financial year a day falls in, as TDS returns are filed. */
function quarters(today: string) {
  const fy = fyStartOf(today)
  const y = Number(fy.slice(0, 4))
  return [
    { label: `Apr–Jun ${y}`, from: `${y}-04-01`, to: `${y}-06-30` },
    { label: `Jul–Sep ${y}`, from: `${y}-07-01`, to: `${y}-09-30` },
    { label: `Oct–Dec ${y}`, from: `${y}-10-01`, to: `${y}-12-31` },
    { label: `Jan–Mar ${y + 1}`, from: `${y + 1}-01-01`, to: `${y + 1}-03-31` },
  ]
}

const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })

/**
 * TDS. What we deducted from suppliers, contractors and brokers, section by
 * section: what each owes the government, which month's TDS is due by when
 * and whether it is late, and every deduction with the party's PAN and what
 * it was deducted on — the details the quarterly 26Q return asks for. And the
 * TDS customers deducted from what they paid us, to check against Form 26AS.
 */
export default function TdsPage() {
  const today = todayIst()
  const qs = quarters(today)
  const [tab, setTab] = useState<Tab>('deducted')
  const [from, setFrom] = useState(fyStartOf(today))
  const [to, setTo] = useState(today)
  const [data, setData] = useState<{ deducted: Deducted; customers: Customers } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData((await api.get<{ data: { deducted: Deducted; customers: Customers } }>(`/accounts/tds?from=${from}&to=${to}`)).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load TDS.'))
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    void load()
  }, [load])

  const exportIt = async (format: ExportFormat) => {
    if (!data) return
    if (tab === 'deducted') {
      type Row = Deducted['deducted'][number]
      const columns: ExportColumn<Row>[] = [
        { header: 'Section', value: (r) => r.section },
        { header: 'Deductee', value: (r) => r.party },
        { header: 'PAN', value: (r) => r.pan ?? '' },
        { header: 'Date of payment or credit', value: (r) => asDate(r.date) },
        { header: 'Amount paid or credited', value: (r) => r.base },
        { header: 'TDS', value: (r) => r.tds },
        { header: 'Rate %', value: (r) => (r.base ? Math.round((r.tds / r.base) * 10000) / 100 : null) },
        { header: 'Voucher', value: (r) => r.voucherNo },
      ]
      await downloadRows({ rows: data.deducted.deducted, columns, name: `tds-deducted-${from}-to-${to}`, sheet: '26Q details', format })
    } else {
      type Row = Customers['rows'][number]
      const columns: ExportColumn<Row>[] = [
        { header: 'Customer', value: (r) => r.customer },
        { header: 'PAN', value: (r) => r.pan ?? '' },
        { header: 'Date', value: (r) => asDate(r.date) },
        { header: 'TDS', value: (r) => r.tds },
        { header: 'Against invoices', value: (r) => r.invoices.join(', ') },
        { header: 'Voucher', value: (r) => r.voucherNo },
      ]
      await downloadRows({ rows: data.customers.rows, columns, name: `tds-by-customers-${from}-to-${to}`, sheet: 'For 26AS', format })
    }
  }

  const d = data?.deducted
  const c = data?.customers

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <div className="min-w-0">
            <h1 className="page-title text-xl sm:text-2xl">TDS</h1>
            <p className="page-subtitle hidden sm:block">What we deducted and owe the government, and what customers deducted from us</p>
          </div>
          <div className="border-border bg-secondary flex rounded-lg border p-1" role="tablist">
            {(
              [
                { key: 'deducted', label: 'Deducted by us', icon: Landmark },
                { key: 'customers', label: 'Deducted from us', icon: HandCoins },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${tab === t.key ? 'bg-card text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <ExportButton onExport={exportIt} disabled={loading || !data} />
          {tab === 'deducted' && can('accounts', 'create') && (
            <Link href="/accounts/vouchers?new=PAYMENT" className="btn-primary">
              <Plus size={15} /> <span className="hidden sm:inline">Pay TDS in</span>
            </Link>
          )}
        </div>
      </div>

      <div className="glass-card flex flex-wrap items-center gap-2 p-3">
        <input type="date" className="form-input h-9 w-[150px]" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <span className="text-muted-foreground text-xs">to</span>
        <input type="date" className="form-input h-9 w-[150px]" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value || today)} aria-label="To" />
        <div className="flex flex-wrap gap-1">
          {qs.map((q) => (
            <button
              key={q.label}
              type="button"
              className={`btn-ghost h-8 px-2 text-xs ${from === q.from && to === (q.to > today ? today : q.to) ? 'bg-primary/10 text-primary' : ''}`}
              disabled={q.from > today}
              onClick={() => {
                setFrom(q.from)
                setTo(q.to > today ? today : q.to)
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}
      {loading && !data && <div className="skeleton h-48 w-full rounded-xl" />}

      {tab === 'deducted' && d && (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              { label: 'Deducted in the period', value: d.totals.deducted, tone: 'text-foreground' },
              { label: 'Paid in to the government', value: d.totals.paid, tone: 'text-foreground' },
              { label: 'Owed now', value: d.totals.owing, tone: 'text-foreground' },
              { label: 'Late — past its due date', value: d.totals.late, tone: d.totals.late > 0 ? 'text-destructive' : 'text-muted-foreground' },
            ].map((x) => (
              <div key={x.label} className="glass-card p-3">
                <p className="text-muted-foreground text-[11px]">{x.label}</p>
                <p className={`mt-0.5 text-lg font-semibold tabular-nums ${x.tone}`}>₹{inr(x.value)}</p>
              </div>
            ))}
          </div>
          {d.sections.length === 0 ? (
            <p className="text-muted-foreground text-sm">No TDS deducted or paid in from {day(from)} to {day(to)}.</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {d.sections.map((s) => (
                <div key={s.ledgerId} className="glass-card overflow-hidden p-0">
                  <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-2.5">
                    <Link href={`/accounts/ledger?id=${s.ledgerId}&from=${from}&to=${to}`} className="text-primary text-sm font-semibold hover:underline">
                      {s.section === 'Not said' ? s.ledger : `Section ${s.section}`}
                    </Link>
                    <span className="text-muted-foreground text-xs tabular-nums">owes ₹{inr(s.closing)}</span>
                  </div>
                  <table className="data-table table-compact w-full">
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th className="text-right">Deducted</th>
                        <th className="text-right">Paid in</th>
                        <th className="text-right">Owing</th>
                        <th>Due by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.months.map((m) => (
                        <tr key={m.month}>
                          <td>{monthName(m.month)}</td>
                          <td className="text-right tabular-nums">{inr(m.deducted)}</td>
                          <td className="text-right tabular-nums">{amountOrBlank(m.paid)}</td>
                          <td className={`text-right tabular-nums ${m.late ? 'text-destructive font-medium' : ''}`}>{amountOrBlank(m.owing)}</td>
                          <td className="whitespace-nowrap">
                            {day(m.due)}
                            {m.late && <span className="badge-danger ml-1.5">Late</span>}
                            {!m.late && m.owing === 0 && <span className="badge-success ml-1.5">Paid</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
          {d.deducted.length > 0 && (
            <div className="glass-card overflow-hidden p-0">
              <p className="border-border text-foreground border-b px-4 py-2.5 text-sm font-semibold">Every deduction — the details for 26Q</p>
              <div className="overflow-x-auto">
                <table className="data-table table-compact w-full min-w-[820px]">
                  <thead>
                    <tr>
                      <th className="w-28">Date</th>
                      <th>Deductee</th>
                      <th className="w-28">PAN</th>
                      <th className="w-20">Section</th>
                      <th className="w-32 text-right">Paid or credited</th>
                      <th className="w-28 text-right">TDS</th>
                      <th className="w-32">Voucher</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.deducted.map((r, i) => (
                      <tr key={`${r.voucherId}-${i}`}>
                        <td className="whitespace-nowrap tabular-nums">{day(r.date)}</td>
                        <td>{r.party}</td>
                        <td className={`font-mono text-xs ${r.pan ? '' : 'text-destructive'}`}>{r.pan ?? 'No PAN'}</td>
                        <td>{r.section}</td>
                        <td className="text-right tabular-nums">{r.base ? inr(r.base) : ''}</td>
                        <td className="text-right tabular-nums">{inr(r.tds)}</td>
                        <td>
                          <Link href={`/accounts/vouchers?open=${r.voucherId}`} className="text-primary font-mono text-xs hover:underline">
                            {r.voucherNo}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            TDS is paid in with an Accounts Payment voucher: debit the section&apos;s TDS Payable ledger, credit the bank. A month&apos;s TDS is due by the 7th of the next month (30 April for March); paying in clears the oldest month first.
          </p>
        </>
      )}

      {tab === 'customers' && c && (
        <>
          <div className="glass-card p-3">
            <p className="text-muted-foreground text-[11px]">Deducted by customers, {day(from)} to {day(to)}</p>
            <p className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">₹{inr(c.total)}</p>
          </div>
          {c.customers.length === 0 ? (
            <p className="text-muted-foreground text-sm">No customer deducted TDS in this period.</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-[360px_1fr]">
              <div className="glass-card overflow-hidden p-0">
                <table className="data-table table-compact w-full">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th className="text-right">TDS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.customers.map((x) => (
                      <tr key={x.customer}>
                        <td>
                          {x.customer}
                          <span className="text-muted-foreground block font-mono text-[11px]">{x.pan ?? 'No PAN'}</span>
                        </td>
                        <td className="text-right tabular-nums">{inr(x.tds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="glass-card overflow-hidden p-0">
                <table className="data-table table-compact w-full">
                  <thead>
                    <tr>
                      <th className="w-28">Date</th>
                      <th>Customer</th>
                      <th>Against</th>
                      <th className="text-right">TDS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.rows.map((r, i) => (
                      <tr key={`${r.voucherNo}-${i}`}>
                        <td className="whitespace-nowrap tabular-nums">{day(r.date)}</td>
                        <td>{r.customer}</td>
                        <td className="text-muted-foreground font-mono text-xs">{r.invoices.join(', ') || r.voucherNo}</td>
                        <td className="text-right tabular-nums">{inr(r.tds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="text-muted-foreground text-xs">Set this against the customer-wise TDS in Form 26AS (or the AIS) for the same quarter; a customer missing there has not paid in what they deducted.</p>
        </>
      )}
    </div>
  )
}
