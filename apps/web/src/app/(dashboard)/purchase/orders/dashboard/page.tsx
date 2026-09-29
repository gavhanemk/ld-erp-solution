'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  FileEdit,
  List,
  PackageOpen,
  RefreshCw,
  Timer,
  Truck,
  Users,
  X,
} from 'lucide-react'
import { api, apiErrorMessage } from '@/lib/api'
import {
  PRESETS,
  pct,
  periodWords,
  plural,
  presetRange,
  shortRupees,
  type DashboardData,
  type Preset,
} from '@/components/purchase/po-dashboard/model'
import {
  ActionCentre,
  AgeingBar,
  ChartCard,
  Funnel,
  Heatmap,
  Insights,
  KpiTile,
  Pipeline,
  RankBars,
  SectionRule,
  type ActionTab,
} from '@/components/purchase/po-dashboard/parts'
import {
  LeadTimeChart,
  OnTimeChart,
  ScheduleChart,
  StatusDonut,
  SupplierQuadrant,
  TrendChart,
} from '@/components/purchase/po-dashboard/charts'

/*
 * The Purchase Order dashboard.
 *
 * Read top to bottom it answers, in order: what does somebody need to chase
 * today, and how has ordering gone. The first band is never limited by the
 * period — an order raised in March that is still late is exactly the one to
 * see — and says so; the second is.
 *
 * Every filter lives in the one row at the top, and the page's address carries
 * them, so a view can be bookmarked or sent to somebody as a link. Clicking a
 * supplier or a category anywhere below narrows the whole page to it.
 */

const REFRESH_MS = 5 * 60_000

