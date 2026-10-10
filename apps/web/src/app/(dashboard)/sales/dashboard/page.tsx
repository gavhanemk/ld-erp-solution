'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlarmClock,
  AlertCircle,
  BarChart3,
  CalendarClock,
  FileText,
  HandCoins,
  Package,
  ReceiptText,
  RefreshCw,
  Scale,
  ShieldAlert,
  ShoppingBag,
  Truck,
  Users,
} from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, ApiError } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { ChartTip, DashCard, EmptyChart, KpiTile, PALETTE, TONE, inr } from '@/components/dashboard/DashKit'

interface Dashboard {
  month: {
    booked: { count: number; value: number }
    dispatchedPieces: number
    invoiced: { count: number; value: number; withGst: number }
    received: { count: number; value: number }
  }
  open: { pieces: number; value: number }
  owed: { count: number; value: number }
  overdue: { count: number; value: number }
  trend: Array<{ label: string; booked: number; invoiced: number; received: number }>
  topCustomers: Array<{ name: string; value: number }>
  dueSoon: Array<{ id: string; soNumber: string; customer: string; deliveryDate: string | null; pending: number; late: boolean }>
  overdueInvoices: Array<{ id: string; invoiceNumber: string; customer: string; customerId: string; dueDate: string | null; balance: number; days: number }>
  toAct: { challansToBill: number; quotesOpen: { count: number; value: number }; quotesExpired: number; creditHold: number }
}

const pcs = (n: number) => n.toLocaleString('en-IN')

/**
 * The Sales dashboard: this month at a glance, the six-month picture, and the
 * lists that need someone — orders due in the next two weeks, invoices past
 * their due date, challans gone without an invoice, quotations unanswered.
 * Every tile and list opens the screen behind it.
 */
