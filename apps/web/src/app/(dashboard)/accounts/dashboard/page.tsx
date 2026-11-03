'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  BookOpenCheck,
  CalendarCheck,
  FileInput,
  HandCoins,
  Landmark,
  Package,
  Percent,
  RefreshCw,
  Scale,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import { ChartTip, DashCard, EmptyChart, KpiTile, PALETTE, TONE, inr as short } from '@/components/dashboard/DashKit'
import { day, drCr } from '@/components/accounts/books'

interface Dash {
  booksStart: string | null
  lockedUpTo?: string | null
  today: string
  fyStart: string
  money: { cash: number; bank: number; overdraft: number; banks: Array<{ id: string; name: string; balance: number }> }
  receivable: { parties: number; due: number; overdue: number; advance: number; net: number; buckets: Record<string, number>; top: Array<{ ledgerId: string; name: string; net: number; overdue: number }> }
  payable: { parties: number; due: number; overdue: number; advance: number; net: number; dueIn7: number; top: Array<{ ledgerId: string; name: string; net: number; overdue: number }> }
  year: { sales: number; purchases: number; grossProfit: number; netProfit: number; closingStock: number }
  gst: { month: string; due: string; cash: number; tax: number; credit: number } | null
  tds: { owing: number; late: number }
  months: Array<{ month: string; sales: number; purchases: number; moneyIn: number; moneyOut: number }>
  attention: { pending: number; unreconciled: number; openingDifference: number; notClosed: string | null; noPan: string[] }
}

