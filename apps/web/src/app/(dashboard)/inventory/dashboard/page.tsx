'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  RefreshCw, AlertCircle, IndianRupee, ArrowDownUp, AlertTriangle, Hourglass, ClipboardList, Truck,
  Boxes, LineChart, PieChart as PieIcon, LayoutGrid, CalendarClock, BarChart3, Filter, Radar as RadarIcon,
  CircleDot, TrendingUp, Users, ArrowRight, Store,
} from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import {
  ActivityHeatmap, AgeingBars, CategoryTreemap, DepartmentRings, FlowChart, MixRadar, MoversBars,
  ParetoChart, RequisitionFunnel, Sparkline, StoreDonut, inr,
} from '@/components/inventory/InventoryDashboardCharts'

/**
 * The inventory at a glance.
 *
 * Stock is as of now, for every store or one; movement is for the chosen
 * period. Each figure card opens the screen that answers it, and a click on a
 * store in the donut narrows everything to that store.
 */

interface Dashboard {
  period: { days: number; from: string; to: string }
  kpis: {
    stockValue: number
    items: number
    lines: number
    stores: number
    toReorder: number
    deadValue: number
    deadLines: number
    mrWaiting: number
    mrPending: number
    openChallans: number
    overdueChallans: number
    atJobWorkers: number
    customerLines: number
    customers: number
    inValue: number
    outValue: number
    moves: number
  }
  byStore: Array<{ id: string; name: string; value: number; lines: number }>
  byCategory: Array<{ name: string; value: number; children: Array<{ name: string; value: number }> }>
  byDepartment: Array<{ name: string; value: number; lines: number; items: number }>
  byType: Array<{ name: string; value: number }>
  ageing: Array<{ key: string; label: string; value: number; lines: number }>
  dead: Array<{ itemId: string; code: string; name: string; store: string; qty: number; uom: string; value: number; days: number | null }>
  abc: {
    top: Array<{ itemId: string; code: string; name: string; value: number; cumPct: number; cls: string }>
    summary: Array<{ cls: string; items: number; value: number }>
    total: number
  }
  reorder: Array<{ itemId: string; code: string; name: string; uom: string; category: string; onHand: number; reorderLevel: number; cover: number }>
  series: Array<{ day: string; inValue: number; outValue: number; moves: number; ins: number; outs: number }>
  heat: Array<{ day: string; moves: number }>
  mix: Array<{ type: string; moves: number; value: number }>
  movers: Array<{ itemId: string; code: string; name: string; uom: string; moves: number; inValue: number; outValue: number }>
  requisitions: { pending: number; approved: number; partly: number; issued: number; rejected: number }
  jobWork: Array<{
    id: string
    challanNumber: string
    jobWorker: string
    process: string
    challanDate: string
    expectedBackOn: string | null
    daysOut: number
    overdue: boolean
    gstDaysLeft: number
    outLines: number
    outValue: number
  }>
  customers: Array<{ name: string; lines: number }>
}

const MOVEMENT: Record<string, string> = {
  OPENING: 'Opening',
  PURCHASE: 'Received',
  CUSTOMER_MATERIAL: "Customer's",
  SALE: 'Sold',
  ISSUE: 'Issued',
  PRODUCTION: 'Produced',
  TRANSFER: 'Transfer',
  ADJUSTMENT: 'Count',
  RETURN: 'Returned',
}

const PERIODS = [
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
  { days: 365, label: '1Y' },
]

const qtyFmt = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 3 })