export default function PurchaseOrderDashboardPage() {
  const [preset, setPreset] = useState<Preset>('6m')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [ready, setReady] = useState(false)

  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<ActionTab>('overdue')
  const tabChosen = useRef(false)

  // The view the address asked for, read once. Straight off window.location,
  // as the orders list does, rather than opting the page into Suspense.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const asked = (p.get('period') as Preset | null) ?? '6m'
    const known = PRESETS.some((x) => x.key === asked) ? asked : '6m'
    setPreset(known)
    if (known === 'custom') {
      setFrom(p.get('from') ?? '')
      setTo(p.get('to') ?? '')
    } else {
      const r = presetRange(known)
      setFrom(r.from)
      setTo(r.to)
    }
    setSupplierId(p.get('supplier') ?? '')
    setCategoryId(p.get('category') ?? '')
    setReady(true)
  }, [])

  const load = useCallback(async () => {
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    if (supplierId) qs.set('supplierId', supplierId)
    if (categoryId) qs.set('categoryId', categoryId)
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ success: boolean; data: DashboardData }>(
        `/purchase/orders-dashboard?${qs.toString()}`
      )
      setData(res.data)
      // Open the list on whatever needs doing first, until somebody picks a tab.
      if (!tabChosen.current) {
        const n = res.data.now
        setTab(n.overdue.length ? 'overdue' : n.dueSoon.length ? 'dueSoon' : n.drafts.length ? 'drafts' : 'overdue')
      }
    } catch (err) {
      setError(apiErrorMessage(err, 'The dashboard could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [from, to, supplierId, categoryId])

  useEffect(() => {
    if (!ready) return
    void load()
    const url = new URLSearchParams()
    url.set('period', preset)
    if (preset === 'custom') {
      if (from) url.set('from', from)
      if (to) url.set('to', to)
    }
    if (supplierId) url.set('supplier', supplierId)
    if (categoryId) url.set('category', categoryId)
    window.history.replaceState(null, '', `${window.location.pathname}?${url.toString()}`)
  }, [ready, load, preset, from, to, supplierId, categoryId])

  // Kept current while it is on a screen, without hammering the server from
  // a tab nobody is looking at.
  useEffect(() => {
    if (!ready) return
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [ready, load])

  const pickPreset = (p: Preset) => {
    setPreset(p)
    if (p !== 'custom') {
      const r = presetRange(p)
      setFrom(r.from)
      setTo(r.to)
    }
  }
  const toggleSupplier = (id: string) => setSupplierId((cur) => (cur === id ? '' : id))
  const toggleCategory = (id: string) => setCategoryId((cur) => (cur === id ? '' : id))
  const pickTab = (t: ActionTab) => {
    tabChosen.current = true
    setTab(t)
  }

  const supplierName = data?.options.suppliers.find((s) => s.id === supplierId)?.name
  const categoryName = data?.options.categories.find((c) => c.id === categoryId)?.name
  const scope = [supplierName, categoryName].filter(Boolean).join(' · ')
  const now = data?.now
  const a = data?.analysis

  return (
    <div className="space-y-5">
      <div className="page-header gap-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl sm:text-2xl">Purchase Order Dashboard</h1>
          <p className="page-subtitle hidden sm:block">
            What needs chasing today, and how ordering has gone over the period
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {data && (
            <span className="text-muted-foreground hidden text-[11px] md:inline">
              Updated{' '}
              {new Date(data.asOf).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            className="btn-ghost"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
          <Link href="/purchase/orders" className="btn-secondary" aria-label="Purchase order list">
            <List size={15} /> <span className="hidden sm:inline">Order list</span>
          </Link>
        </div>
      </div>

      {/* Every filter, in one row, above everything it filters. */}
      <div className="glass-card flex flex-col gap-2.5 p-3 lg:flex-row lg:flex-wrap lg:items-center">
        <div
          className="bg-secondary/50 -mx-1 flex gap-1 overflow-x-auto rounded-lg p-1 lg:mx-0"
          role="radiogroup"
          aria-label="Period"
        >
          {PRESETS.map((p) => (
            <button
              key={p.key}
              role="radio"
              aria-checked={preset === p.key}
              onClick={() => pickPreset(p.key)}
              className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                preset === p.key
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              className="form-input h-8 min-w-0 flex-1 px-2 py-0 text-xs lg:w-[8.5rem] lg:flex-none"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="From"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <input
              type="date"
              className="form-input h-8 min-w-0 flex-1 px-2 py-0 text-xs lg:w-[8.5rem] lg:flex-none"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              aria-label="To"
            />
          </div>
        )}

        <div className="flex items-center gap-2 lg:ml-auto">
          <select
            className="form-input h-8 min-w-0 flex-1 px-2 py-0 text-xs lg:w-48 lg:flex-none"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            aria-label="Supplier"
          >
            <option value="">All suppliers</option>
            {data?.options.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            className="form-input h-8 min-w-0 flex-1 px-2 py-0 text-xs lg:w-44 lg:flex-none"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            aria-label="Category"
          >
            <option value="">All categories</option>
            {data?.options.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {(supplierId || categoryId) && (
            <button
              className="btn-ghost h-8 shrink-0 px-2 text-xs"
              onClick={() => {
                setSupplierId('')
                setCategoryId('')
              }}
              title="Clear the supplier and category"
            >
              <X size={13} /> <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {!data && !error && <Skeleton />}

      {data && now && a && (
        <div className={`space-y-7 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <Insights lines={a.insights} />

          {/* ===================== RIGHT NOW ===================== */}
          <section>
            <SectionRule note={`every open order, whatever date it was raised${scope ? ` · ${scope}` : ''}`}>
              Right now
            </SectionRule>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
              <KpiTile
                label="Open orders"
                value={String(now.kpis.openOrders)}
                basis={`${shortRupees(now.kpis.openValue)} still to arrive`}
                icon={<PackageOpen size={15} />}
              />
              <KpiTile
                label="Past wanted date"
                value={String(now.kpis.overdueOrders)}
                basis={now.kpis.overdueOrders ? `${shortRupees(now.kpis.overdueValue)} of goods late` : 'nothing late'}
                tone={now.kpis.overdueOrders ? 'bad' : 'good'}
                icon={<AlertTriangle size={15} />}
              />
              <KpiTile
                label="Due in 7 days"
                value={String(now.kpis.dueThisWeek)}
                basis={now.kpis.dueThisWeek ? `${shortRupees(now.kpis.dueThisWeekValue)} expected at the gate` : 'nothing due this week'}
                tone={now.kpis.dueThisWeek ? 'warn' : undefined}
                icon={<Truck size={15} />}
              />
              <KpiTile
                label="Drafts not sent"
                value={String(now.kpis.drafts)}
                basis={now.kpis.drafts ? `worth ${shortRupees(now.kpis.draftValue)}` : 'every order has gone out'}
                tone={now.kpis.drafts ? 'warn' : undefined}
                icon={<FileEdit size={15} />}
              />
              <KpiTile
                label="No wanted date"
                value={String(now.kpis.noDate)}
                basis={now.kpis.noDate ? 'open orders that can never show as late' : 'every open order has a date'}
                tone={now.kpis.noDate ? 'warn' : undefined}
                icon={<CalendarClock size={15} />}
              />
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartCard
                title="When the goods are expected"
                subtitle="Value still to arrive on open orders, by wanted-by date. Click a bar to see its orders."
              >
                <ScheduleChart
                  schedule={now.schedule}
                  onPick={(key) => {
                    if (key === 'overdue') pickTab('overdue')
                    else if (key === 'week' || key === 'next') pickTab('dueSoon')
                  }}
                />
              </ChartCard>
              <ActionCentre now={now} tab={tab} onTab={pickTab} />
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartCard title="How long the open value has waited" subtitle="Still to arrive, by days since the order was raised">
                <AgeingBar ageing={now.ageing} />
              </ChartCard>
              <ChartCard title="Where the open orders stand" subtitle="Drafts at their full value; sent and part-received at what is still due">
                <div className="flex flex-1 flex-col justify-center">
                  <Pipeline pipeline={now.pipeline} />
                </div>
              </ChartCard>
            </div>
          </section>

          {/* ===================== THE PERIOD ===================== */}
          <section>
            <SectionRule note={`orders raised ${periodWords(from, to)}${scope ? ` · ${scope}` : ''}`}>
              Over the period
            </SectionRule>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <KpiTile
                label="Orders raised"
                value={String(a.kpis.orders)}
                change={a.kpis.ordersChange}
                basis={a.kpis.ordersChange != null ? 'on the period before' : a.kpis.cancelled ? `${a.kpis.cancelled} cancelled, not counted` : undefined}
              />
              <KpiTile
                label="Value ordered"
                value={shortRupees(a.kpis.value)}
                change={a.kpis.valueChange}
                basis={a.kpis.valueChange != null ? 'on the period before · before GST' : 'before GST'}
              />
              <KpiTile
                label="Average order"
                value={a.kpis.avgOrder == null ? '—' : shortRupees(a.kpis.avgOrder)}
                basis={`${plural(a.kpis.suppliers, 'supplier')} used`}
                icon={<Users size={15} />}
              />
              <KpiTile
                label="Delivered on time"
                value={pct(a.kpis.onTimeRate)}
                basis={a.kpis.receipts ? `of ${plural(a.kpis.receipts, 'delivery', 'deliveries')} against a dated order` : 'no dated deliveries to measure'}
                tone={a.kpis.onTimeRate == null ? undefined : a.kpis.onTimeRate >= 0.9 ? 'good' : a.kpis.onTimeRate >= 0.7 ? 'warn' : 'bad'}
                icon={<Timer size={15} />}
              />
              <KpiTile
                label="Received"
                value={pct(a.kpis.receivedRate)}
                basis="of the value ordered"
                progress={a.kpis.receivedRate}
              />
              <KpiTile
                label="Billed"
                value={pct(a.kpis.billedRate)}
                basis="of the value ordered"
                progress={a.kpis.billedRate}
              />
            </div>

            <div className="mt-3">
              <ChartCard title="Ordering, month by month" subtitle="Value before GST. Received counts goods by the month they came in.">
                <TrendChart trend={a.trend} />
              </ChartCard>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartCard title="From order to payment" subtitle="How much of what was ordered has come in, been billed and been paid">
                <Funnel funnel={a.funnel} />
              </ChartCard>
              <ChartCard title="Orders by stage" subtitle="Every order raised in the period, cancelled ones included">
                <StatusDonut mix={a.statusMix} />
              </ChartCard>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartCard title="Biggest suppliers" subtitle="By value ordered. Click one to see only them.">
                <RankBars
                  rows={a.topSuppliers}
                  selected={supplierId}
                  onPick={toggleSupplier}
                  empty="No orders were raised in this period."
                  detail={(r) => {
                    const s = a.topSuppliers.find((x) => x.id === r.id)
                    if (!s || !s.id) return null
                    return [
                      plural(s.orders, 'order'),
                      s.onTimeRate != null ? `${pct(s.onTimeRate)} on time` : null,
                      s.avgLead != null ? `${plural(Math.round(s.avgLead), 'day')} to deliver` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  }}
                />
              </ChartCard>
              <ChartCard title="What the money went on" subtitle="Value ordered by item category. Click one to see only it.">
                <RankBars
                  rows={a.categories}
                  selected={categoryId}
                  onPick={toggleCategory}
                  empty="No orders were raised in this period."
                />
              </ChartCard>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartCard title="Supplier speed and reliability" subtitle="Bubble size is value ordered. Dashed lines: 90% on time, and the middle lead time.">
                <SupplierQuadrant rows={a.supplierQuadrant} onPick={toggleSupplier} />
              </ChartCard>
              <ChartCard title="Deliveries on time, by supplier" subtitle="Each receipt against its order's wanted-by date">
                <OnTimeChart rows={a.onTimeBySupplier} />
              </ChartCard>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartCard title="How long goods take to come" subtitle="Orders by days from the order to its first delivery">
                <LeadTimeChart lead={a.leadTime} avg={a.kpis.avgLead} />
              </ChartCard>
              <ChartCard title="Most-ordered items" subtitle="By value ordered in the period">
                <RankBars
                  rows={a.topItems}
                  empty="No orders were raised in this period."
                  detail={(r) => {
                    const it = a.topItems.find((x) => x.id === r.id)
                    return it ? `on ${plural(it.orders, 'order')}` : null
                  }}
                />
              </ChartCard>
            </div>

            <div className="mt-3">
              <ChartCard title="Who was ordered from, when" subtitle="The six biggest suppliers, month by month. Darker is more.">
                <Heatmap heatmap={a.heatmap} />
              </ChartCard>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

/** The page's shape while the first load is on its way, so nothing jumps when it lands. */
function Skeleton() {
  const block = 'glass-card animate-pulse'
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading the dashboard">
      <div className={`${block} h-24`} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={`${block} h-24`} />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className={`${block} h-72`} />
        <div className={`${block} h-72`} />
      </div>
    </div>
  )
}