/* Two series a chart, each pair checked for colour-blind separation and contrast in both themes. */
const SALES = PALETTE[0]
const PURCHASES = PALETTE[1]
const MONEY_IN = PALETTE[0]
const MONEY_OUT = PALETTE[2]
const axis = { fontSize: 11, fill: 'currentColor' }
const GRID = { strokeDasharray: '3 3', stroke: 'currentColor', strokeOpacity: 0.15 }
/** Whole rupees, Indian grouping: an accountant wants the figure, not 12.5 L. */
const inr = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`
const monthShort = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })
const monthLong = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const legendText = (v: string) => <span className="text-muted-foreground text-xs">{v}</span>

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Two measures a month, side by side on one scale, with a legend and a tooltip per month. */
function MonthBars({ data, a, b }: { data: Dash['months']; a: { key: 'sales' | 'moneyIn'; name: string; colour: string }; b: { key: 'purchases' | 'moneyOut'; name: string; colour: string } }) {
  if (!data.some((d) => d[a.key] || d[b.key])) return <EmptyChart h={250} text="Nothing in the books this year yet." />
  const rows = data.map((d) => ({ ...d, label: monthShort(d.month) }))
  return (
    <div className="text-muted-foreground h-[250px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tick={axis} tickLine={false} axisLine={false} tickFormatter={short} width={70} />
          <Tooltip content={<ChartTip labelOf={(p: any) => monthLong(p.month)} />} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} />
          <Legend verticalAlign="top" align="right" height={28} iconType="circle" iconSize={8} formatter={legendText} />
          <Bar dataKey={a.key} name={a.name} fill={a.colour} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey={b.key} name={b.name} fill={b.colour} radius={[4, 4, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * The accounts on one page, as on today: money in hand and at the bank,
 * what customers owe and what is owed out, GST and TDS to pay and by when,
 * the year's sales and profit month by month — and, first, anything that
 * wants doing. Every tile opens the screen behind its figure.
 */
export default function AccountsDashboardPage() {
  const [d, setD] = useState<Dash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setD((await api.get<{ data: Dash }>('/accounts/dashboard')).data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the accounts.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const todo: Array<{ icon: React.ElementType; text: React.ReactNode; href: string }> = []
  if (d?.booksStart) {
    const a = d.attention
    if (a.pending) todo.push({ icon: FileInput, text: `${a.pending} Sales and Purchase ${a.pending === 1 ? 'document is' : 'documents are'} not in the books yet.`, href: '/accounts/vouchers' })
    if (a.notClosed) todo.push({ icon: CalendarCheck, text: `${monthLong(a.notClosed)} is not closed yet. Close it once its GST and bank are checked.`, href: '/accounts/chart?tab=settings' })
    if (a.unreconciled) todo.push({ icon: Landmark, text: `${a.unreconciled} bank ${a.unreconciled === 1 ? 'entry is' : 'entries are'} over a month old and not yet matched to the statement.`, href: '/accounts/bank-reco' })
    if (a.openingDifference) todo.push({ icon: Scale, text: `The opening balances are out by ${drCr(a.openingDifference)}.`, href: '/accounts/chart?tab=opening' })
    if (d.tds.late) todo.push({ icon: Percent, text: `${inr(d.tds.late)} of TDS deducted is past its date to pay in.`, href: '/accounts/tds' })
    if (a.noPan.length) todo.push({ icon: AlertTriangle, text: `No PAN for ${a.noPan.slice(0, 3).join(', ')}${a.noPan.length > 3 ? ` and ${a.noPan.length - 3} more` : ''}: TDS on them goes at a higher rate.`, href: '/accounts/tds' })
  }

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Accounts</h1>
          <p className="page-subtitle hidden sm:block">{d?.today ? `The books on ${day(d.today)}` : 'The books at a glance'}</p>
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
      {loading && !d && <div className="skeleton h-72 w-full rounded-xl" />}
      {d && !d.booksStart && (
        <div className="glass-card space-y-2 p-5">
          <p className="text-foreground font-semibold">The books have not started yet.</p>
          <p className="text-muted-foreground text-sm">Set the day they start, then bring in the old books&apos; trial balance and unpaid bills.</p>
          <Link href="/accounts/chart?tab=settings" className="btn-primary inline-flex">
            <CalendarCheck size={15} /> Set it up
          </Link>
        </div>
      )}

      {d?.booksStart && (
        <>
          {todo.length > 0 && (
            <div className="glass-card overflow-hidden p-0">
              <p className="border-border text-foreground border-b px-4 py-2.5 text-sm font-semibold">To do</p>
              <ul className="divide-border divide-y">
                {todo.map((t, i) => (
                  <li key={i}>
                    <Link href={t.href} className="hover:bg-secondary/40 flex items-center gap-3 px-4 py-2.5 text-sm transition-colors">
                      <t.icon size={15} className="text-accent shrink-0" />
                      <span className="text-foreground flex-1">{t.text}</span>
                      <ArrowUpRight size={14} className="text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <KpiTile icon={Wallet} tone={TONE.teal} label="Cash in hand" value={inr(d.money.cash)} valueClass={d.money.cash < 0 ? 'text-destructive' : 'text-foreground'} sub="cash and cheques not yet banked" href="/accounts/bank" />
            <KpiTile
              icon={Landmark}
              tone={TONE.blue}
              label="At the bank"
              value={inr(d.money.bank + d.money.overdraft)}
              valueClass={d.money.bank + d.money.overdraft < 0 ? 'text-destructive' : 'text-foreground'}
              sub={`${d.money.banks.length} ${d.money.banks.length === 1 ? 'account' : 'accounts'}${d.money.overdraft < 0 ? ` · cash credit used ${inr(-d.money.overdraft)}` : ''}`}
              href="/accounts/bank"
            />
            <KpiTile
              icon={HandCoins}
              tone={TONE.teal}
              label={d.receivable.net >= 0 ? 'Customers owe us' : 'Customers have paid ahead'}
              value={inr(Math.abs(d.receivable.net))}
              valueClass="text-foreground"
              sub={<span className={d.receivable.overdue > 0 ? 'text-destructive' : ''}>{inr(d.receivable.overdue)} past due</span>}
              href="/accounts/outstanding"
            />
            <KpiTile icon={ArrowUpRight} tone={TONE.violet} label={d.payable.net >= 0 ? 'We owe suppliers' : 'We have paid suppliers ahead'} value={inr(Math.abs(d.payable.net))} sub={`${inr(d.payable.dueIn7)} falls due this week · ${inr(d.payable.overdue)} past due`} href="/accounts/outstanding?side=payable" />
            <KpiTile
              icon={Percent}
              tone={TONE.amber}
              label={d.gst ? `GST to pay for ${monthLong(d.gst.month)}` : 'GST'}
              value={d.gst ? inr(d.gst.cash) : '—'}
              sub={d.gst ? `by ${day(d.gst.due)} · tax ${inr(d.gst.tax)}, credit ${inr(d.gst.credit)}` : "Add the company's GSTIN in Settings"}
              href="/accounts/gst?tab=gstr3b"
            />
            <KpiTile
              icon={BookOpenCheck}
              tone={TONE.amber}
              label="TDS to pay in"
              value={inr(d.tds.owing)}
              sub={<span className={d.tds.late > 0 ? 'text-destructive' : ''}>{d.tds.late > 0 ? `${inr(d.tds.late)} late` : 'nothing late'}</span>}
              href="/accounts/tds"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiTile icon={TrendingUp} tone={TONE.teal} label="Sales this year" value={inr(d.year.sales)} sub={`since ${day(d.fyStart)}`} href="/accounts/profit-loss" />
            <KpiTile icon={ArrowDownLeft} tone={TONE.blue} label="Purchases" value={inr(d.year.purchases)} href="/accounts/profit-loss" />
            <KpiTile
              icon={Scale}
              tone={d.year.netProfit >= 0 ? TONE.teal : TONE.rose}
              label={d.year.netProfit >= 0 ? 'Net profit this year' : 'Net loss this year'}
              value={inr(Math.abs(d.year.netProfit))}
              valueClass={d.year.netProfit < 0 ? 'text-destructive' : 'text-foreground'}
              sub={`gross ${d.year.grossProfit >= 0 ? 'profit' : 'loss'} ${inr(Math.abs(d.year.grossProfit))}`}
              href="/accounts/profit-loss"
            />
            <KpiTile icon={Package} tone={TONE.violet} label="Closing stock" value={inr(d.year.closingStock)} sub="from inventory, unless valued" href="/accounts/profit-loss" />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <DashCard title="Sales and purchases, month by month" hint="This financial year, from the books" icon={TrendingUp} href="/accounts/profit-loss" hrefLabel="Profit & Loss">
              <MonthBars data={d.months} a={{ key: 'sales', name: 'Sales', colour: SALES }} b={{ key: 'purchases', name: 'Purchases', colour: PURCHASES }} />
            </DashCard>
            <DashCard title="Money in and out, month by month" hint="Into and out of cash and the banks; transfers between them left out" icon={Landmark} href="/accounts/bank" hrefLabel="Cash & Bank">
              <MonthBars data={d.months} a={{ key: 'moneyIn', name: 'Money in', colour: MONEY_IN }} b={{ key: 'moneyOut', name: 'Money out', colour: MONEY_OUT }} />
            </DashCard>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            {(
              [
                { title: 'Owe us the most', list: d.receivable.top, side: 'receivable' },
                { title: 'We owe the most', list: d.payable.top, side: 'payable' },
              ] as const
            ).map((t) => (
              <DashCard key={t.title} title={t.title} icon={t.side === 'receivable' ? HandCoins : ArrowUpRight} href={`/accounts/outstanding${t.side === 'payable' ? '?side=payable' : ''}`} hrefLabel="Outstanding">
                {t.list.length === 0 ? (
                  <EmptyChart h={120} text="Nothing outstanding." />
                ) : (
                  <ul className="space-y-2 text-sm">
                    {t.list.map((p) => (
                      <li key={p.ledgerId} className="flex items-baseline justify-between gap-3">
                        <Link href={`/accounts/ledger?id=${p.ledgerId}`} className="text-primary min-w-0 truncate hover:underline">
                          {p.name}
                        </Link>
                        <span className="shrink-0 text-right tabular-nums">
                          {inr(p.net)}
                          {p.overdue > 0 && <span className="text-destructive block text-[11px]">{inr(p.overdue)} past due</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </DashCard>
            ))}
            <DashCard title="Bank accounts" icon={Landmark} href="/accounts/bank-reco" hrefLabel="Reconcile">
              {d.money.banks.length === 0 ? (
                <EmptyChart h={120} text="No bank accounts yet." />
              ) : (
                <ul className="space-y-2 text-sm">
                  {d.money.banks.map((b) => (
                    <li key={b.id} className="flex items-baseline justify-between gap-3">
                      <Link href={`/accounts/ledger?id=${b.id}`} className="text-primary min-w-0 truncate hover:underline">
                        {b.name}
                      </Link>
                      <span className={`shrink-0 tabular-nums ${b.balance < 0 ? 'text-destructive' : ''}`}>{drCr(b.balance)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </DashCard>
          </div>
          {d.lockedUpTo && <p className="text-muted-foreground text-xs">The books are closed up to {day(d.lockedUpTo)}.</p>}
        </>
      )}
    </div>
  )
}
