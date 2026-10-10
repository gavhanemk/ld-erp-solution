'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlarmClock, AlertCircle, AlertTriangle, BadgePercent, CalendarClock, CheckCircle2, FileText, Gauge,
  HandCoins, IndianRupee, LayoutGrid, LineChart, ListChecks, Package, PieChart as PieIcon, ReceiptText,
  RefreshCw, Ruler, Scale, ShieldAlert, Shirt, Tag, Timer, TrendingDown, TrendingUp, Truck, UserRound, Users, Workflow,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { DashCard, Highlights, KpiTile, PALETTE, SplitBar, TONE, inr } from '@/components/dashboard/DashKit'
import { CategoryTreemap, PipelineSteps, ScheduleBars, Sparkline, SupplierDonut, TONE_OF } from '@/components/purchase/PurchaseDashboardCharts'
import {
  ActList, ActTabs, AgeingBars, BrandMix, Change, CustomerScorecard, PeopleBars, QuoteFunnel, SalesTrendChart, SizeMix, TopStylesTable,
  type ActTab, type SalesDashboard,
} from '@/components/sales/SalesDashboardCharts'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Sales at a glance — the first screen of the Sales module.
 *
 * What is open, owed, late or unbilled is as of now, whatever the period: an
 * order booked in March that is still late is the one to see. What was
 * booked, sent, billed and collected — and for whom, in which styles and
 * sizes — is for the chosen period, against the period before it. A brand
 * or customer picked anywhere narrows the whole page. Every figure and every
 * row opens the screen where the work is done.
 */

const PERIODS = [
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
  { days: 365, label: '1Y' },
]

