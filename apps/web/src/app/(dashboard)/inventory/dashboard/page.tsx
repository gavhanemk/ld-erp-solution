'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  RefreshCw, AlertCircle, IndianRupee, ArrowDownUp, AlertTriangle, Hourglass, ClipboardList, Truck,
  LineChart, PieChart as PieIcon, LayoutGrid, CalendarClock, BarChart3, ListOrdered, Radar as RadarIcon,
  CircleDot, TrendingUp, Users, Store, Ruler, ArrowLeftRight, Table2, Layers, Target, ShoppingCart,
  CalendarCheck, CheckCircle2,
} from 'lucide-react'
import { api, ApiError, masterResource } from '@/lib/api'
import { DashCard, Highlights, KpiTile, SplitBar, TONE, PALETTE, qtyFmt, qtyLine } from '@/components/dashboard/DashKit'
import {
  ActivityHeatmap, AgeingBars, BreakdownTable, CategoryTreemap, FlowChart, MixRadar, MoversBars,
  ParetoChart, PipelineSteps, Sparkline, StoreDonut, UnitFlow, UnitTiles, inr,
} from '@/components/inventory/InventoryDashboardCharts'

/**
 * The inventory at a glance.
 *
 * Stock is as of now, for every store or one; movement is for the chosen
 * period. Value and quantity side by side — quantity always unit by unit,
 * since metres and pieces do not add up. Each figure opens the screen that
 * answers it, and a store picked in the donut narrows everything to it.
 */