function Card({
  title,
  hint,
  icon: Icon,
  href,
  hrefLabel,
  className = '',
  children,
}: {
  title: string
  hint?: string
  icon: React.ElementType
  href?: string
  hrefLabel?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`glass-card flex flex-col p-4 ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="bg-primary/10 border-primary/20 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
            <Icon size={15} className="text-primary" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
          </div>
        </div>
        {href && (
          <Link href={href} className="flex shrink-0 items-center gap-1 text-[11px] text-teal-500 hover:underline">
            {hrefLabel ?? 'Open'} <ArrowRight size={11} />
          </Link>
        )}
      </div>
      <div className="flex-1">{children}</div>
    </section>
  )
}

function Kpi({
  icon: Icon,
  tone,
  label,
  value,
  sub,
  href,
  children,
}: {
  icon: React.ElementType
  tone: string
  label: string
  value: string
  sub: React.ReactNode
  href: string
  children?: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className="glass-card group relative overflow-hidden p-4 transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: `${tone}22`, color: tone }}>
          <Icon size={15} />
        </span>
      </div>
      <p className="mt-1 text-xl font-bold tabular-nums text-foreground sm:text-2xl">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      {children && <div className="mt-2">{children}</div>}
      <ArrowRight size={13} className="absolute bottom-3 right-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  )
}

export default function InventoryDashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([])
  const [store, setStore] = useState('')
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void masterResource<{ id: string; name: string }>('warehouses')
      .list({ limit: 100, active: true })
      .then((r) => setStores(r.data))
      .catch(() => undefined)
  }, [])

  const latest = useRef(0)
  const load = useCallback(async () => {
    const id = ++latest.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ days: String(days) })
      if (store) qs.set('warehouseId', store)
      const res = await api.get<{ data: Dashboard }>(`/inventory/dashboard?${qs}`)
      if (id === latest.current) setData(res.data)
    } catch (err) {
      if (id !== latest.current) return
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'Your role does not allow viewing inventory.'
            : err.message
          : 'Could not reach the server. Is the API running?',
      )
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [days, store])

  useEffect(() => {
    void load()
  }, [load])

  const k = data?.kpis
  const storeName = stores.find((s) => s.id === store)?.name
  const deadShare = k && k.stockValue ? Math.round((k.deadValue / k.stockValue) * 100) : 0

  // A running net for the stock value card: in less out, day by day.
  const netRun = (() => {
    let t = 0
    return (data?.series ?? []).map((d) => (t += d.inValue - d.outValue))
  })()

  return (
    <div className="space-y-4">
      {/* Title, the store and the period: everything below answers to them. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Inventory Dashboard</h1>
          <p className="text-xs text-muted-foreground">
            Stock as of now{storeName ? ` in ${storeName}` : ', every store'} · movement over the last {days === 365 ? 'year' : `${days} days`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-secondary pl-3 pr-1">
            <Store size={14} className="text-muted-foreground" />
            <select
              className="h-full cursor-pointer bg-transparent pr-1 text-sm text-foreground outline-none"
              value={store}
              onChange={(e) => setStore(e.target.value)}
              aria-label="Store"
            >
              <option value="">All stores</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex rounded-lg border border-border bg-secondary p-1" role="tablist" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                type="button"
                role="tab"
                aria-selected={days === p.days}
                onClick={() => setDays(p.days)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  days === p.days ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button className="btn-ghost" onClick={() => void load()} disabled={loading} title="Refresh">
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

      {!data ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass-card h-32 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          {/* ── The six figures that matter most, each opening its own screen ── */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi
              icon={IndianRupee}
              tone="#14b8a6"
              label="Stock value"
              value={inr(k!.stockValue)}
              sub={`${k!.items} items · ${k!.stores} ${k!.stores === 1 ? 'store' : 'stores'}`}
              href="/inventory/stock"
            >
              <Sparkline data={netRun} />
            </Kpi>
            <Kpi
              icon={ArrowDownUp}
              tone="#38bdf8"
              label="In · out this period"
              value={`${inr(k!.inValue)}`}
              sub={
                <>
                  came in · <span className="text-red-400">{inr(k!.outValue)}</span> went out
                </>
              }
              href="/inventory/ledger"
            >
              <Sparkline data={(data.series ?? []).map((d) => d.moves)} colour="#38bdf8" />
            </Kpi>
            <Kpi
              icon={AlertTriangle}
              tone="#f59e0b"
              label="To reorder"
              value={String(k!.toReorder)}
              sub="items at or below their level"
              href="/inventory/stock?low=true"
            >
              <div className="flex h-9 items-end gap-0.5">
                {data.reorder.slice(0, 12).map((r) => (
                  <span
                    key={r.itemId}
                    className="flex-1 rounded-t-sm bg-amber-400/70"
                    style={{ height: `${Math.max(8, Math.min(100, r.cover))}%` }}
                    title={`${r.code}: ${r.cover}% of reorder level`}
                  />
                ))}
              </div>
            </Kpi>
            <Kpi
              icon={Hourglass}
              tone="#ef4444"
              label="Slow stock (90+ days)"
              value={inr(k!.deadValue)}
              sub={`${k!.deadLines} lines not moved in 90 days`}
              href="/inventory/stock"
            >
              <div className="h-2 overflow-hidden rounded-full bg-secondary">
                <div className="h-2 rounded-full bg-red-400" style={{ width: `${deadShare}%` }} />
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">{deadShare}% of the stock value</p>
            </Kpi>
            <Kpi
              icon={ClipboardList}
              tone="#a78bfa"
              label="Requisitions waiting"
              value={String(k!.mrWaiting)}
              sub={`${data.requisitions.pending} to approve · ${data.requisitions.approved + data.requisitions.partly} to issue`}
              href="/inventory/requisitions"
            >
              <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
                {k!.mrWaiting > 0 && (
                  <>
                    <div className="bg-violet-400" style={{ width: `${(data.requisitions.pending / k!.mrWaiting) * 100}%` }} />
                    <div className="bg-sky-400" style={{ width: `${(data.requisitions.approved / k!.mrWaiting) * 100}%` }} />
                    <div className="bg-teal-400" style={{ width: `${(data.requisitions.partly / k!.mrWaiting) * 100}%` }} />
                  </>
                )}
              </div>
            </Kpi>
            <Kpi
              icon={Truck}
              tone="#fb923c"
              label="At job workers"
              value={inr(k!.atJobWorkers)}
              sub={
                <>
                  {k!.openChallans} open
                  {k!.overdueChallans > 0 && <span className="text-red-400"> · {k!.overdueChallans} overdue</span>}
                </>
              }
              href="/inventory/job-work"
            >
              <p className="text-[10px] text-muted-foreground">
                {k!.customerLines} lines of {k!.customers} {k!.customers === 1 ? "customer's" : "customers'"} material held
              </p>
            </Kpi>
          </div>

          {/* ── Flow and where the value sits ── */}
          <div className="grid gap-4 xl:grid-cols-3">
            <Card
              className="xl:col-span-2"
              icon={LineChart}
              title="Stock flow"
              hint={`Value in and out each day, and how many movements — ${k!.moves} in the period`}
              href="/inventory/ledger?view=dashboard"
              hrefLabel="Ledger dashboard"
            >
              <FlowChart data={data.series} />
            </Card>
            <Card icon={PieIcon} title="Value by store" hint="Click a store to look at it alone">
              <StoreDonut data={data.byStore} active={store} onPick={(id) => setStore((s) => (s === id ? '' : id))} />
            </Card>
          </div>

          {/* ── What the value is, and how old it is ── */}
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2" icon={LayoutGrid} title="Value by category" hint="Each box a sub-category, sized by its value, coloured by its category">
              <CategoryTreemap data={data.byCategory} />
            </Card>
            <Card icon={CalendarClock} title="Stock ageing" hint="Value by days since each item last moved in its store">
              <AgeingBars data={data.ageing} />
            </Card>
          </div>

          {/* ── ABC ── */}
          <div className="grid gap-4 xl:grid-cols-3">
            <Card
              className="xl:col-span-2"
              icon={BarChart3}
              title="ABC analysis"
              hint="Items by value, largest first; the line is the running share. A items hold the first 80% of the value."
            >
              <ParetoChart data={data.abc.top} />
            </Card>
            <Card icon={CircleDot} title="What A, B and C mean here" hint="Share of the items against share of the value">
              <div className="space-y-4 pt-1">
                {data.abc.summary.map((c) => {
                  const itemPct = data.abc.total ? Math.round((c.items / data.abc.total) * 100) : 0
                  const valuePct = k!.stockValue ? Math.round((c.value / k!.stockValue) * 100) : 0
                  const tone = c.cls === 'A' ? '#14b8a6' : c.cls === 'B' ? '#38bdf8' : '#a78bfa'
                  return (
                    <div key={c.cls}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="flex items-center gap-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold text-white" style={{ background: tone }}>
                            {c.cls}
                          </span>
                          <span className="text-foreground">
                            {c.items} items · <span className="font-semibold">{inr(c.value)}</span>
                          </span>
                        </span>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="w-10">items</span>
                          <div className="h-2 flex-1 rounded-full bg-secondary">
                            <div className="h-2 rounded-full opacity-50" style={{ width: `${itemPct}%`, background: tone }} />
                          </div>
                          <span className="w-8 text-right tabular-nums">{itemPct}%</span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="w-10">value</span>
                          <div className="h-2 flex-1 rounded-full bg-secondary">
                            <div className="h-2 rounded-full" style={{ width: `${valuePct}%`, background: tone }} />
                          </div>
                          <span className="w-8 text-right font-semibold tabular-nums text-foreground">{valuePct}%</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Count and watch the A items closely; C items can be bought in bulk and checked less often.
                </p>
              </div>
            </Card>
          </div>

          {/* ── What needs doing ── */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card icon={AlertTriangle} title="Reorder watch" hint="Stock as a share of its reorder level, lowest first" href="/inventory/stock?low=true" hrefLabel="All">
              {data.reorder.length === 0 ? (
                <p className="py-10 text-center text-xs text-muted-foreground">Nothing needs reordering.</p>
              ) : (
                <div className="space-y-2.5">
                  {data.reorder.slice(0, 7).map((r) => (
                    <Link key={r.itemId} href={`/inventory/stock/${r.itemId}`} className="block rounded-md px-1 py-0.5 hover:bg-primary/5">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate text-foreground">
                          <span className="font-mono text-[10px] text-teal-500">{r.code}</span> {r.name}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {qtyFmt(r.onHand)} / {qtyFmt(r.reorderLevel)} {r.uom}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-secondary">
                        <div
                          className={`h-1.5 rounded-full ${r.cover < 25 ? 'bg-red-400' : r.cover < 75 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                          style={{ width: `${Math.max(3, Math.min(100, r.cover))}%` }}
                        />
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
            <Card icon={Filter} title="Requisition pipeline" hint="From asking to handing over" href="/inventory/requisitions" hrefLabel="Requisitions">
              <RequisitionFunnel
                data={[
                  { name: 'To approve', value: data.requisitions.pending, fill: '#a78bfa' },
                  { name: 'Approved, to issue', value: data.requisitions.approved, fill: '#818cf8' },
                  { name: 'Part issued', value: data.requisitions.partly, fill: '#38bdf8' },
                  { name: 'Issued in period', value: data.requisitions.issued, fill: '#14b8a6' },
                ]}
              />
              {data.requisitions.rejected > 0 && (
                <p className="text-center text-[11px] text-muted-foreground">{data.requisitions.rejected} refused in the period</p>
              )}
            </Card>
            <Card icon={RadarIcon} title="Movement mix" hint="What kind of movements the period held">
              <MixRadar data={data.mix.map((m) => ({ label: MOVEMENT[m.type] ?? m.type, moves: m.moves }))} />
            </Card>
          </div>

          {/* ── Rhythm and the departments ── */}
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2" icon={CalendarClock} title="Store activity" hint="Movements each day over the last twelve weeks">
              <ActivityHeatmap data={data.heat} />
            </Card>
            <Card icon={Boxes} title="Value by department" hint="Stock held for each department's work">
              <DepartmentRings data={data.byDepartment} />
            </Card>
          </div>

          {/* ── Who and what ── */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card icon={TrendingUp} title="Top movers" hint="Items that moved the most value in the period; the figure is how many times" href="/inventory/ledger" hrefLabel="Ledger">
              <MoversBars data={data.movers} />
            </Card>
            <Card icon={Truck} title="At job workers" hint="Open challans, oldest first" href="/inventory/job-work" hrefLabel="Job work">
              {data.jobWork.length === 0 ? (
                <p className="py-10 text-center text-xs text-muted-foreground">Nothing is out at a job worker.</p>
              ) : (
                <div className="space-y-2.5">
                  {data.jobWork.map((j) => (
                    <div key={j.id} className="rounded-md px-1 py-0.5">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate text-foreground">
                          <span className="font-mono text-[10px] text-teal-500">{j.challanNumber}</span> {j.jobWorker}
                        </span>
                        <span className={`shrink-0 tabular-nums ${j.overdue ? 'text-red-400' : 'text-muted-foreground'}`}>
                          {j.daysOut}d{j.overdue ? ' · overdue' : ''}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-secondary">
                          <div
                            className={`h-1.5 rounded-full ${j.gstDaysLeft < 60 ? 'bg-red-400' : j.overdue ? 'bg-amber-400' : 'bg-teal-400'}`}
                            style={{ width: `${Math.min(100, Math.max(3, (j.daysOut / 365) * 100))}%` }}
                            title={`${j.gstDaysLeft} days left of the GST year`}
                          />
                        </div>
                        <span className="text-[10px] tabular-nums text-muted-foreground">{inr(j.outValue)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card icon={Hourglass} title="Slowest stock" hint="Not moved for over 90 days, by value" href="/inventory/stock" hrefLabel="Stock">
              {data.dead.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
                  <span className="text-2xl">✓</span>
                  <p className="text-xs text-muted-foreground">Everything has moved in the last 90 days.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {data.dead.map((d) => (
                    <Link key={`${d.itemId}-${d.store}`} href={`/inventory/stock/${d.itemId}`} className="flex items-center justify-between gap-2 rounded-md px-1 py-1 text-xs hover:bg-primary/5">
                      <span className="min-w-0">
                        <span className="block truncate text-foreground">{d.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {d.store} · {qtyFmt(d.qty)} {d.uom} · {d.days ?? '—'} days
                        </span>
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums text-foreground">{inr(d.value)}</span>
                    </Link>
                  ))}
                </div>
              )}
              {data.customers.length > 0 && (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                    <Users size={12} className="text-sky-400" /> Customers&apos; material held
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.customers.map((c) => (
                      <Link key={c.name} href="/inventory/customer-material?view=dashboard" className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[11px] text-sky-500 hover:bg-sky-400/20">
                        {c.name} · {c.lines}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}