/** Today on the Indian calendar, and the day `days - 1` before it, as YYYY-MM-DD. */
function periodDates(days: number) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const start = new Date(`${today}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return { from: start.toISOString().slice(0, 10), to: today }
}

const pcs = (n: number) => n.toLocaleString('en-IN')
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

export default function SalesDashboardPage() {
  const [data, setData] = useState<SalesDashboard | null>(null)
  const [days, setDays] = useState(30)
  const [brand, setBrand] = useState('')
  const [customer, setCustomer] = useState('')
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<ActTab>('late')
  const tabChosen = useRef(false)

  // The view the address asked for, read once.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const d = Number(p.get('days'))
    if (PERIODS.some((x) => x.days === d)) setDays(d)
    setBrand(p.get('brand') ?? '')
    setCustomer(p.get('customer') ?? '')
    setReady(true)
  }, [])

  const latest = useRef(0)
  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams(periodDates(days))
      if (brand) qs.set('brandId', brand)
      if (customer) qs.set('customerId', customer)
      const res = await api.get<{ data: SalesDashboard }>(`/sales/dashboard?${qs}`)
      if (id !== latest.current) return
      setData(res.data)
      // Open the to-do list on whatever needs doing first, until somebody picks.
      if (!tabChosen.current) {
        const c = res.data.now.counts
        setTab((['late', 'overdue', 'toBill', 'hold', 'dueSoon', 'quotes'] as ActTab[]).find((t) => c[t] > 0) ?? 'late')
      }
    } catch (err) {
      if (id !== latest.current) return
      setError(err instanceof ApiError ? (err.status === 403 ? 'Your role does not allow viewing Sales.' : err.message) : 'Could not reach the server. Is the API running?')
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [days, brand, customer])

  useEffect(() => {
    if (!ready) return
    void load()
    const url = new URLSearchParams({ days: String(days) })
    if (brand) url.set('brand', brand)
    if (customer) url.set('customer', customer)
    window.history.replaceState(null, '', `${window.location.pathname}?${url}`)
  }, [ready, load, days, brand, customer])

  const pickCustomer = (id: string) => setCustomer((c) => (c === id || !id ? '' : id))
  /** Straight to the to-do list behind a figure. */
  const act = (t: ActTab) => {
    tabChosen.current = true
    setTab(t)
    requestAnimationFrame(() => document.getElementById('sales-to-act')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const k = data?.kpis
  const a = data?.analysis
  const n = data?.now
  const brandName = data?.options.brands.find((b) => b.id === brand)?.name
  const customerName = data?.options.customers.find((c) => c.id === customer)?.name
  const scope = [brandName, customerName].filter(Boolean).join(' · ')
  const periodWords = days === 365 ? 'the last year' : `the last ${days} days`

  // A few plain sentences about the figures, most urgent first.
  const highlights: Array<{ icon: React.ElementType; text: React.ReactNode; tone?: string }> = []
  if (k && a && n) {
    if (n.receivables.overdue.value > 0)
      highlights.push({
        icon: AlarmClock,
        tone: TONE.rose,
        text: (
          <span>
            <b className="font-semibold">{inr(n.receivables.overdue.value)}</b> overdue on {n.receivables.overdue.invoices} {n.receivables.overdue.invoices === 1 ? 'invoice' : 'invoices'}
          </span>
        ),
      })
    if (n.counts.late)
      highlights.push({
        icon: AlertTriangle,
        tone: TONE.rose,
        text: (
          <span>
            <b className="font-semibold">{n.counts.late}</b> {n.counts.late === 1 ? 'order is' : 'orders are'} past the delivery date
          </span>
        ),
      })
    else highlights.push({ icon: CheckCircle2, tone: TONE.emerald, text: 'No order is past its delivery date' })
    if (n.counts.toBill)
      highlights.push({
        icon: ReceiptText,
        tone: TONE.violet,
        text: (
          <span>
            <b className="font-semibold">{n.counts.toBill}</b> {n.counts.toBill === 1 ? 'challan has' : 'challans have'} gone without an invoice
          </span>
        ),
      })
    if (k.booked.change != null)
      highlights.push({
        icon: k.booked.change >= 0 ? TrendingUp : TrendingDown,
        tone: k.booked.change >= 0 ? TONE.emerald : TONE.rose,
        text: (
          <span>
            Bookings {k.booked.change >= 0 ? 'up' : 'down'} <b className="font-semibold">{Math.abs(Math.round(k.booked.change * 100))}%</b> on the period before
          </span>
        ),
      })
    const top = a.customers[0]
    if (top && top.id && k.booked.value && a.customers.length > 1)
      highlights.push({
        icon: Users,
        text: (
          <span>
            <b className="font-semibold">{top.name}</b> is {pct(top.value, k.booked.value)}% of the bookings
          </span>
        ),
      })
    if (n.counts.hold)
      highlights.push({
        icon: ShieldAlert,
        tone: TONE.amber,
        text: (
          <span>
            <b className="font-semibold">{n.counts.hold}</b> {n.counts.hold === 1 ? 'order waits' : 'orders wait'} on a credit release
          </span>
        ),
      })
    if (n.counts.quotes)
      highlights.push({
        icon: FileText,
        tone: TONE.orange,
        text: (
          <span>
            <b className="font-semibold">{n.counts.quotes}</b> {n.counts.quotes === 1 ? 'quotation lapses' : 'quotations lapse'} this week
          </span>
        ),
      })
  }

  const ageingTones = n?.receivables.ageing.map((x) => ({ value: x.value, colour: TONE_OF[x.tone] ?? PALETTE[0], label: `${x.label}: ${inr(x.value)}` })) ?? []

  return (
    <div className="space-y-5">
      {/* Title on the left, the filters and the period on the right. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Sales Dashboard</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Open orders and money owed as of now · sales over {periodWords}
            {scope ? ` · ${scope}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="border-border bg-card flex h-9 items-center gap-2 rounded-lg border pl-3 pr-1 shadow-sm">
            <Tag size={14} className="text-muted-foreground" />
            <SmartSelect className="text-foreground h-full max-w-[10rem] cursor-pointer bg-transparent pr-1 text-sm outline-none" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
              <option value="">All brands</option>
              {data?.options.brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SmartSelect>
          </div>
          <div className="border-border bg-card flex h-9 items-center gap-2 rounded-lg border pl-3 pr-1 shadow-sm">
            <UserRound size={14} className="text-muted-foreground" />
            <SmartSelect className="text-foreground h-full max-w-[12rem] cursor-pointer bg-transparent pr-1 text-sm outline-none" value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="Customer">
              <option value="">All customers</option>
              {data?.options.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SmartSelect>
          </div>
          <div className="border-border bg-card flex rounded-lg border p-0.5 shadow-sm" role="tablist" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                type="button"
                role="tab"
                aria-selected={days === p.days}
                onClick={() => setDays(p.days)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${days === p.days ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button className="btn-ghost h-9" onClick={() => void load()} disabled={loading} title="Refresh">
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-lg border p-3">
          <AlertCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {!data || !k || !a || !n ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass-card h-32 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <Highlights items={highlights.slice(0, 5)} />

          {/* ── The figures that matter most ── */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <KpiTile
              icon={IndianRupee}
              tone={TONE.teal}
              label="Orders booked"
              value={inr(k.booked.value)}
              sub={
                <>
                  {k.booked.orders} {k.booked.orders === 1 ? 'order' : 'orders'} · {pcs(k.booked.pieces)} pcs <Change value={k.booked.change} />
                </>
              }
              href="/sales/orders"
              title="Before GST"
            >
              <Sparkline data={a.trend.map((t) => t.booked)} />
            </KpiTile>
            <KpiTile
              icon={ReceiptText}
              tone={TONE.blue}
              label="Invoiced"
              value={inr(k.invoiced.value)}
              sub={
                <>
                  {k.invoiced.invoices} {k.invoiced.invoices === 1 ? 'invoice' : 'invoices'} · {inr(k.invoiced.withGst)} with GST <Change value={k.invoiced.change} />
                </>
              }
              href="/sales/invoices?tab=invoices"
              title={k.invoiced.credited ? `Before GST, less ${inr(k.invoiced.credited)} of credit notes` : 'Before GST'}
            >
              <Sparkline data={a.trend.map((t) => t.invoiced)} colour={PALETTE[1]} />
            </KpiTile>
            <KpiTile
              icon={HandCoins}
              tone={TONE.emerald}
              label="Collected"
              value={inr(k.collected.value)}
              sub={
                <>
                  {k.collected.receipts} {k.collected.receipts === 1 ? 'receipt' : 'receipts'}
                  {k.collected.rate != null && ` · ${k.collected.rate}% of billed`} <Change value={k.collected.change} />
                </>
              }
              href="/sales/payments?tab=receipts"
            >
              <Sparkline data={a.trend.map((t) => t.collected)} colour={TONE.emerald} />
            </KpiTile>
            <KpiTile
              icon={Package}
              tone={TONE.sky}
              label="Order book"
              value={inr(n.book.value)}
              sub={`${n.book.orders} open ${n.book.orders === 1 ? 'order' : 'orders'} · ${pcs(n.book.pieces)} pcs to send`}
              onClick={() => act(n.counts.late ? 'late' : 'dueSoon')}
              title="See what is late and what is due"
            >
              <SplitBar parts={n.book.byStatus.map((s, i) => ({ value: s.value, colour: [TONE.blue, TONE.violet, TONE.amber][i], label: `${s.label}: ${s.orders} · ${inr(s.value)}` }))} />
            </KpiTile>
            <KpiTile
              icon={Scale}
              tone={TONE.amber}
              label="Customers owe"
              value={inr(n.receivables.value)}
              valueClass="text-foreground"
              sub={
                n.receivables.overdue.value ? (
                  <span className="text-destructive">{inr(n.receivables.overdue.value)} overdue</span>
                ) : n.receivables.invoices ? (
                  `${n.receivables.invoices} open invoices · none late`
                ) : (
                  'nothing owed'
                )
              }
              onClick={() => act('overdue')}
              active={tab === 'overdue'}
              title="See the overdue invoices"
            >
              <SplitBar parts={ageingTones} />
            </KpiTile>
            <KpiTile
              icon={Timer}
              tone={TONE.violet}
              label="Sent on time"
              value={k.onTime.rate == null ? '—' : `${k.onTime.rate}%`}
              sub={k.onTime.onTime + k.onTime.late ? `${k.onTime.onTime} of ${k.onTime.onTime + k.onTime.late} challans by the delivery date` : `${pcs(k.dispatched.pieces)} pcs sent · no dated orders`}
              href="/sales/challan?tab=challans"
            >
              <SplitBar
                parts={[
                  { value: k.onTime.onTime, colour: TONE.emerald, label: 'on time' },
                  { value: k.onTime.late, colour: TONE.rose, label: 'late' },
                ]}
              />
            </KpiTile>
          </div>

          {/* ── A pulse strip of the smaller figures ── */}
          <div className="glass-card grid grid-cols-2 divide-border rounded-xl sm:grid-cols-4 sm:divide-x">
            {[
              { icon: Gauge, label: 'Average order', value: inr(k.booked.avgOrder), tone: TONE.teal },
              { icon: Truck, label: 'Goods sent', value: `${pcs(k.dispatched.pieces)} pcs`, sub: `${k.dispatched.challans} challans · ${inr(k.dispatched.value)}`, tone: TONE.sky },
              { icon: BadgePercent, label: 'Quotation win rate', value: a.quotes.winRate == null ? '—' : `${a.quotes.winRate}%`, sub: `${a.quotes.won.count} won · ${a.quotes.lost.count} lost`, tone: TONE.orange },
              { icon: ReceiptText, label: 'Credit notes', value: inr(k.invoiced.credited), sub: 'returns and rate cuts, before GST', tone: TONE.rose },
            ].map((s) => (
              <div key={s.label} className="flex items-center gap-3 px-4 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: `${s.tone}18`, color: s.tone }}>
                  <s.icon size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-muted-foreground text-[11px]">{s.label}</p>
                  <p className="text-foreground text-base font-semibold tabular-nums">{s.value}</p>
                  {s.sub && <p className="text-muted-foreground truncate text-[10px]">{s.sub}</p>}
                </div>
              </div>
            ))}
          </div>

          {/* ── Sales over time, and who they came from ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard
              className="xl:col-span-2"
              icon={LineChart}
              title="Sales over time"
              hint={`Booked, invoiced (less credit notes) and collected each ${data.period.bucket}, with the orders behind`}
              href="/reports"
              hrefLabel="Reports"
            >
              <SalesTrendChart data={a.trend} />
            </DashCard>
            <DashCard icon={PieIcon} title="Bookings by customer" hint="Pick a customer to see the dashboard for them alone">
              <SupplierDonut data={a.customers} active={customer} onPick={pickCustomer} />
            </DashCard>
          </div>

          {/* ── What needs doing, and where the period's sales have got to ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <div id="sales-to-act" className="scroll-mt-4 xl:col-span-2">
              <DashCard
                className="h-full"
                icon={ListChecks}
                title="Needs attention"
                hint="Today, whatever the period — open a row to act on it"
                action={null}
              >
                <div className="mb-3">
                  <ActTabs
                    counts={n.counts}
                    tab={tab}
                    onTab={(t) => {
                      tabChosen.current = true
                      setTab(t)
                    }}
                  />
                </div>
                <ActList lists={n.lists} counts={n.counts} tab={tab} />
              </DashCard>
            </div>
            <DashCard icon={Workflow} title="From quotation to cash" hint="The period's sales, step by step, against what was booked">
              <PipelineSteps
                steps={[
                  { label: 'Quoted', value: inr(a.pipeline.quoted), sub: `${a.quotes.made} ${a.quotes.made === 1 ? 'quotation' : 'quotations'}`, share: a.pipeline.quoted ? 100 : 0, colour: TONE.orange },
                  { label: 'Orders booked', value: inr(a.pipeline.booked), sub: `${k.booked.orders} ${k.booked.orders === 1 ? 'order' : 'orders'}`, share: a.pipeline.booked ? 100 : 0, colour: TONE.teal },
                  { label: 'Goods sent', value: inr(a.pipeline.dispatched), sub: `${pct(a.pipeline.dispatched, a.pipeline.booked)}% of booked`, share: pct(a.pipeline.dispatched, a.pipeline.booked), colour: TONE.sky },
                  { label: 'Invoiced', value: inr(a.pipeline.invoiced), sub: `${pct(a.pipeline.invoiced, a.pipeline.booked)}% of booked`, share: pct(a.pipeline.invoiced, a.pipeline.booked), colour: TONE.blue },
                  { label: 'Collected', value: inr(a.pipeline.collected), sub: k.invoiced.withGst ? `${pct(a.pipeline.collected, k.invoiced.withGst)}% of billed with GST` : 'nothing billed yet', share: pct(a.pipeline.collected, k.invoiced.withGst), colour: TONE.emerald },
                ]}
              />
            </DashCard>
          </div>

          {/* ── Money owed, goods due, quotations ── */}
          <div className="grid gap-5 lg:grid-cols-3">
            <DashCard icon={Scale} title="How old the dues are" hint="What customers owe today, by days past the due date" href="/sales/payments" hrefLabel="Outstanding">
              <AgeingBars data={n.receivables.ageing} onPick={(key) => key !== 'current' && act('overdue')} />
            </DashCard>
            <DashCard icon={CalendarClock} title="When orders are due" hint="Value still to send on open orders, by delivery date — pick a bar for its orders">
              <ScheduleBars
                data={n.schedule}
                onPick={(key) => {
                  if (key === 'late') act('late')
                  else if (key === 'week' || key === 'next') act('dueSoon')
                }}
              />
            </DashCard>
            <DashCard icon={FileText} title="Quotations" hint="Made in the period: where each one stands" href="/sales/quotations" hrefLabel="Quotations">
              <QuoteFunnel q={a.quotes} />
            </DashCard>
          </div>

          {/* ── What sells: styles and sizes ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard className="xl:col-span-2" icon={LayoutGrid} title="Bookings by style" hint="Each box sized by its value, coloured by garment type">
              <CategoryTreemap data={a.styleTree} onPick={() => {}} />
            </DashCard>
            <DashCard icon={Ruler} title="Size mix" hint="Pieces booked in each size — the shape of the size curve">
              <SizeMix data={a.sizes} />
            </DashCard>
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard className="xl:col-span-2" icon={Shirt} title="Best-selling styles and colours" hint="Pieces, the average rate and the value booked in the period">
              <TopStylesTable rows={a.topStyles} />
            </DashCard>
            <DashCard icon={Tag} title="Brand and order type" hint="Each brand's share of the bookings, job work apart">
              <BrandMix data={a.brandMix} />
            </DashCard>
          </div>

          {/* ── People and customers ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard icon={Users} title="Who brings the orders" hint="Bookings by salesperson or broker in the period">
              <PeopleBars salespeople={a.salespeople} brokers={a.brokers} />
            </DashCard>
            <DashCard className="xl:col-span-2" icon={UserRound} title="Customer scorecard" hint="Booked, billed and collected in the period, and what each owes today — sort by any column, pick a row to see that customer alone" href="/masters/customers" hrefLabel="Customers">
              <CustomerScorecard rows={a.scorecard} active={customer} onPick={pickCustomer} />
            </DashCard>
          </div>
        </div>
      )}
    </div>
  )
}