type Qty = Array<{ uom: string; qty: number }>
interface BreakRow {
  name: string
  value: number
  lines: number
  items: number
  share: number
  qty: Qty
  children?: BreakRow[]
}

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
  breakdown: { categories: BreakRow[]; departments: BreakRow[] }
  units: Array<{ uom: string; qty: number; value: number; items: number; lines: number }>
  unitFlow: Array<{ uom: string; inQty: number; outQty: number; moves: number }>
  byCategory: Array<{ name: string; value: number; children: Array<{ name: string; value: number }> }>
  ageing: Array<{ key: string; label: string; value: number; lines: number }>
  dead: Array<{ itemId: string; code: string; name: string; store: string; qty: number; uom: string; value: number; days: number | null }>
  abc: {
    top: Array<{ itemId: string; code: string; name: string; value: number; cumPct: number; cls: string }>
    summary: Array<{ cls: string; items: number; value: number }>
    total: number
  }
  reorder: Array<{ itemId: string; code: string; name: string; uom: string; category: string; onHand: number; reorderLevel: number; cover: number }>
  series: Array<{ day: string; inValue: number; outValue: number; moves: number }>
  heat: Array<{ day: string; moves: number }>
  mix: Array<{ type: string; moves: number; value: number }>
  movers: Array<{ itemId: string; code: string; name: string; uom: string; moves: number; inValue: number; outValue: number }>
  requisitions: { pending: number; approved: number; partly: number; issued: number; rejected: number }
  jobWork: Array<{
    id: string
    challanNumber: string
    jobWorker: string
    process: string
    daysOut: number
    overdue: boolean
    gstDaysLeft: number
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
  const allQty: Qty = (data?.units ?? []).map((u) => ({ uom: u.uom, qty: u.qty }))

  // A running net for the stock value tile: in less out, day by day.
  const netRun = (() => {
    let t = 0
    return (data?.series ?? []).map((d) => (t += d.inValue - d.outValue))
  })()

  // A few plain sentences about the figures.
  const highlights: Array<{ icon: React.ElementType; text: React.ReactNode; tone?: string }> = []
  if (data && k) {
    const topCat = data.breakdown.categories[0]
    if (topCat)
      highlights.push({
        icon: Layers,
        text: (
          <>
            <b className="font-semibold">{topCat.name}</b> holds {topCat.share}% of the value ({qtyLine(topCat.qty, 2)})
          </>
        ),
      })
    const a = data.abc.summary.find((c) => c.cls === 'A')
    if (a && data.abc.total)
      highlights.push({
        icon: Target,
        tone: TONE.blue,
        text: (
          <>
            <b className="font-semibold">{a.items}</b> of {data.abc.total} items carry{' '}
            <b className="font-semibold">{Math.round((a.value / (k.stockValue || 1)) * 100)}%</b> of the value
          </>
        ),
      })
    if (k.toReorder)
      highlights.push({ icon: ShoppingCart, tone: TONE.amber, text: <><b className="font-semibold">{k.toReorder}</b> items need reordering</> })
    const busiest = data.heat.reduce((b, d) => (d.moves > b.moves ? d : b), data.heat[0])
    if (busiest?.moves)
      highlights.push({
        icon: CalendarCheck,
        tone: TONE.violet,
        text: (
          <>
            Busiest day{' '}
            <b className="font-semibold">{new Date(`${busiest.day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</b>{' '}
            · {busiest.moves} movements
          </>
        ),
      })
    if (!k.deadLines) highlights.push({ icon: CheckCircle2, tone: TONE.emerald, text: 'Nothing has sat still for 90 days' })
  }

  return (
    <div className="space-y-5">
      {/* Title on the left, the store and the period on the right. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Inventory Dashboard</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Stock as of now{storeName ? ` in ${storeName}` : ' in every store'} · movement over the last{' '}
            {days === 365 ? 'year' : `${days} days`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card pl-3 pr-1 shadow-sm">
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

      {!data || !k ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass-card h-32 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <Highlights items={highlights} />

          {/* ── The figures that matter most, each opening its own screen ── */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <KpiTile
              icon={IndianRupee}
              tone={TONE.teal}
              label="Stock value"
              value={inr(k.stockValue)}
              sub={`${k.items} items · ${k.lines} lines`}
              href="/inventory/stock"
            >
              <Sparkline data={netRun} />
            </KpiTile>
            <KpiTile icon={Ruler} tone={TONE.blue} label="Quantity on hand" value={allQty[0] ? qtyFmt(allQty[0].qty) : '—'} sub={allQty[0] ? `${allQty[0].uom} · plus ${qtyLine(allQty.slice(1), 2)}` : 'nothing in stock'} href="/inventory/stock">
              <SplitBar parts={data.units.map((u, n) => ({ value: u.items, colour: PALETTE[n % PALETTE.length], label: `${u.uom}: ${u.items} items` }))} />
            </KpiTile>
            <KpiTile
              icon={ArrowDownUp}
              tone={TONE.sky}
              label="In · out this period"
              value={inr(k.inValue)}
              sub={
                <>
                  in · <span className="text-rose-500">{inr(k.outValue)}</span> out · {k.moves} moves
                </>
              }
              href="/inventory/ledger?view=dashboard"
            >
              <Sparkline data={data.series.map((d) => d.moves)} colour={TONE.sky} />
            </KpiTile>
            <KpiTile
              icon={AlertTriangle}
              tone={TONE.amber}
              label="To reorder"
              value={String(k.toReorder)}
              valueClass={k.toReorder ? 'text-amber-500' : 'text-foreground'}
              sub="items at or below their level"
              href="/inventory/stock?low=true"
            >
              <SplitBar
                parts={[
                  { value: data.reorder.filter((r) => r.cover < 25).length, colour: TONE.rose, label: 'under 25%' },
                  { value: data.reorder.filter((r) => r.cover >= 25 && r.cover < 75).length, colour: TONE.amber, label: '25–75%' },
                  { value: data.reorder.filter((r) => r.cover >= 75).length, colour: TONE.emerald, label: 'over 75%' },
                ]}
              />
            </KpiTile>
            <KpiTile
              icon={ClipboardList}
              tone={TONE.violet}
              label="Requisitions waiting"
              value={String(k.mrWaiting)}
              sub={`${data.requisitions.pending} to approve · ${data.requisitions.approved + data.requisitions.partly} to issue`}
              href="/inventory/requisitions"
            >
              <SplitBar
                parts={[
                  { value: data.requisitions.pending, colour: TONE.violet, label: 'to approve' },
                  { value: data.requisitions.approved, colour: TONE.blue, label: 'to issue' },
                  { value: data.requisitions.partly, colour: TONE.teal, label: 'part issued' },
                ]}
              />
            </KpiTile>
            <KpiTile
              icon={Hourglass}
              tone={TONE.rose}
              label="Slow stock · 90+ days"
              value={inr(k.deadValue)}
              sub={`${deadShare}% of value · ${k.deadLines} lines`}
              href="/inventory/stock"
            >
              <SplitBar parts={[{ value: k.deadValue, colour: TONE.rose }, { value: Math.max(0, k.stockValue - k.deadValue), colour: 'transparent' }]} />
            </KpiTile>
          </div>

          {/* ── Flow and where the value sits ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard
              className="xl:col-span-2"
              icon={LineChart}
              title="Stock flow"
              hint="Value in and out each day, with the number of movements behind"
              href="/inventory/ledger?view=dashboard"
              hrefLabel="Ledger"
            >
              <FlowChart data={data.series} />
            </DashCard>
            <DashCard icon={PieIcon} title="Value by store" hint="Pick a store to see the dashboard for it alone">
              <StoreDonut data={data.byStore} active={store} onPick={(id) => setStore((s) => (s === id ? '' : id))} />
            </DashCard>
          </div>

          {/* ── Quantity, unit by unit ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard className="xl:col-span-2" icon={Ruler} title="Quantity on hand by unit" hint="Metres with metres, pieces with pieces — with the value behind each">
              <UnitTiles data={data.units} />
            </DashCard>
            <DashCard icon={ArrowLeftRight} title="Quantity moved" hint="In and out in the period, each unit on its own scale">
              <UnitFlow data={data.unitFlow} />
            </DashCard>
          </div>

          {/* ── Category, sub-category and department ── */}
          <DashCard icon={Table2} title="Category, sub-category and department" hint="Items, quantity and value — open a row to see what is inside it">
            <BreakdownTable categories={data.breakdown.categories} departments={data.breakdown.departments} />
          </DashCard>

          {/* ── What the value is, and how old it is ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard className="xl:col-span-2" icon={LayoutGrid} title="Value by sub-category" hint="Each box sized by its value, coloured by its category">
              <CategoryTreemap data={data.byCategory} />
            </DashCard>
            <DashCard icon={CalendarClock} title="Stock ageing" hint="Value by days since each line last moved">
              <AgeingBars data={data.ageing} />
            </DashCard>
          </div>

          {/* ── ABC ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard className="xl:col-span-2" icon={BarChart3} title="ABC analysis" hint="Items by value; the line is the running share, A ends at 80%">
              <ParetoChart data={data.abc.top} />
            </DashCard>
            <DashCard icon={CircleDot} title="A, B and C" hint="Share of items against share of value">
              <div className="space-y-5">
                {data.abc.summary.map((c, n) => {
                  const itemPct = data.abc.total ? Math.round((c.items / data.abc.total) * 100) : 0
                  const valuePct = k.stockValue ? Math.round((c.value / k.stockValue) * 100) : 0
                  const tone = PALETTE[n]
                  return (
                    <div key={c.cls}>
                      <div className="mb-2 flex items-center gap-2 text-sm">
                        <span className="flex h-6 w-6 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ background: tone }}>
                          {c.cls}
                        </span>
                        <span className="text-foreground">
                          {c.items} items · <span className="font-semibold">{inr(c.value)}</span>
                        </span>
                      </div>
                      {[
                        ['items', itemPct, 0.35],
                        ['value', valuePct, 1],
                      ].map(([label, pct, op]) => (
                        <div key={label as string} className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="w-10">{label}</span>
                          <div className="h-1.5 flex-1 rounded-full bg-secondary">
                            <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: tone, opacity: op as number }} />
                          </div>
                          <span className="w-9 text-right tabular-nums text-foreground">{pct}%</span>
                        </div>
                      ))}
                    </div>
                  )
                })}
                <p className="text-xs leading-relaxed text-muted-foreground">Count the A items often; C items can be bought in bulk and checked less.</p>
              </div>
            </DashCard>
          </div>

          {/* ── What needs doing ── */}
          <div className="grid gap-5 lg:grid-cols-3">
            <DashCard icon={AlertTriangle} title="Reorder watch" hint="On hand against the reorder level, lowest first" href="/inventory/stock?low=true" hrefLabel="All">
              {data.reorder.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Nothing needs reordering.</p>
              ) : (
                <div className="space-y-3">
                  {data.reorder.slice(0, 7).map((r) => (
                    <Link key={r.itemId} href={`/inventory/stock/${r.itemId}`} className="block">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate text-foreground hover:text-primary">{r.name}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {qtyFmt(r.onHand)} / {qtyFmt(r.reorderLevel)} {r.uom}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-secondary">
                          <div
                            className="h-1.5 rounded-full"
                            style={{
                              width: `${Math.max(2, Math.min(100, r.cover))}%`,
                              background: r.cover < 25 ? TONE.rose : r.cover < 75 ? TONE.amber : TONE.emerald,
                            }}
                          />
                        </div>
                        <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">{r.cover}%</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </DashCard>
            <DashCard icon={ListOrdered} title="Requisition pipeline" hint="From asking to handing over" href="/inventory/requisitions" hrefLabel="Requisitions">
              <PipelineSteps
                steps={[
                  { label: 'Waiting for approval', value: data.requisitions.pending, colour: TONE.violet },
                  { label: 'Approved, to be issued', value: data.requisitions.approved, colour: TONE.blue },
                  { label: 'Part issued', value: data.requisitions.partly, colour: TONE.sky },
                  { label: 'Issued in the period', value: data.requisitions.issued, colour: TONE.teal },
                ]}
              />
              {data.requisitions.rejected > 0 && (
                <p className="mt-4 text-xs text-muted-foreground">{data.requisitions.rejected} refused in the period</p>
              )}
            </DashCard>
            <DashCard icon={RadarIcon} title="Movement mix" hint="The kinds of movement in the period">
              <MixRadar data={data.mix.map((m) => ({ label: MOVEMENT[m.type] ?? m.type, moves: m.moves }))} />
            </DashCard>
          </div>

          {/* ── Rhythm and who moved most ── */}
          <div className="grid gap-5 xl:grid-cols-3">
            <DashCard className="xl:col-span-2" icon={CalendarClock} title="Store activity" hint="Movements each day over the last twelve weeks">
              <ActivityHeatmap data={data.heat} />
            </DashCard>
            <DashCard icon={TrendingUp} title="Top movers" hint="Most value moved in the period, and how often" href="/inventory/ledger" hrefLabel="Ledger">
              <MoversBars data={data.movers} />
            </DashCard>
          </div>

          {/* ── Out of our hands, and standing still ── */}
          <div className="grid gap-5 lg:grid-cols-3">
            <DashCard icon={Truck} title="At job workers" hint="Open challans, oldest first" href="/inventory/job-work" hrefLabel="Job work">
              {data.jobWork.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Nothing is out at a job worker.</p>
              ) : (
                <div className="space-y-3">
                  {data.jobWork.map((j) => (
                    <div key={j.id}>
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate text-foreground">
                          <span className="font-mono text-[10px] text-primary">{j.challanNumber}</span> {j.jobWorker}
                        </span>
                        <span className={`shrink-0 tabular-nums ${j.overdue ? 'text-rose-500' : 'text-muted-foreground'}`}>
                          {j.daysOut} days{j.overdue ? ' · overdue' : ''}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-secondary">
                          <div
                            className="h-1.5 rounded-full"
                            style={{ width: `${Math.min(100, Math.max(2, (j.daysOut / 365) * 100))}%`, background: j.gstDaysLeft < 60 ? TONE.rose : j.overdue ? TONE.amber : TONE.teal }}
                            title={`${j.gstDaysLeft} days left of the GST year`}
                          />
                        </div>
                        <span className="text-[10px] tabular-nums text-muted-foreground">{inr(j.outValue)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </DashCard>
            <DashCard icon={Hourglass} title="Slowest stock" hint="Not moved for over 90 days, by value" href="/inventory/stock" hrefLabel="Stock">
              {data.dead.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                  <CheckCircle2 size={28} className="text-emerald-500" />
                  <p className="text-sm text-muted-foreground">Everything has moved in the last 90 days.</p>
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {data.dead.map((d) => (
                    <Link key={`${d.itemId}-${d.store}`} href={`/inventory/stock/${d.itemId}`} className="flex items-center justify-between gap-2 py-2 text-xs hover:text-primary">
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
            </DashCard>
            <DashCard icon={Users} title="Customers' material" hint="Held in our stores, not in our value" href="/inventory/customer-material?view=dashboard" hrefLabel="Open">
              {data.customers.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">No customer material in our stores.</p>
              ) : (
                <div className="divide-y divide-border/60">
                  {data.customers.map((c, n) => (
                    <div key={c.name} className="flex items-center gap-2 py-2 text-xs">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: PALETTE[(n + 1) % PALETTE.length] }}>
                        {c.name.slice(0, 1)}
                      </span>
                      <span className="flex-1 truncate text-foreground">{c.name}</span>
                      <span className="text-muted-foreground">{c.lines} {c.lines === 1 ? 'line' : 'lines'}</span>
                    </div>
                  ))}
                </div>
              )}
            </DashCard>
          </div>
        </div>
      )}
    </div>
  )
}
