'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle, AlertTriangle, CalendarClock, CheckCircle2, ClipboardList, IndianRupee, Layers,
  LayoutGrid, LineChart, ListChecks, ListOrdered, Package, PackageOpen, PieChart as PieIcon,
  Radar as RadarIcon, Receipt, RefreshCw, Ruler, Table2, Tags, Timer, TrendingUp, Truck, Users,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { DashCard, Highlights, KpiTile, PALETTE, SplitBar, TONE, inr, qtyFmt, qtyLine } from '@/components/dashboard/DashKit'
import {
  BreakdownTable, BuyingChart, CategoryTreemap, LeadTimeBars, PipelineSteps, ScheduleBars, Sparkline,
  StageRadar, SupplierBars, SupplierDonut, TONE_OF, UnitTiles,
} from '@/components/purchase/PurchaseDashboardCharts'
import {
  ChaseList, ChaseTabs, PriceWatchList, SupplierScorecard, TopItemsTable,
  type ChaseTab, type PurchaseDashboard,
} from '@/components/purchase/PurchaseDashboardTables'
import { SmartSelect } from '@/components/ui/SmartSelect'

/**
 * Purchase at a glance.
 *
 * What is open, late, unsent or unbilled is as of now, whatever the period —
 * an order raised in March that is still late is the one to see. What was
 * ordered, from whom and of what is for the chosen period. Value and quantity
 * side by side, quantity always unit by unit, since metres and pieces do not
 * add up. A supplier or category picked anywhere narrows the whole page.
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

export default function PurchaseDashboardPage() {
  const [data, setData] = useState<PurchaseDashboard | null>(null)
  const [days, setDays] = useState(30)
  const [supplier, setSupplier] = useState('')
  const [category, setCategory] = useState('')
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<ChaseTab>('overdue')
  const tabChosen = useRef(false)

  // The view the address asked for, read once — straight off window.location,
  // as the order list does, rather than opting the page into Suspense.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const d = Number(p.get('days'))
    if (PERIODS.some((x) => x.days === d)) setDays(d)
    setSupplier(p.get('supplier') ?? '')
    setCategory(p.get('category') ?? '')
    setReady(true)
  }, [])

  const latest = useRef(0)
  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const { from, to } = periodDates(days)
      const qs = new URLSearchParams({ from, to })
      if (supplier) qs.set('supplierId', supplier)
      if (category) qs.set('categoryId', category)
      const res = await api.get<{ data: PurchaseDashboard }>(`/purchase/orders-dashboard?${qs}`)
      if (id !== latest.current) return
      setData(res.data)
      // Open the chase list on whatever needs doing first, until somebody picks.
      if (!tabChosen.current) {
        const n = res.data.now
        setTab(n.overdue.length ? 'overdue' : n.dueSoon.length ? 'dueSoon' : n.unbilled.length ? 'unbilled' : n.drafts.length ? 'drafts' : 'overdue')
      }
    } catch (err) {
      if (id !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing purchase.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [days, supplier, category])

  useEffect(() => {
    if (!ready) return
    void load()
    const url = new URLSearchParams({ days: String(days) })
    if (supplier) url.set('supplier', supplier)
    if (category) url.set('category', category)
    window.history.replaceState(null, '', `${window.location.pathname}?${url}`)
  }, [ready, load, days, supplier, category])

  const pickSupplier = (id: string) => setSupplier((s) => (s === id ? '' : id))
  const pickCategory = (id: string) => setCategory((c) => (c === id ? '' : id))
  /** Straight to the orders behind a figure. */
  const chase = (t: ChaseTab) => {
    tabChosen.current = true
    setTab(t)
    requestAnimationFrame(() => document.getElementById('orders-to-chase')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const n = data?.now.kpis
  const a = data?.analysis
  const k = a?.kpis
  const supplierName = data?.options.suppliers.find((s) => s.id === supplier)?.name
  const categoryName = data?.options.categories.find((c) => c.id === category)?.name
  const scope = [supplierName, categoryName].filter(Boolean).join(' · ')
  const periodWords = days === 365 ? 'the last year' : `the last ${days} days`

  // A few plain sentences about the figures.
  const highlights: Array<{ icon: React.ElementType; text: React.ReactNode; tone?: string }> = []
  if (data && n && a && k) {
    if (n.overdueOrders)
      highlights.push({
        icon: AlertTriangle,
        tone: TONE.rose,
        text: (
          <span>
            <b className="font-semibold">{n.overdueOrders}</b> {n.overdueOrders === 1 ? 'order is' : 'orders are'} late · {inr(n.overdueValue)} of goods
          </span>
        ),
      })
    else highlights.push({ icon: CheckCircle2, tone: TONE.emerald, text: 'Nothing is past its wanted-by date' })
    const top = a.suppliers[0]
    if (top && k.value && a.suppliers.length > 1)
      highlights.push({
        icon: Users,
        text: (
          <span>
            <b className="font-semibold">{top.name}</b> takes {Math.round((top.value / k.value) * 100)}% of the ordering
          </span>
        ),
      })
    if (n.unbilledOrders)
      highlights.push({
        icon: Receipt,
        tone: TONE.amber,
        text: (
          <span>
            <b className="font-semibold">{inr(n.unbilledValue)}</b> received with no bill yet
          </span>
        ),
      })
    const rise = a.priceWatch.find((p) => (p.change ?? 0) >= 0.05)
    if (rise)
      highlights.push({
        icon: TrendingUp,
        tone: TONE.rose,
        text: (
          <span>
            <b className="font-semibold">{rise.name}</b> last bought {Math.round((rise.change ?? 0) * 100)}% above its usual rate
          </span>
        ),
      })
    if (n.noDate)
      highlights.push({
        icon: CalendarClock,
        tone: TONE.amber,
        text: (
          <span>
            <b className="font-semibold">{n.noDate}</b> open {n.noDate === 1 ? 'order has' : 'orders have'} no wanted-by date
          </span>
        ),
      })
    if (n.indentLines)
      highlights.push({
        icon: ClipboardList,
        tone: TONE.violet,
        text: (
          <span>
            <b className="font-semibold">{n.indentLines}</b> indent {n.indentLines === 1 ? 'line is' : 'lines are'} waiting to be ordered
          </span>
        ),
      })
  }

  const allQty = (a?.units ?? []).map((u) => ({ uom: u.uom, qty: u.orderedQty }))

  return (
    <div className="space-y-5">
      {/* Title on the left, the filters and the period on the right. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Purchase Dashboard</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Open orders as of now · buying over {periodWords}
            {scope ? ` · ${scope}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card pl-3 pr-1 shadow-sm">
            <Truck size={14} className="text-muted-foreground" />
            <SmartSelect
              className="h-full max-w-[11rem] cursor-pointer bg-transparent pr-1 text-sm text-foreground outline-none"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              aria-label="Supplier"
            >
              <option value="">All suppliers</option>
              {data?.options.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SmartSelect>
          </div>
          <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card pl-3 pr-1 shadow-sm">
            <Layers size={14} className="text-muted-foreground" />
            <SmartSelect
              className="h-full max-w-[10rem] cursor-pointer bg-transparent pr-1 text-sm text-foreground outline-none"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Category"
            >
              <option value="">All categories</option>
              {data?.options.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SmartSelect>
          </div>
          <div className="flex rounded-lg border border-border bg-card p-0.5 shadow-sm" role="tablist" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                type="button"
                role="tab"
                aria-selected={days === p.days}
                onClick={() => setDays(p.days)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  days === p.days ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
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
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {!data || !n || !a || !k ? (
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
              label="Value ordered"
              value={inr(k.value)}
              sub={
                <>
                  {k.orders} {k.orders === 1 ? 'order' : 'orders'} · {k.suppliers} {k.suppliers === 1 ? 'supplier' : 'suppliers'}
                  {k.valueChange != null && ` · ${k.valueChange >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(k.valueChange * 100))}%`}
                </>
              }
              href="/purchase/orders"
              title="Before GST"
            >
              <Sparkline data={a.trend.map((t) => t.ordered)} />
            </KpiTile>
            <KpiTile
              icon={Ruler}
              tone={TONE.blue}
              label="Quantity ordered"
              value={allQty[0] ? qtyFmt(allQty[0].qty) : '—'}
              sub={allQty[0] ? `${allQty[0].uom}${allQty.length > 1 ? ` · plus ${qtyLine(allQty.slice(1), 2)}` : ''}` : 'nothing ordered'}
            >
              <SplitBar parts={a.units.map((u, i) => ({ value: u.value, colour: PALETTE[i % PALETTE.length], label: `${u.uom}: ${inr(u.value)}` }))} />
            </KpiTile>
            <KpiTile
              icon={PackageOpen}
              tone={TONE.sky}
              label="Open orders"
              value={String(n.openOrders)}
              sub={`${inr(n.openValue)} still to arrive`}
              onClick={() => chase('dueSoon')}
              active={tab === 'dueSoon'}
              title="See what is due next"
            >
              <SplitBar
                parts={data.now.pipeline.map((p, i) => ({
                  value: p.orders,
                  colour: [TONE_OF.slate, TONE.blue, TONE.amber][i],
                  label: `${p.label}: ${p.orders}`,
                }))}
              />
            </KpiTile>
            <KpiTile
              icon={AlertTriangle}
              tone={TONE.rose}
              label="Late"
              value={String(n.overdueOrders)}
              valueClass={n.overdueOrders ? 'text-rose-500' : 'text-foreground'}
              sub={n.overdueOrders ? `${inr(n.overdueValue)} of goods` : 'nothing past its date'}
              onClick={() => chase('overdue')}
              active={tab === 'overdue'}
              title="See the late orders"
            />
            <KpiTile
              icon={Receipt}
              tone={TONE.amber}
              label="Received, not billed"
              value={inr(n.unbilledValue)}
              valueClass={n.unbilledOrders ? 'text-amber-500' : 'text-foreground'}
              sub={n.unbilledOrders ? `${n.unbilledOrders} ${n.unbilledOrders === 1 ? 'order' : 'orders'} · chase the bills` : 'every delivery is billed'}
              onClick={() => chase('unbilled')}
              active={tab === 'unbilled'}
              title="See the deliveries waiting for a bill"
            />
            <KpiTile
              icon={Timer}
              tone={TONE.emerald}
              label="Delivered on time"
              value={k.onTimeRate == null ? '—' : `${Math.round(k.onTimeRate * 100)}%`}
              sub={k.onTime + k.late ? `${k.onTime} of ${k.onTime + k.late} deliveries` : 'no dated deliveries yet'}
            >
              <SplitBar
                parts={[
                  { value: k.onTime, colour: TONE.emerald, label: 'on time' },
                  { value: k.late, colour: TONE.rose, label: 'late' },
                ]}
              />
            </KpiTile>
          </div>

          {/* ── Buying over time, and who it went to ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard
              className="xl:col-span-2"
              icon={LineChart}
              title="Buying over time"
              hint={`Value ordered and received each ${data.period.bucket}, with the number of orders behind`}
              href="/purchase/orders"
              hrefLabel="Orders"
            >
              <BuyingChart data={a.trend} />
            </DashCard>
            <DashCard icon={PieIcon} title="Value by supplier" hint="Pick a supplier to see the dashboard for it alone">
              <SupplierDonut data={a.suppliers} active={supplier} onPick={pickSupplier} />
            </DashCard>
          </div>

          {/* ── Quantity, unit by unit, and the road from indent to payment ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard className="xl:col-span-2" icon={Ruler} title="Quantity ordered by unit" hint="Metres with metres, pieces with pieces — how much has come in, and the value behind each">
              <UnitTiles data={a.units} />
            </DashCard>
            <DashCard icon={ListOrdered} title="From indent to payment" hint="Where the period's buying has got to" href="/reports/indent-against-po" hrefLabel="Indents">
              <PipelineSteps
                steps={[
                  {
                    label: 'Indent lines waiting to be ordered',
                    value: String(n.indentLines),
                    sub: n.indentLines ? `${n.indentItems} ${n.indentItems === 1 ? 'item' : 'items'} asked for, not yet on an order` : 'every indent is on an order',
                    share: n.indentLines ? 100 : 0,
                    colour: TONE.violet,
                  },
                  { label: 'Ordered', value: inr(k.value), sub: `${k.orders} ${k.orders === 1 ? 'order' : 'orders'}`, share: k.value ? 100 : 0, colour: TONE.blue },
                  { label: 'Goods received', value: inr(k.received), sub: `${k.value ? Math.round((k.received / k.value) * 100) : 0}% of ordered`, share: k.value ? (k.received / k.value) * 100 : 0, colour: TONE.sky },
                  { label: 'Billed', value: inr(k.billed), sub: `${k.value ? Math.round((k.billed / k.value) * 100) : 0}% of ordered`, share: k.value ? (k.billed / k.value) * 100 : 0, colour: TONE.teal },
                  { label: 'Paid', value: inr(k.paid), sub: `${k.value ? Math.round((k.paid / k.value) * 100) : 0}% of ordered`, share: k.value ? (k.paid / k.value) * 100 : 0, colour: TONE.emerald },
                ]}
              />
            </DashCard>
          </div>

          {/* ── Category, sub-category and department ── */}
          <DashCard icon={Table2} title="Category, sub-category and department" hint="Items, quantity and value ordered — open a row to see what is inside it">
            <BreakdownTable categories={a.breakdown.categories} departments={a.breakdown.departments} />
          </DashCard>

          {/* ── What the money went on, and when the goods are due ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard className="xl:col-span-2" icon={LayoutGrid} title="Value by sub-category" hint="Each box sized by its value, coloured by its category — pick one to see only that category">
              <CategoryTreemap data={a.breakdown.categories} onPick={pickCategory} />
            </DashCard>
            <DashCard icon={CalendarClock} title="When the goods are due" hint="Value still to arrive on open orders, by wanted-by date — pick a bar for its orders">
              <ScheduleBars
                data={data.now.schedule}
                onPick={(key) => {
                  if (key === 'overdue') chase('overdue')
                  else if (key === 'week' || key === 'next') chase('dueSoon')
                }}
              />
            </DashCard>
          </div>

          {/* ── Suppliers, stages and speed ── */}
          <div className="grid gap-5 lg:grid-cols-3">
            <DashCard icon={Users} title="Biggest suppliers" hint="Value ordered in the period — pick one to see only them">
              <SupplierBars data={a.suppliers} active={supplier} onPick={pickSupplier} />
            </DashCard>
            <DashCard icon={RadarIcon} title="Orders by stage" hint="Every order raised in the period, cancelled ones included">
              <StageRadar data={a.statusMix.map((s) => ({ label: s.label, orders: s.orders }))} />
            </DashCard>
            <DashCard icon={Timer} title="How long goods take to come" hint="Orders by days from the order to its first delivery">
              <LeadTimeBars data={a.leadTime} />
              {k.avgLead != null && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Average <span className="font-semibold text-foreground">{Math.round(k.avgLead)} days</span> from order to first delivery
                </p>
              )}
            </DashCard>
          </div>

          {/* ── What needs doing ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <div id="orders-to-chase" className="scroll-mt-4 xl:col-span-2">
              <DashCard
                className="h-full"
                icon={ListChecks}
                title="Orders to chase"
                hint="Late, due soon, not sent, or in the gate without a bill — open one to act on it"
                action={<ChaseTabs now={data.now} tab={tab} onTab={(t) => { tabChosen.current = true; setTab(t) }} />}
              >
                <ChaseList now={data.now} tab={tab} />
              </DashCard>
            </div>
            <DashCard icon={Tags} title="Price watch" hint="The last rate against the usual one, for items bought more than once">
              <PriceWatchList rows={a.priceWatch} />
            </DashCard>
          </div>

          <DashCard icon={Users} title="Supplier scorecard" hint="What was ordered in the period, how they delivered, and what is outstanding with each today — sort by any column" href="/masters/suppliers" hrefLabel="Suppliers">
            <SupplierScorecard rows={a.scorecard} active={supplier} onPick={pickSupplier} />
          </DashCard>

          <DashCard icon={Package} title="Most-ordered items" hint="Quantity in its own unit, and the value behind it">
            <TopItemsTable rows={a.topItems} total={k.value} />
          </DashCard>
        </div>
      )}
    </div>
  )
}