export default function SalesDashboardPage() {
  const [d, setD] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setD((await api.get<{ data: Dashboard }>('/sales/dashboard')).data)
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 403 ? 'Your role does not allow viewing Sales.' : err.message) : 'Could not reach the server.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const hasTrend = !!d && d.trend.some((t) => t.booked || t.invoiced || t.received)

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Sales Dashboard</h1>
          <p className="page-subtitle hidden sm:block">Orders, dispatch, billing and money in — this month and what needs doing</p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
          <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {!d ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile icon={ShoppingBag} tone={TONE.teal} label="Booked this month" value={inr(d.month.booked.value)} sub={`${d.month.booked.count} orders, before GST`} href="/sales/orders" />
            <KpiTile icon={Truck} tone={TONE.blue} label="Dispatched this month" value={`${pcs(d.month.dispatchedPieces)} pcs`} sub="on challans" href="/sales/challan?tab=challans" />
            <KpiTile icon={ReceiptText} tone={TONE.violet} label="Invoiced this month" value={inr(d.month.invoiced.value)} sub={`${d.month.invoiced.count} invoices · ${inr(d.month.invoiced.withGst)} with GST`} href="/sales/invoices?tab=invoices" />
            <KpiTile icon={HandCoins} tone={TONE.emerald} label="Received this month" value={inr(d.month.received.value)} sub={`${d.month.received.count} receipts`} href="/sales/payments?tab=receipts" />
            <KpiTile icon={Package} tone={TONE.sky} label="Still to send" value={`${pcs(d.open.pieces)} pcs`} sub={`${inr(d.open.value)} on open orders`} href="/sales/challan" />
            <KpiTile icon={Scale} tone={TONE.amber} label="Owed by customers" value={inr(d.owed.value)} sub={`${d.owed.count} open invoices`} href="/sales/payments" />
            <KpiTile
              icon={AlarmClock}
              tone={TONE.rose}
              label="Overdue"
              value={inr(d.overdue.value)}
              valueClass={d.overdue.value > 0 ? 'text-destructive' : 'text-foreground'}
              sub={d.overdue.count ? `${d.overdue.count} invoices past due` : 'nothing late'}
              href="/sales/payments"
            />
            <KpiTile icon={FileText} tone={TONE.orange} label="Quotations open" value={String(d.toAct.quotesOpen.count)} sub={`${inr(d.toAct.quotesOpen.value)}${d.toAct.quotesExpired ? ` · ${d.toAct.quotesExpired} expired` : ''}`} href="/sales/quotations" />
          </div>

          {(d.toAct.challansToBill > 0 || d.toAct.creditHold > 0 || d.toAct.quotesExpired > 0) && (
            <div className="border-border bg-secondary/40 flex flex-wrap gap-x-6 gap-y-2 rounded-xl border px-4 py-3 text-sm">
              {d.toAct.challansToBill > 0 && (
                <a href="/sales/invoices" className="hover:text-primary flex items-center gap-2">
                  <ReceiptText size={15} className="warn-text" /> {d.toAct.challansToBill} challans gone without an invoice
                </a>
              )}
              {d.toAct.creditHold > 0 && (
                <a href="/sales/orders" className="hover:text-primary flex items-center gap-2">
                  <ShieldAlert size={15} className="warn-text" /> {d.toAct.creditHold} orders on credit hold
                </a>
              )}
              {d.toAct.quotesExpired > 0 && (
                <a href="/sales/quotations" className="hover:text-primary flex items-center gap-2">
                  <FileText size={15} className="warn-text" /> {d.toAct.quotesExpired} quotations expired without an answer
                </a>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <DashCard title="Six months" hint="Booked (orders), invoiced (less credit notes), both before GST, and money received" icon={BarChart3} href="/reports" hrefLabel="Reports">
              {hasTrend ? (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={d.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" strokeOpacity={0.12} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v) => inr(Number(v))} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={64} />
                    <Tooltip content={<ChartTip />} cursor={{ fillOpacity: 0.06 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="booked" name="Booked" fill={PALETTE[0]} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="invoiced" name="Invoiced" fill={PALETTE[2]} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="received" name="Received" fill={PALETTE[5]} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart h={260} text="No orders, invoices or receipts in the last six months yet." />
              )}
            </DashCard>
            <DashCard title="Top customers" hint="Invoiced in the last twelve months, before GST" icon={Users} href="/reports" hrefLabel="Sales register">
              {d.topCustomers.length === 0 ? (
                <EmptyChart h={260} text="No invoices in the last year yet." />
              ) : (
                <div className="space-y-2">
                  {d.topCustomers.map((c, i) => {
                    const max = d.topCustomers[0].value || 1
                    return (
                      <div key={c.name}>
                        <div className="flex justify-between gap-2 text-xs">
                          <span className="text-foreground truncate">{c.name}</span>
                          <span className="tabular-nums">{inr(c.value)}</span>
                        </div>
                        <div className="bg-secondary mt-1 h-1.5 rounded-full">
                          <div className="h-1.5 rounded-full" style={{ width: `${Math.max(3, (c.value / max) * 100)}%`, background: PALETTE[i % PALETTE.length] }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </DashCard>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <DashCard title="Due in the next two weeks" hint="Orders with pieces still to send, soonest first" icon={CalendarClock} href="/sales/challan" hrefLabel="Dispatch">
              {d.dueSoon.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing due in the next two weeks.</p>
              ) : (
                <div className="divide-border divide-y text-sm">
                  {d.dueSoon.map((o) => (
                    <a key={o.id} href={`/sales/challan?dispatch=${o.id}`} className="hover:bg-secondary/40 flex items-center justify-between gap-3 px-1 py-2">
                      <span className="min-w-0">
                        <span className="font-mono text-xs">{o.soNumber}</span> <span className="text-foreground">{o.customer}</span>
                      </span>
                      <span className={`shrink-0 text-xs tabular-nums ${o.late ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                        {pcs(o.pending)} pcs · {o.deliveryDate ? formatDate(o.deliveryDate) : '—'}
                        {o.late ? ' · late' : ''}
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </DashCard>
            <DashCard title="Overdue invoices" hint="Past their due date, oldest first" icon={AlarmClock} href="/sales/payments" hrefLabel="Outstanding">
              {d.overdueInvoices.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing overdue.</p>
              ) : (
                <div className="divide-border divide-y text-sm">
                  {d.overdueInvoices.map((i) => (
                    <a key={i.id} href={`/sales/payments?receive=${i.customerId}&invoice=${i.id}`} className="hover:bg-secondary/40 flex items-center justify-between gap-3 px-1 py-2">
                      <span className="min-w-0">
                        <span className="font-mono text-xs">{i.invoiceNumber}</span> <span className="text-foreground">{i.customer}</span>
                      </span>
                      <span className="text-destructive shrink-0 text-xs tabular-nums">
                        {inr(i.balance)} · {i.days} days late
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </DashCard>
          </div>
        </>
      )}
    </div>
  )
}
